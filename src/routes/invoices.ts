import type { IncomingMessage, ServerResponse } from 'node:http'
import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, INVOICE_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    cancelInvoice,
    createManualInvoice,
    getInvoiceById,
    listInvoices,
    updateInvoiceStatus,
    type CreateInvoiceInput,
    type InvoiceFilters,
    type InvoiceStatus,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    PaymentUnprocessableError
} from '../modules/payments/index.js'

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
            error: message,
            code,
            details: details ?? [{ message }],
            requestId
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
            throw new PaymentInputError('PAYLOAD_TOO_LARGE', [{ field: 'body', message: 'Payload too large' }])
        }
        chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new PaymentInputError('INVALID_JSON', [{ field: 'body', message: 'The request body must be valid JSON' }])
    }
}

export const handleInvoiceRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (!pathname.startsWith('/invoices')) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    try {
        // ── 17. POST /invoices ──────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.POST && pathname === INVOICE_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'invoices', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const body = (await readJsonBody(request, config.requestBodyLimit)) as CreateInvoiceInput
            const invoice = await createManualInvoice(auth.companyId, auth.id, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: invoice }, headOnly)
            return true
        }

        // ── 15. GET /invoices ───────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === INVOICE_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'invoices', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
            const search = url.searchParams.get('search')?.trim() || undefined
            const status = (url.searchParams.get('status')?.trim() as InvoiceStatus) || undefined
            const projectId = url.searchParams.get('projectId')?.trim() || undefined
            const sortByParam = url.searchParams.get('sortBy')?.trim()
            const sortBy = (['invoiceDate', 'netAmount', 'invoiceNumber'].includes(sortByParam ?? '') ? sortByParam : 'invoiceDate') as InvoiceFilters['sortBy']
            const sortOrder = url.searchParams.get('sortOrder')?.toLowerCase() === 'asc' ? 'asc' : 'desc'
            const dateFrom = url.searchParams.get('dateFrom')?.trim() || undefined
            const dateTo = url.searchParams.get('dateTo')?.trim() || undefined

            const filters: InvoiceFilters = { page, limit, search, status, projectId, sortBy, sortOrder, dateFrom, dateTo }
            const result = await listInvoices(auth.companyId, filters)

            sendJson(
                response,
                HTTP_STATUS.OK,
                {
                    data: result.data,
                    pagination: {
                        page,
                        limit,
                        totalItems: result.total,
                        totalPages: Math.ceil(result.total / limit)
                    }
                },
                headOnly
            )
            return true
        }

        // ── 18. PATCH /invoices/:id/status ──────────────────────────────────────
        const invoiceStatusMatch = /^\/invoices\/([^/]+)\/status$/.exec(pathname)
        if (request.method === HTTP_METHODS.PATCH && invoiceStatusMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'invoices', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const invoiceId = invoiceStatusMatch[1]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as { status: InvoiceStatus }
            const invoice = await updateInvoiceStatus(auth.companyId, auth.role, invoiceId, body.status)
            sendJson(response, HTTP_STATUS.OK, { data: invoice }, headOnly)
            return true
        }

        // ── 16. GET /invoices/:id ───────────────────────────────────────────────
        const singleInvoiceMatch = /^\/invoices\/([^/]+)$/.exec(pathname)
        if (request.method === HTTP_METHODS.GET && singleInvoiceMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'invoices', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const invoiceId = singleInvoiceMatch[1]!
            const invoice = await getInvoiceById(auth.companyId, invoiceId)
            sendJson(response, HTTP_STATUS.OK, { data: invoice }, headOnly)
            return true
        }

        // ── 19. DELETE /invoices/:id ────────────────────────────────────────────
        if (request.method === HTTP_METHODS.DELETE && singleInvoiceMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'invoices', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            const invoiceId = singleInvoiceMatch[1]!
            await cancelInvoice(auth.companyId, auth.role, invoiceId)
            sendJson(response, HTTP_STATUS.OK, { message: 'Invoice cancelled successfully', invoiceId }, headOnly)
            return true
        }

        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    } catch (error) {
        if (error instanceof PaymentInputError) {
            sendError(response, HTTP_STATUS.BAD_REQUEST, 'VALIDATION_ERROR', error.message, requestId, headOnly, error.details)
            return true
        }
        if (error instanceof PaymentNotFoundError) {
            sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof PaymentConflictError) {
            sendError(response, HTTP_STATUS.CONFLICT, 'CONFLICT', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof PaymentForbiddenError) {
            sendError(response, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof PaymentUnprocessableError) {
            sendError(response, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY', error.message, requestId, headOnly)
            return true
        }

        const msg = error instanceof Error ? error.message : String(error)
        const lowerMsg = msg.toLowerCase()
        if (
            lowerMsg.includes('authentication') ||
            lowerMsg.includes('authorization') ||
            lowerMsg.includes('token') ||
            lowerMsg.includes('jwt')
        ) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required', requestId, headOnly)
            return true
        }
        if (lowerMsg.includes('permission') || lowerMsg.includes('forbidden')) {
            sendError(response, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', 'You do not have permission to access this resource', requestId, headOnly)
            return true
        }

        writeLog('error', 'Unhandled error in handleInvoiceRoute', { error: String(error), requestId })
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, String(error))
        return true
    }
}
