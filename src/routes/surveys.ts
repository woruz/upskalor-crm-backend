import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, SURVEY_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES, type RoleName } from '../modules/auth/rbac.js'
import {
    addSurveyPhoto,
    assignSurveyTechnician,
    createSurvey,
    deleteSurvey,
    deleteSurveyPhoto,
    getSurveyById,
    listSurveys,
    listSurveysForLead,
    parsePhotoInput,
    parseSurveyFilters,
    parseSurveyInput,
    SurveyConflictError,
    SurveyForbiddenError,
    SurveyInputError,
    SurveyNotFoundError,
    updateSurvey,
    updateSurveyStatus,
    type SurveyInput,
    type SurveyStatus
} from '../modules/surveys/surveys.js'

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
            throw new Error('PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    if (chunks.length === 0) {
        return {}
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new Error('INVALID_JSON')
    }
}

// ─── Path Parsers ────────────────────────────────────────────────────────────

const getSurveyId = (pathname: string): string | undefined => {
    const match = /^\/surveys\/([^/]+)$/.exec(pathname)
    return match?.[1]
}

const getSurveyStatusId = (pathname: string): string | undefined => {
    const match = /^\/surveys\/([^/]+)\/status$/.exec(pathname)
    return match?.[1]
}

const getSurveyAssignId = (pathname: string): string | undefined => {
    const match = /^\/surveys\/([^/]+)\/assign$/.exec(pathname)
    return match?.[1]
}

const getSurveyPhotosId = (pathname: string): string | undefined => {
    const match = /^\/surveys\/([^/]+)\/photos$/.exec(pathname)
    return match?.[1]
}

const getSurveyPhotoDetailIds = (pathname: string): { surveyId: string; photoId: string } | undefined => {
    const match = /^\/surveys\/([^/]+)\/photos\/([^/]+)$/.exec(pathname)
    if (!match) return undefined
    return {
        surveyId: match[1] as string,
        photoId: match[2] as string
    }
}

const getLeadSurveysId = (pathname: string): string | undefined => {
    const match = /^\/leads\/([^/]+)\/surveys$/.exec(pathname)
    return match?.[1]
}

const isSurveyPath = (pathname: string): boolean =>
    pathname === SURVEY_ROUTES.COLLECTION ||
    getSurveyId(pathname) !== undefined ||
    getSurveyStatusId(pathname) !== undefined ||
    getSurveyAssignId(pathname) !== undefined ||
    getSurveyPhotosId(pathname) !== undefined ||
    getSurveyPhotoDetailIds(pathname) !== undefined ||
    getLeadSurveysId(pathname) !== undefined

// ─── Route Dispatcher ────────────────────────────────────────────────────────

export const handleSurveyRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isSurveyPath(url.pathname)) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    const surveyId = getSurveyId(url.pathname)
    const statusSurveyId = getSurveyStatusId(url.pathname)
    const assignSurveyId = getSurveyAssignId(url.pathname)
    const photosSurveyId = getSurveyPhotosId(url.pathname)
    const photoDetail = getSurveyPhotoDetailIds(url.pathname)
    const leadSurveysId = getLeadSurveysId(url.pathname)

    try {
        // ── 1. GET /leads/:leadId/surveys ─────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && leadSurveysId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const surveys = await listSurveysForLead(auth.companyId, leadSurveysId)
            sendJson(response, HTTP_STATUS.OK, { data: surveys }, headOnly)
            return true
        }

        // ── 2. GET /surveys ───────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && url.pathname === SURVEY_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const filters = parseSurveyFilters(url, auth.role as RoleName, auth.id)
            const result = await listSurveys(auth.companyId, filters)
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

        // ── 3. POST /surveys ──────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.POST && url.pathname === SURVEY_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            const input = parseSurveyInput(body) as SurveyInput
            const { data, warning } = await createSurvey(auth.companyId, auth.id, input)
            const responsePayload: Record<string, unknown> = { data }
            if (warning) {
                responsePayload['warning'] = warning
            }
            sendJson(response, HTTP_STATUS.CREATED, responsePayload, headOnly)
            return true
        }

        // ── 4. PATCH /surveys/:id/status ──────────────────────────────────────
        if (request.method === HTTP_METHODS.PATCH && statusSurveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            if (typeof body !== 'object' || body === null || !('status' in body)) {
                throw new SurveyInputError('status is required in request body', { status: ['status is required'] })
            }
            const status = String((body as Record<string, unknown>)['status']).trim() as SurveyStatus
            const updated = await updateSurveyStatus(auth.companyId, auth.id, auth.role as RoleName, statusSurveyId, status)
            sendJson(response, HTTP_STATUS.OK, { data: updated }, headOnly)
            return true
        }

        // ── 5. PATCH /surveys/:id/assign ──────────────────────────────────────
        if (request.method === HTTP_METHODS.PATCH && assignSurveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            if (typeof body !== 'object' || body === null) {
                throw new SurveyInputError('Request body must be a JSON object')
            }
            const record = body as Record<string, unknown>
            const techId = record['assignedTechId'] !== undefined && record['assignedTechId'] !== null && record['assignedTechId'] !== ''
                ? String(record['assignedTechId']).trim()
                : null
            const techName = typeof record['assignedTech'] === 'string' ? record['assignedTech'].trim() : undefined
            const { data, warning } = await assignSurveyTechnician(auth.companyId, auth.id, assignSurveyId, techId, techName)
            const responsePayload: Record<string, unknown> = { data }
            if (warning) {
                responsePayload['warning'] = warning
            }
            sendJson(response, HTTP_STATUS.OK, responsePayload, headOnly)
            return true
        }

        // ── 6. POST /surveys/:id/photos ───────────────────────────────────────
        if (request.method === HTTP_METHODS.POST && photosSurveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            const photoInput = parsePhotoInput(body)
            const photo = await addSurveyPhoto(auth.companyId, auth.id, photosSurveyId, photoInput)
            sendJson(response, HTTP_STATUS.CREATED, { data: photo }, headOnly)
            return true
        }

        // ── 7. DELETE /surveys/:id/photos/:photoId ────────────────────────────
        if (request.method === HTTP_METHODS.DELETE && photoDetail !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            const result = await deleteSurveyPhoto(auth.companyId, photoDetail.surveyId, photoDetail.photoId)
            sendJson(response, HTTP_STATUS.OK, result, headOnly)
            return true
        }

        // ── 8. GET /surveys/:id ───────────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && surveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const survey = await getSurveyById(auth.companyId, surveyId)
            sendJson(response, HTTP_STATUS.OK, { data: survey }, headOnly)
            return true
        }

        // ── 9. PATCH /surveys/:id ─────────────────────────────────────────────
        if (request.method === HTTP_METHODS.PATCH && surveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const body = await readJsonBody(request, config.requestBodyLimit)
            const input = parseSurveyInput(body, true)
            const { data, warning } = await updateSurvey(auth.companyId, auth.id, surveyId, input)
            const responsePayload: Record<string, unknown> = { data }
            if (warning) {
                responsePayload['warning'] = warning
            }
            sendJson(response, HTTP_STATUS.OK, responsePayload, headOnly)
            return true
        }

        // ── 10. DELETE /surveys/:id ───────────────────────────────────────────
        if (request.method === HTTP_METHODS.DELETE && surveyId !== undefined) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'surveys', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            const result = await deleteSurvey(auth.companyId, surveyId)
            sendJson(response, HTTP_STATUS.OK, result, headOnly)
            return true
        }

        response.setHeader(HTTP_HEADERS.ALLOW, 'GET, HEAD, POST, PATCH, DELETE')
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
            sendError(response, HTTP_STATUS.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'The request body is too large', requestId, headOnly)
            return true
        }
        if (error instanceof Error && error.message === 'INVALID_JSON') {
            sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_JSON', 'The request body must be valid JSON', requestId, headOnly)
            return true
        }
        if (error instanceof SurveyInputError) {
            sendError(
                response,
                HTTP_STATUS.BAD_REQUEST,
                'VALIDATION_ERROR',
                error.message,
                requestId,
                headOnly,
                error.details ?? { error: [error.message] }
            )
            return true
        }
        if (error instanceof SurveyNotFoundError) {
            sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof SurveyConflictError) {
            sendError(response, HTTP_STATUS.CONFLICT, 'CONFLICT', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof SurveyForbiddenError) {
            sendError(response, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof Error && error.message.toLowerCase().includes('authorization')) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required', requestId, headOnly)
            return true
        }
        if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
            sendError(
                response,
                HTTP_STATUS.FORBIDDEN,
                'FORBIDDEN',
                'You do not have permission to access this resource',
                requestId,
                headOnly
            )
            return true
        }

        const errMessage = error instanceof Error ? error.message : String(error)
        writeLog('error', 'Unhandled survey route error', {
            error: errMessage,
            stack: error instanceof Error ? error.stack : undefined,
            requestId
        })
        sendError(
            response,
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'INTERNAL_SERVER_ERROR',
            'An internal server error occurred',
            requestId,
            headOnly,
            errMessage
        )
        return true
    }
}
