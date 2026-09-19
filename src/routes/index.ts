import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { DEFAULT_URL_BASE, HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, MAX_REQUEST_ID_LENGTH } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import type { ErrorResponse } from '../common/types/http.js'
import { handleAdminRoute } from './admin.js'
import { handleAuthRoute } from './auth.js'
import { handleHealthRoute } from './health.js'
import { handleLeadRoute } from './leads.js'
import { handlePermissionRoute } from './permissions.js'
import { handleQuotationRoute } from './quotations.js'
import { handleUserRoute } from './users.js'
import { handleRoleRoute } from './roles.js'
import { handleWebhookRoute } from './webhooks.js'

const getRequestId = (request: IncomingMessage): string => {
    const suppliedRequestId = request.headers[HTTP_HEADERS.REQUEST_ID]

    if (typeof suppliedRequestId === 'string' && suppliedRequestId.length <= MAX_REQUEST_ID_LENGTH && suppliedRequestId.trim() !== '') {
        return suppliedRequestId
    }

    return randomUUID()
}

const setCommonHeaders = (request: IncomingMessage, response: ServerResponse, requestId: string): void => {
    response.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader(HTTP_HEADERS.REQUEST_ID, requestId)

    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
    if (origin !== undefined && origin !== '') {
        response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_ALLOW_CREDENTIALS, 'true')
        response.setHeader('vary', 'Origin')
    } else {
        response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_ALLOW_ORIGIN, '*')
    }

    response.setHeader(
        HTTP_HEADERS.ACCESS_CONTROL_ALLOW_METHODS,
        'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS'
    )

    const requestHeaders = request.headers['access-control-request-headers']
    if (typeof requestHeaders === 'string' && requestHeaders.trim() !== '') {
        response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_ALLOW_HEADERS, requestHeaders)
    } else {
        response.setHeader(
            HTTP_HEADERS.ACCESS_CONTROL_ALLOW_HEADERS,
            'Content-Type, Authorization, X-Request-ID, Accept, Origin'
        )
    }

    response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_EXPOSE_HEADERS, 'Content-Length, X-Request-ID')
    response.setHeader(HTTP_HEADERS.ACCESS_CONTROL_MAX_AGE, '86400')
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
    const body: ErrorResponse = {
        error: {
            code,
            message,
            details: details ?? message,
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
    setCommonHeaders(request, response, requestId)

    if (request.method === HTTP_METHODS.OPTIONS) {
        response.statusCode = HTTP_STATUS.NO_CONTENT
        response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, 0)
        response.end()
        return
    }

    const headOnly = request.method === 'HEAD'
    const pathname = getPathname(request)

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

    if (await handleWebhookRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleHealthRoute(request, response, headOnly)) {
        return
    }

    if ((pathname === '/docs' || pathname === '/api-docs') && (request.method === HTTP_METHODS.GET || request.method === HTTP_METHODS.HEAD)) {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upskalor CRM API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/swagger.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`
        response.statusCode = HTTP_STATUS.OK
        response.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'text/html; charset=utf-8')
        response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(html))
        if (headOnly) {
            response.end()
            return
        }
        response.end(html)
        return
    }

    if (
        (pathname === '/swagger.json' || pathname === '/openapi.json' || pathname === '/openapi.yaml') &&
        (request.method === HTTP_METHODS.GET || request.method === HTTP_METHODS.HEAD)
    ) {
        try {
            const isYaml = pathname === '/openapi.yaml'
            const filePath = new URL(isYaml ? '../../openapi.yaml' : '../../swagger.json', import.meta.url)
            const content = await readFile(filePath, 'utf8')
            response.statusCode = HTTP_STATUS.OK
            response.setHeader(HTTP_HEADERS.CONTENT_TYPE, isYaml ? 'text/yaml; charset=utf-8' : 'application/json; charset=utf-8')
            response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, Buffer.byteLength(content))
            if (headOnly) {
                response.end()
                return
            }
            response.end(content)
            return
        } catch {
            // fall through to standard route handling
        }
    }

    if (await handleLeadRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleQuotationRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleUserRoute(request, response, config, requestId, headOnly)) {
        return
    }

    if (await handleRoleRoute(request, response, config, requestId, headOnly)) {
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
