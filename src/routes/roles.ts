import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, ROLE_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { authorizeRequest } from '../middleware/auth.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    createRole,
    deleteRole,
    getRoleById,
    listRoles,
    updateRole,
    RoleConflictError,
    RoleInputError,
    RoleNotFoundError,
    type CreateRoleInput,
    type UpdateRoleInput
} from '../modules/roles/roles.js'

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

const readJsonBody = async (request: IncomingMessage, bodyLimit: number): Promise<unknown> => {
    const chunks: Buffer[] = []
    let receivedLength = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        receivedLength += buffer.length
        if (receivedLength > bodyLimit) {
            throw new RoleInputError('The request body is too large', 'PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new RoleInputError('The request body must be valid JSON', 'INVALID_JSON')
    }
}

const getRoleId = (pathname: string): string | undefined => {
    const match = /^\/roles\/([^/]+)$/.exec(pathname)
    return match?.[1]
}

const isRolePath = (pathname: string): boolean =>
    pathname === ROLE_ROUTES.COLLECTION || getRoleId(pathname) !== undefined

export const handleRoleRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isRolePath(url.pathname)) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    const roleId = getRoleId(url.pathname)

    try {
        // Super admin authorization is required for all role management endpoints
        const auth = await authorizeRequest(request, config.jwtSecret, [ROLE_NAMES.SUPER_ADMIN])

        // GET /roles
        if (request.method === HTTP_METHODS.GET && url.pathname === ROLE_ROUTES.COLLECTION) {
            const roles = await listRoles(auth.companyId)
            sendJson(response, HTTP_STATUS.OK, { data: roles }, headOnly)
            return true
        }

        // GET /roles/:id
        if (request.method === HTTP_METHODS.GET && roleId !== undefined) {
            const role = await getRoleById(auth.companyId, roleId)
            sendJson(response, HTTP_STATUS.OK, { data: role }, headOnly)
            return true
        }

        // POST /roles
        if (request.method === HTTP_METHODS.POST && url.pathname === ROLE_ROUTES.COLLECTION) {
            const body = (await readJsonBody(request, config.requestBodyLimit)) as CreateRoleInput
            const role = await createRole(auth.companyId, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: role }, headOnly)
            return true
        }

        // PATCH /roles/:id
        if (request.method === HTTP_METHODS.PATCH && roleId !== undefined) {
            const body = (await readJsonBody(request, config.requestBodyLimit)) as UpdateRoleInput
            const role = await updateRole(auth.companyId, roleId, body)
            sendJson(response, HTTP_STATUS.OK, { data: role }, headOnly)
            return true
        }

        // DELETE /roles/:id
        if (request.method === HTTP_METHODS.DELETE && roleId !== undefined) {
            await deleteRole(auth.companyId, roleId)
            sendJson(response, HTTP_STATUS.OK, { message: 'Role deleted successfully' }, headOnly)
            return true
        }

        response.setHeader(HTTP_HEADERS.ALLOW, 'GET, HEAD, POST, PATCH, DELETE')
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return true
    } catch (error) {
        if (error instanceof Error && error.message.includes('Authorization')) {
            sendError(response, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof Error && (error.message.includes('not authorized') || error.message.includes('Forbidden'))) {
            sendError(response, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof RoleInputError) {
            const status = error.code === 'PAYLOAD_TOO_LARGE' ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST
            sendError(response, status, error.code, error.message, requestId, headOnly)
            return true
        }
        if (error instanceof RoleNotFoundError) {
            sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof RoleConflictError) {
            sendError(response, HTTP_STATUS.CONFLICT, 'CONFLICT', error.message, requestId, headOnly)
            return true
        }

        const message = error instanceof Error ? error.message : 'An internal server error occurred'
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, message)
        return true
    }
}
