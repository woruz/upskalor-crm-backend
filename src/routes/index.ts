import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { DEFAULT_URL_BASE, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, MAX_REQUEST_ID_LENGTH } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import type { ErrorResponse } from '../common/types/http.js'
import { handleAdminRoute } from './admin.js'
import { handleAuthRoute } from './auth.js'
import { handleHealthRoute } from './health.js'
import { handleLeadRoute } from './leads.js'
import { handlePermissionRoute } from './permissions.js'

const getRequestId = (request: IncomingMessage): string => {
    const suppliedRequestId = request.headers[HTTP_HEADERS.REQUEST_ID]

    if (typeof suppliedRequestId === 'string' && suppliedRequestId.length <= MAX_REQUEST_ID_LENGTH && suppliedRequestId.trim() !== '') {
        return suppliedRequestId
    }

    return randomUUID()
}

const setCommonHeaders = (response: ServerResponse, requestId: string): void => {
    response.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader(HTTP_HEADERS.REQUEST_ID, requestId)
}

const sendError = (response: ServerResponse, statusCode: number, code: string, message: string, requestId: string, headOnly = false): void => {
    const body: ErrorResponse = {
        error: {
            code,
            message,
            requestId
        }
    }

    const payload = JSON.stringify(body)
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(payload))

    if (headOnly) {
        response.end()
        return
    }

    response.end(payload)
}

const getPathname = (request: IncomingMessage): string | undefined => {
    try {
        return new URL(request.url ?? '/', DEFAULT_URL_BASE).pathname
    } catch {
        return undefined
    }
}

export const handleRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestIdOverride?: string
): Promise<void> => {
    const requestId = requestIdOverride ?? getRequestId(request)
    const headOnly = request.method === 'HEAD'
    const pathname = getPathname(request)

    setCommonHeaders(response, requestId)

    if (pathname === undefined) {
        request.resume()
        sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_REQUEST', 'The request URL is invalid', requestId, headOnly)
        return
    }

    const contentLengthHeader = request.headers[HTTP_HEADERS.CONTENT_LENGTH]
    const contentLength = contentLengthHeader === undefined ? 0 : Number(contentLengthHeader)

    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        request.resume()
        sendError(response, HTTP_STATUS.BAD_REQUEST, 'INVALID_CONTENT_LENGTH', 'The Content-Length header is invalid', requestId, headOnly)
        return
    }

    if (contentLength > config.requestBodyLimit) {
        request.resume()
        sendError(response, HTTP_STATUS.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', 'The request body is too large', requestId, headOnly)
        return
    }

    if (await handleAuthRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handlePermissionRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleAdminRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleHealthRoute(request, response, headOnly)) {
        return
    }

    if (await handleLeadRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (request.method !== HTTP_METHODS.GET && request.method !== HTTP_METHODS.HEAD && request.method !== HTTP_METHODS.POST) {
        request.resume()
        response.setHeader(HTTP_HEADERS.ALLOW, `${HTTP_METHODS.GET}, ${HTTP_METHODS.HEAD}, ${HTTP_METHODS.POST}`)
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'The requested method is not supported', requestId, headOnly)
        return
    }

    request.resume()
    sendError(response, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND', 'The requested resource was not found', requestId, headOnly)
}
