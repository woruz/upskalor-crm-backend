import type { IncomingMessage, ServerResponse } from 'node:http'
import { HTTP_HEADERS, HTTP_METHODS, HTTP_STATUS, PAYMENT_ROUTES } from '../common/constants/http.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { requireCompanyPermission } from '../middleware/permissions.js'
import { ROLE_NAMES } from '../modules/auth/rbac.js'
import {
    checkOverdueMilestones,
    generateReceiptPdfBuffer,
    getPaymentDashboardKpis,
    getReceiptById,
    listOutstandingPayments,
    listPaymentMilestones,
    listReceipts,
    shareReceiptWhatsApp,
    voidReceipt,
    type MilestoneFilters,
    type MilestoneStatus,
    type OutstandingFilters,
    type PaymentMode,
    type PaymentReceiptStatus,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    PaymentUnprocessableError,
    type ReceiptFilters
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

export const handlePaymentRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    config: AppConfig,
    requestId: string,
    headOnly: boolean
): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (!pathname.startsWith('/payments')) {
        return false
    }

    if (headOnly) {
        request.method = HTTP_METHODS.GET
    }

    try {
        // ── 20. GET /payments/dashboard ─────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === `${PAYMENT_ROUTES.COLLECTION}/dashboard`) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const month = url.searchParams.get('month') ? Number(url.searchParams.get('month')) : undefined
            const year = url.searchParams.get('year') ? Number(url.searchParams.get('year')) : undefined
            const data = await getPaymentDashboardKpis(auth.companyId, month, year)
            sendJson(response, HTTP_STATUS.OK, { data }, headOnly)
            return true
        }

        // ── 13. GET /payments/outstanding ───────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === `${PAYMENT_ROUTES.COLLECTION}/outstanding`) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
            const search = url.searchParams.get('search')?.trim() || undefined
            const sortByParam = url.searchParams.get('sortBy')?.trim()
            const sortBy = (['balance', 'totalDue', 'projectName'].includes(sortByParam ?? '') ? sortByParam : 'balance') as OutstandingFilters['sortBy']
            const sortOrder = url.searchParams.get('sortOrder')?.toLowerCase() === 'asc' ? 'asc' : 'desc'

            const filters: OutstandingFilters = { page, limit, search, sortBy, sortOrder }
            const result = await listOutstandingPayments(auth.companyId, filters)

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

        // ── 14. GET /payments/milestones ────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === `${PAYMENT_ROUTES.COLLECTION}/milestones`) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
            const search = url.searchParams.get('search')?.trim() || undefined
            const status = (url.searchParams.get('status')?.trim() as MilestoneStatus) || undefined
            const projectId = url.searchParams.get('projectId')?.trim() || undefined
            const sortByParam = url.searchParams.get('sortBy')?.trim()
            const sortBy = (['dueDate', 'amountDue', 'projectName'].includes(sortByParam ?? '') ? sortByParam : 'dueDate') as MilestoneFilters['sortBy']
            const sortOrder = url.searchParams.get('sortOrder')?.toLowerCase() === 'desc' ? 'desc' : 'asc'

            const filters: MilestoneFilters = { page, limit, search, status, projectId, sortBy, sortOrder }
            const result = await listPaymentMilestones(auth.companyId, filters)

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

        // ── 23. POST /payments/check-overdue ────────────────────────────────────
        if (request.method === HTTP_METHODS.POST && pathname === `${PAYMENT_ROUTES.COLLECTION}/check-overdue`) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'update' },
                [ROLE_NAMES.ADMIN, ROLE_NAMES.SUPER_ADMIN]
            )
            const result = await checkOverdueMilestones(auth.companyId)
            sendJson(response, HTTP_STATUS.OK, { data: result }, headOnly)
            return true
        }

        // ── 10. GET /payments/receipts ──────────────────────────────────────────
        if (request.method === HTTP_METHODS.GET && pathname === `${PAYMENT_ROUTES.COLLECTION}/receipts`) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
            const search = url.searchParams.get('search')?.trim() || undefined
            const status = (url.searchParams.get('status')?.trim() as PaymentReceiptStatus) || undefined
            const mode = (url.searchParams.get('mode')?.trim() as PaymentMode) || undefined
            const projectId = url.searchParams.get('projectId')?.trim() || undefined
            const sortByParam = url.searchParams.get('sortBy')?.trim()
            const sortBy = (['paymentDate', 'amount'].includes(sortByParam ?? '') ? sortByParam : 'paymentDate') as ReceiptFilters['sortBy']
            const sortOrder = url.searchParams.get('sortOrder')?.toLowerCase() === 'asc' ? 'asc' : 'desc'
            const dateFrom = url.searchParams.get('dateFrom')?.trim() || undefined
            const dateTo = url.searchParams.get('dateTo')?.trim() || undefined

            const filters: ReceiptFilters = { page, limit, search, status, mode, projectId, sortBy, sortOrder, dateFrom, dateTo }
            const result = await listReceipts(auth.companyId, filters)

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

        // ── 22. GET /payments/receipts/:id/pdf ──────────────────────────────────
        const receiptPdfMatch = /^\/payments\/receipts\/([^/]+)\/pdf$/.exec(pathname)
        if (request.method === HTTP_METHODS.GET && receiptPdfMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const receiptId = receiptPdfMatch[1]!
            const pdfBuffer = await generateReceiptPdfBuffer(auth.companyId, receiptId)

            response.statusCode = HTTP_STATUS.OK
            response.setHeader(HTTP_HEADERS.CONTENT_TYPE, 'application/pdf')
            response.setHeader(HTTP_HEADERS.CONTENT_LENGTH, pdfBuffer.length)
            response.setHeader('content-disposition', `attachment; filename="Receipt-${receiptId.slice(0, 8).toUpperCase()}.pdf"`)

            if (headOnly) {
                response.end()
            } else {
                response.end(pdfBuffer)
            }
            return true
        }

        // ── 21. POST /payments/receipts/:id/share ───────────────────────────────
        const receiptShareMatch = /^\/payments\/receipts\/([^/]+)\/share$/.exec(pathname)
        if (request.method === HTTP_METHODS.POST && receiptShareMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const receiptId = receiptShareMatch[1]!
            const result = await shareReceiptWhatsApp(auth.companyId, receiptId)
            sendJson(response, HTTP_STATUS.OK, { data: result }, headOnly)
            return true
        }

        // ── 12. PATCH /payments/receipts/:id/void ───────────────────────────────
        const receiptVoidMatch = /^\/payments\/receipts\/([^/]+)\/void$/.exec(pathname)
        if (request.method === HTTP_METHODS.PATCH && receiptVoidMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'delete' },
                [ROLE_NAMES.ADMIN, ROLE_NAMES.SUPER_ADMIN]
            )
            const receiptId = receiptVoidMatch[1]!
            const body = (await readJsonBody(request, config.requestBodyLimit)) as { reason?: string }
            const result = await voidReceipt(auth.companyId, auth.role, auth.id, receiptId, body.reason ?? '')
            sendJson(response, HTTP_STATUS.OK, { data: result }, headOnly)
            return true
        }

        // ── 11. GET /payments/receipts/:id ──────────────────────────────────────
        const singleReceiptMatch = /^\/payments\/receipts\/([^/]+)$/.exec(pathname)
        if (request.method === HTTP_METHODS.GET && singleReceiptMatch) {
            const auth = await requireCompanyPermission(
                request,
                config.jwtSecret,
                { resourceName: 'payments', actionName: 'read' },
                Object.values(ROLE_NAMES)
            )
            const receiptId = singleReceiptMatch[1]!
            const receipt = await getReceiptById(auth.companyId, receiptId)
            sendJson(response, HTTP_STATUS.OK, { data: receipt }, headOnly)
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

        writeLog('error', 'Unhandled error in handlePaymentRoute', { error: String(error), requestId })
        sendError(response, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR', 'An internal server error occurred', requestId, headOnly, String(error))
        return true
    }
}
