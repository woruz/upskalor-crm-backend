import type { IncomingMessage, ServerResponse } from 'node:http'

import { ADMIN_ROUTES, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'

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

const sendError = (
    response: ServerResponse,
    statusCode: number,
    code: string,
    message: string,
    requestId: string,
    headOnly = false,
    details?: unknown
): void => {
    const payload = JSON.stringify({
        error: {
            code,
            message,
            details: details ?? message,
            requestId
        }
    })
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(payload))

    if (headOnly) {
        response.end()
        return
    }

    response.end(payload)
}

export const handleAdminRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname !== ADMIN_ROUTES.USERS) {
        return false
    }

    if (request.method !== HTTP_METHODS.GET && request.method !== HTTP_METHODS.POST) {
        response.setHeader(HTTP_HEADERS.ALLOW, `${HTTP_METHODS.GET}, ${HTTP_METHODS.POST}`)
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    }

    try {
        const authContext = await requireCompanyPermission(request, config.jwtSecret, { resourceName: 'users', actionName: 'read' }, [
            ROLE_NAMES.SUPER_ADMIN,
            ROLE_NAMES.ADMIN
        ])

        sendJson(
            response,
            HTTP_STATUS.OK,
            {
                message: 'Admin access granted',
                user: {
                    id: authContext.id,
                    role: authContext.role,
                    companyId: authContext.companyId,
                    companySlug: authContext.companySlug,
                    email: authContext.email
                }
            },
            headOnly
        )
        return true
    } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes('authorization')) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', 'Authentication required', requestId, headOnly)
            return true
        }

        sendError(response, HTTP_STATUS.UNAUTHORIZED, 'FORBIDDEN', 'You do not have permission to access this resource', requestId, headOnly)
        return true
    }
}

