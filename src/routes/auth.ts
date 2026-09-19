import type { IncomingMessage, ServerResponse } from 'node:http'

import { AUTH_ROUTES, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import {
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    LoginInputError,
    loginUser,
    parseLoginRequest,
    parseRefreshTokenRequest,
    refreshUserSession,
    revokeRefreshToken
} from '../modules/auth/login.js'
import { parseRegistrationRequest, RegistrationInputError, registerCompanyWithOwner } from '../modules/auth/registration.js'

const isUniqueViolation = (error: unknown): boolean => {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
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

const writeLog = (level: 'info' | 'error' | 'warn', message: string, metadata: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...metadata })}\n`)
}

export const handleAuthRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    if (request.method === HTTP_METHODS.POST && request.url !== undefined) {
        const url = new URL(request.url, 'http://localhost')

        if (url.pathname === AUTH_ROUTES.REFRESH) {
            try {
                const body = await readJsonBody(request, config.requestBodyLimit)
                const refreshRequest = parseRefreshTokenRequest(body)
                const refreshed = await refreshUserSession(
                    refreshRequest.refreshToken,
                    config.jwtSecret,
                    config.accessTokenExpiresIn,
                    config.refreshTokenExpiresIn
                )
                sendJson(response, HTTP_STATUS.OK, refreshed, headOnly)
                return true
            } catch (error) {
                if (error instanceof InvalidRefreshTokenError) {
                    sendError(
                        response,
                        HTTP_STATUS.UNAUTHORIZED,
                        'INVALID_REFRESH_TOKEN',
                        'The refresh token is invalid or expired',
                        requestId,
                        headOnly
                    )
                    return true
                }

                if (
                    error instanceof LoginInputError ||
                    (error instanceof Error && (error.message === 'INVALID_JSON' || error.message === 'PAYLOAD_TOO_LARGE'))
                ) {
                    const isTooLarge = error.message === 'PAYLOAD_TOO_LARGE'
                    sendError(
                        response,
                        isTooLarge ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST,
                        error.message,
                        error.message,
                        requestId,
                        headOnly
                    )
                    return true
                }

                const errDetails = error instanceof Error ? error.message : String(error)
                writeLog('error', 'Token refresh failed', { error: errDetails, requestId })
                sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'REFRESH_FAILED', 'Token refresh failed', requestId, headOnly, errDetails)
                return true
            }
        }

        if (url.pathname === AUTH_ROUTES.LOGOUT) {
            try {
                const body = await readJsonBody(request, config.requestBodyLimit)
                await revokeRefreshToken(parseRefreshTokenRequest(body).refreshToken)
                sendJson(response, HTTP_STATUS.OK, { message: 'Logged out successfully' }, headOnly)
                return true
            } catch (error) {
                if (
                    error instanceof LoginInputError ||
                    (error instanceof Error && (error.message === 'INVALID_JSON' || error.message === 'PAYLOAD_TOO_LARGE'))
                ) {
                    const isTooLarge = error.message === 'PAYLOAD_TOO_LARGE'
                    sendError(
                        response,
                        isTooLarge ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST,
                        error.message,
                        error.message,
                        requestId,
                        headOnly
                    )
                    return true
                }

                const errDetails = error instanceof Error ? error.message : String(error)
                writeLog('error', 'Logout failed', { error: errDetails, requestId })
                sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'LOGOUT_FAILED', 'Logout failed', requestId, headOnly, errDetails)
                return true
            }
        }

        if (url.pathname === AUTH_ROUTES.REGISTER) {
            try {
                const body = await readJsonBody(request, config.requestBodyLimit)
                const registration = await registerCompanyWithOwner(parseRegistrationRequest(body))
                sendJson(response, HTTP_STATUS.CREATED, registration, headOnly)
                return true
            } catch (error) {
                if (
                    error instanceof RegistrationInputError ||
                    (error instanceof Error && (error.message === 'INVALID_JSON' || error.message === 'PAYLOAD_TOO_LARGE'))
                ) {
                    const isTooLarge = error.message === 'PAYLOAD_TOO_LARGE'
                    sendError(
                        response,
                        isTooLarge ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST,
                        error.message,
                        error.message,
                        requestId,
                        headOnly
                    )
                    return true
                }

                if (isUniqueViolation(error)) {
                    sendError(
                        response,
                        HTTP_STATUS.CONFLICT,
                        'REGISTRATION_CONFLICT',
                        'The company slug or owner email is already registered',
                        requestId,
                        headOnly
                    )
                    return true
                }

                const errDetails = error instanceof Error ? error.message : String(error)
                writeLog('error', 'Company registration failed', { error: errDetails, requestId })
                sendError(response, 500, 'REGISTRATION_FAILED', 'Company registration failed', requestId, headOnly, errDetails)
                return true
            }
        }

        if (url.pathname === AUTH_ROUTES.LOGIN) {
            try {
                const body = await readJsonBody(request, config.requestBodyLimit)
                const login = await loginUser(parseLoginRequest(body), config.jwtSecret, config.accessTokenExpiresIn, config.refreshTokenExpiresIn)
                sendJson(response, HTTP_STATUS.OK, login, headOnly)
                return true
            } catch (error) {
                if (
                    error instanceof LoginInputError ||
                    (error instanceof Error && (error.message === 'INVALID_JSON' || error.message === 'PAYLOAD_TOO_LARGE'))
                ) {
                    const isTooLarge = error.message === 'PAYLOAD_TOO_LARGE'
                    sendError(
                        response,
                        isTooLarge ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST,
                        error.message,
                        error.message,
                        requestId,
                        headOnly
                    )
                    return true
                }

                if (error instanceof InvalidCredentialsError) {
                    sendError(response, HTTP_STATUS.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid email, password, or company', requestId, headOnly)
                    return true
                }

                const errDetails = error instanceof Error ? error.message : String(error)
                writeLog('error', 'User login failed', { error: errDetails, requestId })
                sendError(response, 500, 'LOGIN_FAILED', 'User login failed', requestId, headOnly, errDetails)
                return true
            }
        }
    }

    return false
}

