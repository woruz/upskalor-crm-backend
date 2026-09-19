import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, USER_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { authorizeRequest } from '../middleware/auth.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    createUser,
    deleteUser,
    getUserById,
    listUsers,
    updateUser,
    UserConflictError,
    UserInputError,
    UserNotFoundError,
    type CreateUserInput,
    type UpdateUserInput,
    type UserListFilters
} from '../modules/users/users.js'

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
            throw new UserInputError('The request body is too large', 'PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new UserInputError('The request body must be valid JSON', 'INVALID_JSON')
    }
}

const getUserId = (pathname: string): string | undefined => {
    const match = /^\/users\/([^/]+)$/.exec(pathname)
    return match?.[1]
}

const isUserPath = (pathname: string): boolean =>
    pathname === USER_ROUTES.COLLECTION || getUserId(pathname) !== undefined

export const handleUserRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isUserPath(url.pathname)) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    const userId = getUserId(url.pathname)

    try {
        // Super admin authorization is required for all user management endpoints
        const auth = await authorizeRequest(request, config.jwtSecret, [ROLE_NAMES.SUPER_ADMIN])

        // GET /users
        if (request.method === HTTP_METHODS.GET && url.pathname === USER_ROUTES.COLLECTION) {
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
            const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20))
            const search = url.searchParams.get('search') || undefined
            const role = url.searchParams.get('role') || undefined
            const status = url.searchParams.get('status') || undefined

            const filters: UserListFilters = {
                page,
                limit,
                ...(search !== undefined ? { search } : {}),
                ...(role !== undefined ? { role } : {}),
                ...(status !== undefined ? { status } : {})
            }
            const result = await listUsers(auth.companyId, filters)

            sendJson(response, HTTP_STATUS.OK, result, headOnly)
            return true
        }

        // GET /users/:id
        if (request.method === HTTP_METHODS.GET && userId !== undefined) {
            const user = await getUserById(auth.companyId, userId)
            sendJson(response, HTTP_STATUS.OK, { data: user }, headOnly)
            return true
        }

        // POST /users
        if (request.method === HTTP_METHODS.POST && url.pathname === USER_ROUTES.COLLECTION) {
            const body = (await readJsonBody(request, config.requestBodyLimit)) as CreateUserInput
            const user = await createUser(auth.companyId, body)
            sendJson(response, HTTP_STATUS.CREATED, { data: user }, headOnly)
            return true
        }

        // PATCH /users/:id
        if (request.method === HTTP_METHODS.PATCH && userId !== undefined) {
            const body = (await readJsonBody(request, config.requestBodyLimit)) as UpdateUserInput
            const user = await updateUser(auth.companyId, userId, body)
            sendJson(response, HTTP_STATUS.OK, { data: user }, headOnly)
            return true
        }

        // DELETE /users/:id
        if (request.method === HTTP_METHODS.DELETE && userId !== undefined) {
            await deleteUser(auth.companyId, userId, auth.id)
            sendJson(response, HTTP_STATUS.OK, { message: 'User removed successfully' }, headOnly)
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
        if (error instanceof UserInputError) {
            const status = error.code === 'PAYLOAD_TOO_LARGE' ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST
            sendError(response, status, error.code, error.message, requestId, headOnly)
            return true
        }
        if (error instanceof UserNotFoundError) {
            sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', error.message, requestId, headOnly)
            return true
        }
        if (error instanceof UserConflictError) {
            sendError(response, HTTP_STATUS.CONFLICT, 'CONFLICT', error.message, requestId, headOnly)
            return true
        }

        const message = error instanceof Error ? error.message : 'An internal server error occurred'
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, message)
        return true
    }
}
