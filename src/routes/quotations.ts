import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, QUOTATION_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    createQuotation,
    deleteQuotation,
    getQuotation,
    listQuotations,
    parseQuotationFilters,
    parseQuotationInput,
    QuotationInputError,
    QuotationNotFoundError,
    QuotationReferenceError,
    updateQuotation,
    type QuotationInput
} from '../modules/quotations/quotations.js'

const sendJson = (response: ServerResponse, statusCode: number, body: unknown, headOnly: boolean): void => {
    const payload = JSON.stringify(body)
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(payload))
    if (headOnly) {
        response.end()
    } else {
        response.end(payload)
    }
}

const sendError = (
    response: ServerResponse,
    statusCode: number,
    code: string,
    message: string,
    requestId: string,
    headOnly: boolean,
    details?: unknown
): void => {
    sendJson(
        response,
        statusCode,
        {
            error: {
                code,
                message,
                details: details ?? message,
                requestId
            }
        },
        headOnly
    )
}

const writeLog = (level: 'info' | 'error' | 'warn', message: string, metadata: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...metadata })}\n`)
}

const readJsonBody = async (request: IncomingMessage, bodyLimit: number): Promise<unknown> => {
    const chunks: Buffer[] = []
    let receivedLength = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        receivedLength += buffer.length
        if (receivedLength > bodyLimit) {
            throw new QuotationInputError('PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new QuotationInputError('INVALID_JSON')
    }
}

const getQuotationId = (pathname: string): string | undefined => {
    const match = /^\/quotations\/([^/]+)$/.exec(pathname)
    return match?.[1]
}

const isQuotationPath = (pathname: string): boolean =>
    pathname === QUOTATION_ROUTES.COLLECTION || getQuotationId(pathname) !== undefined

export const handleQuotationRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isQuotationPath(url.pathname)) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }
    const quotationId = getQuotationId(url.pathname)

    try {
        if (request.method === HTTP_METHODS.GET && url.pathname === QUOTATION_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'quotations', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const filters = parseQuotationFilters(url)
            const result = await listQuotations(auth.companyId, filters)
            sendJson(
                response,
                HTTP_STATUS.OK,
                {
                    data: result.data,
                    pagination: {
                        page: filters.page,
                        limit: filters.limit,
                        total: result.total,
                        totalPages: Math.ceil(result.total / filters.limit)
                    }
                },
                headOnly
            )
            return true
        }

        if (request.method === HTTP_METHODS.GET && quotationId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'quotations', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            sendJson(response, HTTP_STATUS.OK, { data: await getQuotation(auth.companyId, quotationId) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.POST && url.pathname === QUOTATION_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'quotations', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            const input = parseQuotationInput(body) as QuotationInput
            sendJson(response, HTTP_STATUS.CREATED, { data: await createQuotation(auth.companyId, auth.id, input) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.PATCH && quotationId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'quotations', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            const input = parseQuotationInput(body, true)
            sendJson(response, HTTP_STATUS.OK, { data: await updateQuotation(auth.companyId, auth.id, quotationId, input) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.DELETE && quotationId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'quotations', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            await deleteQuotation(auth.companyId, auth.id, quotationId)
            sendJson(response, HTTP_STATUS.OK, { message: 'Quotation deleted' }, headOnly)
            return true
        }

        response.setHeader(HTTP_HEADERS.ALLOW, 'GET, HEAD, POST, PATCH, DELETE')
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
            return (
                sendError(response, HTTP_STATUS.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'The request body is too large', requestId, headOnly),
                true
            )
        }
        if (error instanceof Error && error.message === 'INVALID_JSON') {
            return (
                sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_JSON', 'The request body must be valid JSON', requestId, headOnly),
                true
            )
        }
        if (error instanceof QuotationNotFoundError) {
            return (sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly), true)
        }
        if (error instanceof QuotationReferenceError) {
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_REFERENCE', error.message, requestId, headOnly), true)
        }
        if (error instanceof QuotationInputError) {
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_QUOTATION_PAYLOAD', error.message, requestId, headOnly), true)
        }
        if (error instanceof Error && error.message.toLowerCase().includes('authorization')) {
            return (sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required', requestId, headOnly), true)
        }
        if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
            return (
                sendError(response, HTTP_STATUS.UNAUTHORIZED, 'FORBIDDEN', 'You do not have permission to access this resource', requestId, headOnly),
                true
            )
        }
        const errMessage = error instanceof Error ? error.message : String(error)
        writeLog('error', 'Unhandled quotation route error', {
            error: errMessage,
            stack: error instanceof Error ? error.stack : undefined,
            requestId
        })
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, errMessage)
        return true
    }
}
