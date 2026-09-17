import type { IncomingMessage, ServerResponse } from 'node:http'

import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS } from '../common/constants/http.constants.js'
import { createStorageClient } from '../common/utils/storage.js'
import type { AppConfig } from '../common/types/config.js'
import { handleS3UploadHook, TransferInputError } from '../modules/leads/lead-transfers.js'

const sendJson = (response: ServerResponse, statusCode: number, body: unknown, headOnly: boolean): void => {
    const payload = JSON.stringify(body)
    response.statusCode = statusCode
    response.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/json; charset=utf-8')
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
            throw new Error('PAYLOAD_TOO_LARGE')
        }
        chunks.push(buffer)
    }
    try {
        const raw = Buffer.concat(chunks).toString('utf8')
        return raw.trim() === '' ? {} : JSON.parse(raw)
    } catch {
        throw new Error('INVALID_JSON')
    }
}

const isWebhookPath = (pathname: string): boolean =>
    pathname === '/webhooks/s3' || pathname === '/leads/import/webhook'

export const handleWebhookRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!isWebhookPath(url.pathname)) {
        return false
    }

    if (request.method !== HTTP_METHODS.POST) {
        sendError(response, HTTP_STATUS.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', 'Method not allowed', requestId, headOnly)
        return true
    }

    try {
        const body = await readJsonBody(request, config.requestBodyLimit)
        const storageClient = createStorageClient(config.storage)
        const result = await handleS3UploadHook(storageClient, config.storage, body)
        sendJson(response, HTTP_STATUS.ACCEPTED, { data: result }, headOnly)
        return true
    } catch (error) {
        if (error instanceof TransferInputError) {
            sendError(response, HTTP_STATUS.BAD_REQUEST, 'BAD_REQUEST', error.message, requestId, headOnly)
            return true
        }
        sendError(
            response,
            HTTP_STATUS.INTERNAL_SERVER_ERROR,
            'WEBHOOK_ERROR',
            error instanceof Error ? error.message : 'Internal webhook error',
            requestId,
            headOnly
        )
        return true
    }
}
