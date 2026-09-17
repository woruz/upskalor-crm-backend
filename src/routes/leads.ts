import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, LEAD_ROUTES } from '../common/constants/http.constants.js'
import { createStorageClient } from '../common/utils/storage.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    assignLead,
    createLead,
    deleteLead,
    getLead,
    LeadInputError,
    LeadNotFoundError,
    LeadReferenceError,
    listActivities,
    listLeads,
    parseLeadFilters,
    parseLeadInput,
    updateLead,
    updateLeadStatus,
    type LeadInput
} from '../modules/leads/leads.js'
import {
    confirmImport,
    createExport,
    getExportDownloadUrl,
    getExportStatus,
    getImportErrorReportUrl,
    getImportStatus,
    requestImportUpload,
    TransferInputError,
    TransferNotFoundError,
    TransferOwnershipError
} from '../modules/leads/lead-transfers.js'

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

const sendError = (response: ServerResponse, statusCode: number, code: string, message: string, requestId: string, headOnly: boolean): void => {
    sendJson(response, statusCode, { error: { code, message, requestId } }, headOnly)
}

const readJsonBody = async (request: IncomingMessage, bodyLimit: number): Promise<unknown> => {
    const chunks: Buffer[] = []
    let receivedLength = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        receivedLength += buffer.length
        if (receivedLength > bodyLimit) {
            throw new LeadInputError('PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new LeadInputError('INVALID_JSON')
    }
}

const getLeadId = (pathname: string): string | undefined => {
    const match = /^\/leads\/([^/]+)$/.exec(pathname)
    return match?.[1]
}

const getActivityLeadId = (pathname: string): string | undefined => {
    const match = /^\/leads\/([^/]+)\/activities$/.exec(pathname)
    return match?.[1]
}

const getActionLeadId = (pathname: string): string | undefined => {
    const match = /^\/leads\/([^/]+)\/(?:status|assign)$/.exec(pathname)
    return match?.[1]
}

const isTransferPath = (pathname: string): boolean =>
    pathname === '/leads/import' ||
    pathname === '/leads/import/upload-url' ||
    pathname === '/leads/export' ||
    /^\/leads\/(?:import|export)\/[^/]+(?:\/error-report|\/download)?$/.test(pathname)

const isLeadPath = (pathname: string): boolean =>
    pathname === LEAD_ROUTES.COLLECTION ||
    isTransferPath(pathname) ||
    getLeadId(pathname) !== undefined ||
    getActivityLeadId(pathname) !== undefined ||
    getActionLeadId(pathname) !== undefined

export const handleLeadRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isLeadPath(url.pathname)) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }
    const leadId = getLeadId(url.pathname) ?? getActionLeadId(url.pathname)
    const activityLeadId = getActivityLeadId(url.pathname)

    try {
        const storageClient = createStorageClient(config.storage)
        if (url.pathname === '/leads/import/upload-url' && request.method === HTTP_METHODS.POST) {
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'create' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.OK, await requestImportUpload(storageClient, config.storage, auth.companyId, auth.id, await readJsonBody(request, config.requestBodyLimit)), headOnly)
            return true
        }

        if (url.pathname === '/leads/import' && request.method === HTTP_METHODS.POST) {
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'create' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.ACCEPTED, { data: await confirmImport(storageClient, config.storage, auth.companyId, auth.id, await readJsonBody(request, config.requestBodyLimit)) }, headOnly)
            return true
        }

        const importStatusMatch = /^\/leads\/import\/([^/]+)$/.exec(url.pathname)
        if (importStatusMatch !== null && request.method === HTTP_METHODS.GET) {
            const importId = importStatusMatch[1]
            if (importId === undefined) {
                throw new TransferInputError('importId is invalid')
            }
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'read' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.OK, { data: await getImportStatus(auth.companyId, auth.id, importId) }, headOnly)
            return true
        }

        const importErrorMatch = /^\/leads\/import\/([^/]+)\/error-report$/.exec(url.pathname)
        if (importErrorMatch !== null && request.method === HTTP_METHODS.GET) {
            const importId = importErrorMatch[1]
            if (importId === undefined) {
                throw new TransferInputError('importId is invalid')
            }
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'read' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.OK, { data: await getImportErrorReportUrl(storageClient, config.storage, auth.companyId, auth.id, importId) }, headOnly)
            return true
        }

        if (url.pathname === '/leads/export' && request.method === HTTP_METHODS.POST) {
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'read' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.ACCEPTED, { data: await createExport(storageClient, config.storage, auth.companyId, auth.id, await readJsonBody(request, config.requestBodyLimit)) }, headOnly)
            return true
        }

        const exportStatusMatch = /^\/leads\/export\/([^/]+)$/.exec(url.pathname)
        if (exportStatusMatch !== null && request.method === HTTP_METHODS.GET) {
            const exportId = exportStatusMatch[1]
            if (exportId === undefined) {
                throw new TransferInputError('exportId is invalid')
            }
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'read' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.OK, { data: await getExportStatus(auth.companyId, auth.id, exportId) }, headOnly)
            return true
        }

        const exportDownloadMatch = /^\/leads\/export\/([^/]+)\/download$/.exec(url.pathname)
        if (exportDownloadMatch !== null && request.method === HTTP_METHODS.GET) {
            const exportId = exportDownloadMatch[1]
            if (exportId === undefined) {
                throw new TransferInputError('exportId is invalid')
            }
            const auth = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'leads', actionName: 'read' }, Object.values(ROLE_NAMES))
            sendJson(response, HTTP_STATUS.OK, { data: await getExportDownloadUrl(storageClient, config.storage, auth.companyId, auth.id, exportId) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.GET && url.pathname === LEAD_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const filters = parseLeadFilters(url)
            const result = await listLeads(auth.companyId, filters)
            sendJson(
                response,
                HTTP_STATUS.OK,
                {
                    data: result.data,
                    pagination: { page: filters.page, limit: filters.limit, total: result.total, totalPages: Math.ceil(result.total / filters.limit) }
                },
                headOnly
            )
            return true
        }

        if (request.method === HTTP_METHODS.GET && activityLeadId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Number(url.searchParams.get('page') ?? 1)
            const limit = Number(url.searchParams.get('limit') ?? 20)
            if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                throw new LeadInputError('pagination is invalid')
            }
            const result = await listActivities(auth.companyId, activityLeadId, page, limit)
            sendJson(
                response,
                HTTP_STATUS.OK,
                { data: result.data, pagination: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) } },
                headOnly
            )
            return true
        }

        if (request.method === HTTP_METHODS.GET && leadId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            sendJson(response, HTTP_STATUS.OK, { data: await getLead(auth.companyId, leadId) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.POST && url.pathname === LEAD_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const input = parseLeadInput(await readJsonBody(request, config.requestBodyLimit)) as LeadInput
            sendJson(response, HTTP_STATUS.CREATED, { data: await createLead(auth.companyId, auth.id, input) }, headOnly)
            return true
        }

        if (request.method === HTTP_METHODS.PATCH && leadId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            if (url.pathname.endsWith('/status')) {
                const statusPayload = parseLeadInput(body, true)
                if (statusPayload.status === undefined) {
                    throw new LeadInputError('status is required')
                }
                sendJson(response, HTTP_STATUS.OK, { data: await updateLeadStatus(auth.companyId, auth.id, leadId, statusPayload.status) }, headOnly)
                return true
            }
            if (url.pathname.endsWith('/assign')) {
                const assignment = parseLeadInput(body, true)
                sendJson(
                    response,
                    HTTP_STATUS.OK,
                    { data: await assignLead(auth.companyId, auth.id, leadId, assignment.assignedExecutive) },
                    headOnly
                )
                return true
            }
            sendJson(response, HTTP_STATUS.OK, { data: await updateLead(auth.companyId, auth.id, leadId, parseLeadInput(body, true)) }, headOnly)
            return true
        }

        if (request.method === 'DELETE' && leadId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'leads', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            await deleteLead(auth.companyId, auth.id, leadId)
            sendJson(response, HTTP_STATUS.OK, { message: 'Lead deleted' }, headOnly)
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
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_JSON', 'The request body must be valid JSON', requestId, headOnly), true)
        }
        if (error instanceof LeadNotFoundError) {
            return (sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly), true)
        }
        if (error instanceof LeadReferenceError) {
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_REFERENCE', error.message, requestId, headOnly), true)
        }
        if (error instanceof LeadInputError) {
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_LEAD_PAYLOAD', error.message, requestId, headOnly), true)
        }
        if (error instanceof TransferNotFoundError) {
            return (sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly), true)
        }
        if (error instanceof TransferOwnershipError) {
            return (sendError(response, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', error.message, requestId, headOnly), true)
        }
        if (error instanceof TransferInputError) {
            return (sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_TRANSFER_PAYLOAD', error.message, requestId, headOnly), true)
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
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly)
        return true
    }
}
