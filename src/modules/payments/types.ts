export const PAYMENT_MODES = [
    'UPI',
    'Net Banking',
    'Cheque',
    'Cash',
    'Credit/Debit Card'
] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

export const PAYMENT_RECEIPT_STATUSES = [
    'Successful',
    'Pending',
    'Failed'
] as const
export type PaymentReceiptStatus = (typeof PAYMENT_RECEIPT_STATUSES)[number]

export const MILESTONE_STATUSES = [
    'Pending',
    'Partially Received',
    'Received',
    'Overdue'
] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const INVOICE_STATUSES = [
    'Paid',
    'Unpaid',
    'Overdue',
    'Cancelled'
] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const PROJECT_STATUSES = [
    'ACTIVE',
    'COMPLETED',
    'CANCELLED',
    'ON_HOLD'
] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export class PaymentInputError extends Error {
    readonly details?: Record<string, string[]> | Array<{ field: string; message: string }> | undefined
    constructor(message: string, details?: Record<string, string[]> | Array<{ field: string; message: string }> | undefined) {
        super(message)
        this.name = 'PaymentInputError'
        this.details = details
    }
}

export class PaymentNotFoundError extends Error {
    constructor(message = 'Resource not found') {
        super(message)
        this.name = 'PaymentNotFoundError'
    }
}

export class PaymentConflictError extends Error {
    constructor(message = 'Resource conflict') {
        super(message)
        this.name = 'PaymentConflictError'
    }
}

export class PaymentForbiddenError extends Error {
    constructor(message = 'Forbidden') {
        super(message)
        this.name = 'PaymentForbiddenError'
    }
}

export class PaymentUnprocessableError extends Error {
    constructor(message = 'Unprocessable entity') {
        super(message)
        this.name = 'PaymentUnprocessableError'
    }
}

export interface CreateProjectInput {
    quotationId: string
    projectName?: string | undefined
    milestoneDueDates?: {
        advance?: string | undefined
        delivery?: string | undefined
        commissioning?: string | undefined
    } | undefined
}

export interface ProjectFilters {
    page: number
    limit: number
    search?: string | undefined
    status?: ProjectStatus | undefined
    sortBy: 'createdAt' | 'projectName' | 'grandTotal'
    sortOrder: 'asc' | 'desc'
}

export interface UpdateProjectInput {
    projectName?: string | undefined
    status?: ProjectStatus | undefined
    customerPhone?: string | undefined
}

export interface AddMilestoneInput {
    milestoneName: string
    amountDue: number
    dueDate?: string | undefined
    percentage?: number | null | undefined
}

export interface UpdateMilestoneInput {
    milestoneName?: string | undefined
    amountDue?: number | undefined
    dueDate?: string | undefined
}

export interface RecordPaymentInput {
    milestoneId: string
    amount: number
    mode: PaymentMode
    referenceNumber?: string | undefined
    paymentDate?: string | undefined
    notes?: string | undefined
    autoGenerateInvoice?: boolean | undefined
}

export interface ReceiptFilters {
    page: number
    limit: number
    search?: string | undefined
    status?: PaymentReceiptStatus | undefined
    mode?: PaymentMode | undefined
    projectId?: string | undefined
    sortBy: 'paymentDate' | 'amount'
    sortOrder: 'asc' | 'desc'
    dateFrom?: string | undefined
    dateTo?: string | undefined
}

export interface MilestoneFilters {
    page: number
    limit: number
    search?: string | undefined
    status?: MilestoneStatus | undefined
    projectId?: string | undefined
    sortBy: 'dueDate' | 'amountDue' | 'projectName'
    sortOrder: 'asc' | 'desc'
}

export interface OutstandingFilters {
    page: number
    limit: number
    search?: string | undefined
    sortBy: 'balance' | 'totalDue' | 'projectName'
    sortOrder: 'asc' | 'desc'
}

export interface CreateInvoiceInput {
    projectId: string
    grossAmount: number
    gstPercentage?: number | undefined
    dueDate?: string | undefined
    notes?: string | undefined
}

export interface InvoiceFilters {
    page: number
    limit: number
    search?: string | undefined
    status?: InvoiceStatus | undefined
    projectId?: string | undefined
    sortBy: 'invoiceDate' | 'netAmount' | 'invoiceNumber'
    sortOrder: 'asc' | 'desc'
    dateFrom?: string | undefined
    dateTo?: string | undefined
}
