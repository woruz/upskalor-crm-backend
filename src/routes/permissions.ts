import type { IncomingMessage, ServerResponse } from 'node:http'

import { ADMIN_ROUTES, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { assignUserRole, upsertRolePermission } from '../database/tenants.js'
import { normalizePermissionAssignment, normalizeRoleAssignment } from '../modules/auth/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import { requireCompanyPermission } from '../middleware/permissions.js'

const sendJson = (response: ServerResponse, statusCode: number, body: unknown, headOnly = false): void => {
    const payload = JSON.stringify(body)
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(payload))

    if (headOnly) {
        response.end()
        return
    }

    response.end(payload)
}

const sendError = (response: ServerResponse, statusCode: number, code: string, message: string, requestId: string, headOnly = false): void => {
    const payload = JSON.stringify({ error: { code, message, requestId } })
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(payload))

    if (headOnly) {
        response.end()
        return
    }

    response.end(payload)
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

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new Error('INVALID_JSON')
    }
}

export const handlePermissionRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname !== ADMIN_ROUTES.PERMISSIONS && url.pathname !== ADMIN_ROUTES.ROLE_ASSIGNMENTS) {
        return false
    }

    if (request.method !== HTTP_METHODS.POST) {
        response.setHeader(HTTP_HEADERS.ALLOW, HTTP_METHODS.POST)
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    }

    try {
        const authContext = await requireCompanyPermission(
            request,
            config.jwtSecret,
            {
                resourceName: url.pathname === ADMIN_ROUTES.PERMISSIONS ? 'users' : 'roles',
                actionName: 'update'
            },
            [ROLE_NAMES.SUPER_ADMIN, ROLE_NAMES.ADMIN]
        )

        const body = await readJsonBody(request, config.requestBodyLimit)

        if (url.pathname === ADMIN_ROUTES.PERMISSIONS) {
            const assignment = normalizePermissionAssignment(body)
            const persisted = await upsertRolePermission(authContext.companyId, assignment)
            sendJson(
                response,
                HTTP_STATUS.OK,
                {
                    message: 'Permission assignment accepted',
                    user: {
                        id: authContext.id,
                        role: authContext.role,
                        companyId: authContext.companyId,
                        companySlug: authContext.companySlug,
                        email: authContext.email
                    },
                    permission: persisted
                },
                headOnly
            )
            return true
        }

        const assignment = normalizeRoleAssignment(body)
        const persisted = await assignUserRole(authContext.companyId, assignment)
        sendJson(
            response,
            HTTP_STATUS.OK,
            {
                message: 'Role assignment accepted',
                user: {
                    id: authContext.id,
                    role: authContext.role,
                    companyId: authContext.companyId,
                    companySlug: authContext.companySlug,
                    email: authContext.email
                },
                roleAssignment: persisted
            },
            headOnly
        )
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

        if (error instanceof Error && error.message.toLowerCase().includes('authorization')) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required', requestId, headOnly)
            return true
        }

        if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'FORBIDDEN', 'You do not have permission to access this resource', requestId, headOnly)
            return true
        }

        sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_PERMISSION_PAYLOAD', 'The permission payload is invalid', requestId, headOnly)
        return true
    }
}

