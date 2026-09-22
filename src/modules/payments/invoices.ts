import { sql, type SQL } from 'drizzle-orm'
import { database } from '../../database/client.js'
import { ensureCompanyPaymentTables } from '../../database/tenants.js'
import { ROLE_NAMES } from '../auth/rbac.js'
import { LEAD_ACTIVITY_TYPES } from '../leads/leads.js'
import {
    type CreateInvoiceInput,
    type InvoiceFilters,
    type InvoiceStatus,
    INVOICE_STATUSES,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError
} from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const roundToTwo = (num: number): number => Math.round((num + Number.EPSILON) * 100) / 100

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new PaymentInputError(`${field} must be a valid UUID`, [{ field, message: `${field} must be a valid UUID` }])
    }
    return value
}

const invoiceTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".invoices`)
const projectTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".projects`)
const receiptTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".payment_receipts`)
const seqTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".invoice_sequences`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

interface InvoiceRow {
    id: string
    project_id: string
    receipt_id: string | null
    invoice_number: string
    invoice_date: Date | string
    gross_amount: string | number
    gst_percentage: string | number
    gst_amount: string | number
    net_amount: string | number
    status: InvoiceStatus
    due_date: Date | string | null
    notes: string | null
    created_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
    project_name?: string | null
    customer_name?: string | null
    creator_name?: string | null
    receipt_amount?: string | number | null
}

interface InvoiceRowWithCount extends InvoiceRow {
    _total_count: string | number
}

export const getNextInvoiceNumber = async (
    tx: Pick<typeof database, 'execute'>,
    schemaName: string,
    date: Date = new Date()
): Promise<string> => {
    const year = date.getUTCFullYear()
    const table = seqTable(schemaName)

    const { rows } = await tx.execute(sql`
        insert into ${table} (year, last_number)
        values (${year}, 1)
        on conflict (year) do update
        set last_number = ${table}.last_number + 1
        returning last_number
    `)

    const typedRows = rows as unknown as Array<{ last_number: string | number }>
    const nextNumber = Number(typedRows[0]?.last_number ?? 1)
    return `INV-${year}-${String(nextNumber).padStart(4, '0')}`
}

export const toInvoiceResponse = (row: InvoiceRow): Record<string, unknown> => {
    const resp: Record<string, unknown> = {
        id: row.id,
        invoiceNumber: row.invoice_number,
        invoiceDate: new Date(row.invoice_date).toISOString(),
        date: new Date(row.invoice_date).toISOString(),
        grossAmount: Number(row.gross_amount),
        gstPercentage: Number(row.gst_percentage),
        gstAmount: Number(row.gst_amount),
        netAmount: Number(row.net_amount),
        status: row.status,
        dueDate: row.due_date ? new Date(row.due_date).toISOString() : null,
        notes: row.notes,
        projectId: row.project_id,
        receiptId: row.receipt_id,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (row.project_name !== undefined) {
        resp['projectName'] = row.project_name
        resp['customerName'] = row.customer_name ?? null
    }

    if (row.project_id) {
        resp['project'] = {
            id: row.project_id,
            projectName: row.project_name ?? undefined
        }
    }

    if (row.receipt_id) {
        resp['receipt'] = {
            id: row.receipt_id,
            amount: row.receipt_amount !== undefined && row.receipt_amount !== null ? Number(row.receipt_amount) : undefined
        }
    }

    if (row.created_by) {
        resp['createdBy'] = {
            id: row.created_by,
            name: row.creator_name ?? 'User'
        }
    }

    return resp
}

export const createManualInvoice = async (
    companyId: string,
    userId: string,
    input: CreateInvoiceInput
): Promise<Record<string, unknown>> => {
    parseUuid(input.projectId, 'projectId')

    if (!input.grossAmount || input.grossAmount <= 0) {
        throw new PaymentInputError('grossAmount must be greater than zero', [
            { field: 'grossAmount', message: 'grossAmount must be greater than zero' }
        ])
    }

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const iTable = invoiceTable(schemaName)
    const aTable = activityTable(schemaName)

    // Check project exists
    const { rows: projRows } = await database.execute(sql`
        select id, lead_id, project_name from ${pTable} where id = ${input.projectId} and deleted_at is null
    `)
    const project = projRows[0] as unknown as { id: string; lead_id: string | null; project_name: string } | undefined
    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    const grossAmount = roundToTwo(input.grossAmount)
    const gstPercentage = roundToTwo(input.gstPercentage ?? 18)
    if (gstPercentage < 0 || gstPercentage > 100) {
        throw new PaymentInputError('gstPercentage must be between 0 and 100', [
            { field: 'gstPercentage', message: 'gstPercentage must be between 0 and 100' }
        ])
    }
    const gstAmount = roundToTwo((grossAmount * gstPercentage) / 100)
    const netAmount = roundToTwo(grossAmount + gstAmount)

    const dueDate = input.dueDate ? new Date(input.dueDate) : null
    const invoiceNumber = await getNextInvoiceNumber(database, schemaName)

    const { rows } = await database.execute(sql`
        insert into ${iTable}
        (project_id, receipt_id, invoice_number, invoice_date, gross_amount, gst_percentage, gst_amount, net_amount, status, due_date, notes, created_by)
        values
        (${input.projectId}, null, ${invoiceNumber}, now(), ${grossAmount}, ${gstPercentage}, ${gstAmount}, ${netAmount}, 'Unpaid', ${dueDate}, ${input.notes ?? null}, ${userId})
        returning *
    `)

    const invoice = rows[0] as unknown as InvoiceRow

    if (project.lead_id) {
        await database.execute(sql`
            insert into ${aTable} (lead_id, activity_type, description, performed_by)
            values (${project.lead_id}, ${LEAD_ACTIVITY_TYPES.INVOICE_GENERATED}, ${`Invoice ${invoiceNumber} generated for ₹${netAmount}`}, ${userId})
        `)
    }

    return toInvoiceResponse(invoice)
}

export const listInvoices = async (
    companyId: string,
    filters: InvoiceFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const iTable = invoiceTable(schemaName)
    const pTable = projectTable(schemaName)

    const conditions: SQL[] = [sql`i.deleted_at is null`]

    if (filters.search) {
        const searchPattern = `%${filters.search}%`
        conditions.push(sql`(i.invoice_number ilike ${searchPattern} or p.project_name ilike ${searchPattern} or p.customer_name ilike ${searchPattern})`)
    }

    if (filters.status) {
        conditions.push(sql`i.status = ${filters.status}`)
    }

    if (filters.projectId) {
        parseUuid(filters.projectId, 'projectId')
        conditions.push(sql`i.project_id = ${filters.projectId}`)
    }

    if (filters.dateFrom) {
        conditions.push(sql`i.invoice_date >= ${filters.dateFrom}`)
    }

    if (filters.dateTo) {
        conditions.push(sql`i.invoice_date <= ${filters.dateTo}`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        invoiceDate: 'i.invoice_date',
        netAmount: 'i.net_amount',
        invoiceNumber: 'i.invoice_number'
    } as const
    const orderCol = sortColumns[filters.sortBy] ?? 'i.invoice_date'
    const orderDirection = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const offset = (filters.page - 1) * filters.limit

    const { rows } = await database.execute(sql`
        with filtered as (
            select i.*,
                   p.project_name,
                   p.customer_name,
                   count(*) over() as _total_count
            from ${iTable} i
            left join ${pTable} p on p.id = i.project_id
            where ${where}
        )
        select * from filtered
        order by ${sql.raw(`${orderCol.replace('i.', '')} ${orderDirection}`)}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as InvoiceRowWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return {
        data: typedRows.map((r) => toInvoiceResponse(r)),
        total
    }
}

export const getInvoiceById = async (
    companyId: string,
    invoiceId: string
): Promise<Record<string, unknown>> => {
    parseUuid(invoiceId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const iTable = invoiceTable(schemaName)
    const pTable = projectTable(schemaName)
    const rTable = receiptTable(schemaName)

    const { rows } = await database.execute(sql`
        select i.*,
               p.project_name,
               p.customer_name,
               concat(u.first_name, ' ', u.last_name) as creator_name,
               r.amount as receipt_amount
        from ${iTable} i
        left join ${pTable} p on p.id = i.project_id
        left join ${rTable} r on r.id = i.receipt_id
        left join root.users u on u.id = i.created_by
        where i.id = ${invoiceId} and i.deleted_at is null
        limit 1
    `)

    const invoice = rows[0] as unknown as InvoiceRow | undefined
    if (!invoice) {
        throw new PaymentNotFoundError('Invoice not found')
    }

    return toInvoiceResponse(invoice)
}

export const updateInvoiceStatus = async (
    companyId: string,
    userRole: string,
    invoiceId: string,
    newStatus: InvoiceStatus
): Promise<Record<string, unknown>> => {
    parseUuid(invoiceId, 'id')
    if (!INVOICE_STATUSES.includes(newStatus)) {
        throw new PaymentInputError(`Invalid status: ${newStatus}`, [{ field: 'status', message: `status must be one of: ${INVOICE_STATUSES.join(', ')}` }])
    }

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const iTable = invoiceTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${iTable} where id = ${invoiceId} and deleted_at is null limit 1
    `)
    const invoice = rows[0] as unknown as InvoiceRow | undefined
    if (!invoice) {
        throw new PaymentNotFoundError('Invoice not found')
    }

    const currentStatus = invoice.status
    if (currentStatus === 'Cancelled') {
        throw new PaymentInputError('Cancelled invoice cannot change status')
    }

    // Status transition rules:
    // Unpaid -> Paid, Overdue, Cancelled
    // Overdue -> Paid, Cancelled
    // Paid -> Cancelled (Admin only)
    if (currentStatus === 'Unpaid' && !['Paid', 'Overdue', 'Cancelled'].includes(newStatus)) {
        throw new PaymentInputError(`Invalid transition from ${currentStatus} to ${newStatus}`)
    }
    if (currentStatus === 'Overdue' && !['Paid', 'Cancelled'].includes(newStatus)) {
        throw new PaymentInputError(`Invalid transition from ${currentStatus} to ${newStatus}`)
    }
    if (currentStatus === 'Paid') {
        if (newStatus !== 'Cancelled') {
            throw new PaymentInputError(`Invalid transition from Paid to ${newStatus}`)
        }
        if (userRole !== ROLE_NAMES.ADMIN && userRole !== ROLE_NAMES.SUPER_ADMIN) {
            throw new PaymentForbiddenError('Only administrators can cancel a Paid invoice')
        }
    }

    const { rows: updatedRows } = await database.execute(sql`
        update ${iTable}
        set status = ${newStatus}, updated_at = now()
        where id = ${invoiceId}
        returning *
    `)

    return toInvoiceResponse(updatedRows[0] as unknown as InvoiceRow)
}

export const cancelInvoice = async (
    companyId: string,
    userRole: string,
    invoiceId: string
): Promise<void> => {
    parseUuid(invoiceId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const iTable = invoiceTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${iTable} where id = ${invoiceId} and deleted_at is null limit 1
    `)
    const invoice = rows[0] as unknown as InvoiceRow | undefined
    if (!invoice) {
        throw new PaymentNotFoundError('Invoice not found')
    }

    if (invoice.status === 'Paid' && userRole !== ROLE_NAMES.ADMIN && userRole !== ROLE_NAMES.SUPER_ADMIN) {
        throw new PaymentForbiddenError('Only administrators can cancel a Paid invoice')
    }

    await database.execute(sql`
        update ${iTable}
        set deleted_at = now(), status = 'Cancelled', updated_at = now()
        where id = ${invoiceId}
    `)
}
