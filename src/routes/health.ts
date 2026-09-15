import type { IncomingMessage, ServerResponse } from 'node:http'

import { HEALTH_ROUTES, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS } from '../common/constants/http.constants.js'

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

export const handleHealthRoute = async (request: IncomingMessage, response: ServerResponse, headOnly: boolean): Promise<boolean> => {
    if (request.method !== HTTP_METHODS.GET && request.method !== HTTP_METHODS.HEAD) {
        return false
    }

    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname === HEALTH_ROUTES.LIVE) {
        sendJson(response, HTTP_STATUS.OK, { status: 'ok' }, headOnly)
        return true
    }

    if (url.pathname === HEALTH_ROUTES.READY) {
        sendJson(response, HTTP_STATUS.OK, { status: 'ok', checks: { application: 'up' } }, headOnly)
        return true
    }

    return false
}

