import type { IncomingMessage, ServerResponse } from 'node:http'
import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, PROJECT_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    addProjectMilestone,
    createProjectFromQuotation,
    deleteProject,
    deleteProjectMilestone,
    getProjectById,
    listProjects,
    recordPayment,
    updateProject,
    updateProjectMilestone,
    type AddMilestoneInput,
    type CreateProjectInput,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    PaymentUnprocessableError,
    type ProjectFilters,
    type ProjectStatus,
    type RecordPaymentInput,
    type UpdateMilestoneInput,
    type UpdateProjectInput
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

export const handleProjectRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (!pathname.startsWith('/projects')) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    try {
        // ── 1. POST /projects ──────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.POST && pathname === PROJECT_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const body = (await readJsonBody(request, config.requestBodyLimit)) as CreateProjectInput
            const project = await createProjectFromQuotation(auth.companyId, auth.id, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: project }, headOnly)
            return true
        }

        // ── 2. GET /projects ───────────────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === PROJECT_ROUTES.COLLECTION) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
            const search = url.searchParams.get('search')?.trim() || undefined
            const status = (url.searchParams.get('status')?.trim() as ProjectStatus) || undefined
            const sortByParam = url.searchParams.get('sortBy')?.trim()
            const sortBy = (['createdAt', 'projectName', 'grandTotal'].includes(sortByParam ?? '') ? sortByParam : 'createdAt') as ProjectFilters['sortBy']
            const sortOrder = url.searchParams.get('sortOrder')?.toLowerCase() === 'asc' ? 'asc' : 'desc'

            const filters: ProjectFilters = { page, limit, search, status, sortBy, sortOrder }
            const result = await listProjects(auth.companyId, filters)

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

        // ── 6. POST /projects/:projectId/milestones ─────────────────────────────
        const addMilestoneMatch = /^\/projects\/([^/]+)\/milestones$/.exec(pathname)
        if (request.method === HTTP_METHODS.POST && addMilestoneMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const projectId = addMilestoneMatch[1]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as AddMilestoneInput
            const milestone = await addProjectMilestone(auth.companyId, projectId, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: milestone }, headOnly)
            return true
        }

        // ── 7. PATCH /projects/:projectId/milestones/:milestoneId ───────────────
        const updateMilestoneMatch = /^\/projects\/([^/]+)\/milestones\/([^/]+)$/.exec(pathname)
        if (request.method === HTTP_METHODS.PATCH && updateMilestoneMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const projectId = updateMilestoneMatch[1]!
            const milestoneId = updateMilestoneMatch[2]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as UpdateMilestoneInput
            const milestone = await updateProjectMilestone(auth.companyId, projectId, milestoneId, body)
            sendJson(response, HTTP_STATUS.OK, { data: milestone }, headOnly)
            return true
        }

        // ── 8. DELETE /projects/:projectId/milestones/:milestoneId ──────────────
        const deleteMilestoneMatch = /^\/projects\/([^/]+)\/milestones\/([^/]+)$/.exec(pathname)
        if (request.method === HTTP_METHODS.DELETE && deleteMilestoneMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'delete' },
                Object.values(ROLE_NAMES)
            )
            const projectId = deleteMilestoneMatch[1]!
            const milestoneId = deleteMilestoneMatch[2]!
            const res = await deleteProjectMilestone(auth.companyId, projectId, milestoneId)
            sendJson(response, HTTP_STATUS.OK, res, headOnly)
            return true
        }

        // ── 9. POST /projects/:projectId/payments ──────────────────────────────
        const paymentMatch = /^\/projects\/([^/]+)\/payments$/.exec(pathname)
        if (request.method === HTTP_METHODS.POST && paymentMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'create' },
                Object.values(ROLE_NAMES)
            )
            const projectId = paymentMatch[1]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as RecordPaymentInput
            const result = await recordPayment(auth.companyId, auth.id, projectId, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: result }, headOnly)
            return true
        }

        // ── 3. GET /projects/:id ───────────────────────────────────────────────
        const singleProjectMatch = /^\/projects\/([^/]+)$/.exec(pathname)
        if (request.method === HTTP_METHODS.GET && singleProjectMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const projectId = singleProjectMatch[1]!
            const project = await getProjectById(auth.companyId, projectId)
            sendJson(response, HTTP_STATUS.OK, { data: project }, headOnly)
            return true
        }

        // ── 4. PATCH /projects/:id ─────────────────────────────────────────────
        if (request.method === HTTP_METHODS.PATCH && singleProjectMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'update' },
                Object.values(ROLE_NAMES)
            )
            const projectId = singleProjectMatch[1]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as UpdateProjectInput
            const project = await updateProject(auth.companyId, auth.role, projectId, body)
            sendJson(response, HTTP_STATUS.OK, { data: project }, headOnly)
            return true
        }

        // ── 5. DELETE /projects/:id ────────────────────────────────────────────
        if (request.method === HTTP_METHODS.DELETE && singleProjectMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'delete' },
                [ROLE_NAMES.ADMIN, ROLE_NAMES.SUPER_ADMIN]
            )
            const projectId = singleProjectMatch[1]!
            const res = await deleteProject(auth.companyId, auth.role, projectId)
            sendJson(response, HTTP_STATUS.OK, res, headOnly)
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

        writeLog('error', 'Unhandled error in handleProjectRoute', { error: String(error), requestId })
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, String(error))
        return true
    }
}
