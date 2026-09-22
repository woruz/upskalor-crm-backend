import PDFDocument from 'pdfkit'
import { sql, type SQL } from 'drizzle-orm'
import { database } from '../../database/client.js'
import { ensureCompanyPaymentTables } from '../../database/tenants.js'
import { ROLE_NAMES } from '../auth/rbac.js'
import { LEAD_ACTIVITY_TYPES } from '../leads/leads.js'
import { getNextInvoiceNumber, roundToTwo, toInvoiceResponse } from './invoices.js'
import {
    type MilestoneStatus,
    PAYMENT_MODES,
    type PaymentMode,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    type ReceiptFilters,
    type RecordPaymentInput
} from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new PaymentInputError(`${field} must be a valid UUID`, [{ field, message: `${field} must be a valid UUID` }])
    }
    return value
}

const receiptTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".payment_receipts`)
const milestoneTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".payment_milestones`)
const projectTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".projects`)
const invoiceTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".invoices`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

interface ReceiptRow {
    id: string
    project_id: string
    milestone_id: string | null
    amount: string | number
    mode: PaymentMode
    reference_number: string | null
    payment_date: Date | string
    status: string
    notes: string | null
    recorded_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
    project_name?: string | null
    customer_name?: string | null
    customer_phone?: string | null
    milestone_name?: string | null
    recorder_name?: string | null
    invoice_id?: string | null
    invoice_number?: string | null
}

interface ReceiptRowWithCount extends ReceiptRow {
    _total_count: string | number
}

export const toReceiptDetailResponse = (row: ReceiptRow): Record<string, unknown> => {
    const res: Record<string, unknown> = {
        id: row.id,
        amount: Number(row.amount),
        mode: row.mode,
        referenceNumber: row.reference_number,
        paymentDate: new Date(row.payment_date).toISOString(),
        status: row.status,
        notes: row.notes,
        projectId: row.project_id,
        milestoneId: row.milestone_id,
        recordedBy: {
            id: row.recorded_by,
            name: row.recorder_name ?? 'User'
        },
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (row.project_id) {
        res['project'] = {
            id: row.project_id,
            projectName: row.project_name ?? undefined,
            customerName: row.customer_name ?? undefined
        }
    }

    if (row.milestone_id) {
        res['milestone'] = {
            id: row.milestone_id,
            milestoneName: row.milestone_name ?? undefined
        }
    }

    if (row.invoice_number) {
        res['invoice'] = {
            id: row.invoice_id ?? undefined,
            invoiceNumber: row.invoice_number
        }
    }

    return res
}

export const recordPayment = async (
    companyId: string,
    userId: string,
    projectId: string,
    input: RecordPaymentInput
): Promise<{
    receipt: Record<string, unknown>
    milestone: { id: string; paidAmount: number; status: MilestoneStatus }
    invoice?: Record<string, unknown> | undefined
}> => {
    parseUuid(projectId, 'projectId')
    parseUuid(input.milestoneId, 'milestoneId')

    if (!input.amount || input.amount <= 0) {
        throw new PaymentInputError('Amount must be greater than zero', [
            { field: 'amount', message: 'Amount must be greater than zero' }
        ])
    }

    if (!PAYMENT_MODES.includes(input.mode)) {
        throw new PaymentInputError(`Payment mode must be one of: ${PAYMENT_MODES.join(', ')}`, [
            { field: 'mode', message: `mode must be one of: ${PAYMENT_MODES.join(', ')}` }
        ])
    }

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const rTable = receiptTable(schemaName)
    const iTable = invoiceTable(schemaName)
    const aTable = activityTable(schemaName)

    // Check project exists
    const { rows: projRows } = await database.execute(sql`
        select id, lead_id, project_name, customer_name, customer_phone, status from ${pTable} where id = ${projectId} and deleted_at is null limit 1
    `)
    const project = projRows[0] as unknown as {
        id: string
        lead_id: string | null
        project_name: string
        customer_name: string
        customer_phone: string | null
        status: string
    } | undefined

    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    // Check milestone exists
    const { rows: msRows } = await database.execute(sql`
        select * from ${mTable} where id = ${input.milestoneId} and deleted_at is null limit 1
    `)
    const milestone = msRows[0] as unknown as {
        id: string
        project_id: string
        milestone_name: string
        amount_due: string | number
        paid_amount: string | number
        status: MilestoneStatus
    } | undefined

    if (!milestone) {
        throw new PaymentNotFoundError('Milestone not found')
    }

    if (milestone.project_id !== projectId) {
        throw new PaymentInputError('milestoneId does not belong to this project', [
            { field: 'milestoneId', message: 'milestoneId does not belong to this project' }
        ])
    }

    if (milestone.status === 'Received') {
        throw new PaymentInputError('Milestone is already fully Received')
    }

    const amount = roundToTwo(input.amount)
    const currentPaid = roundToTwo(Number(milestone.paid_amount))
    const totalDue = roundToTwo(Number(milestone.amount_due))
    const balance = roundToTwo(totalDue - currentPaid)

    if (amount > balance) {
        const formattedAmount = amount.toLocaleString('en-IN')
        const formattedBalance = balance.toLocaleString('en-IN')
        throw new PaymentInputError(
            `Payment of ₹${formattedAmount} would exceed milestone balance of ₹${formattedBalance}. Maximum allowed: ₹${formattedBalance}`
        )
    }

    const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date()

    // Insert payment receipt
    const { rows: rRows } = await database.execute(sql`
        insert into ${rTable}
        (project_id, milestone_id, amount, mode, reference_number, payment_date, status, notes, recorded_by)
        values
        (${projectId}, ${input.milestoneId}, ${amount}, ${input.mode}, ${input.referenceNumber ?? null}, ${paymentDate}, 'Successful', ${input.notes ?? null}, ${userId})
        returning *
    `)
    const receipt = rRows[0] as unknown as ReceiptRow

    // Update milestone
    const newPaidAmount = roundToTwo(currentPaid + amount)
    const newMilestoneStatus: MilestoneStatus = newPaidAmount >= totalDue ? 'Received' : 'Partially Received'

    await database.execute(sql`
        update ${mTable}
        set paid_amount = ${newPaidAmount}, status = ${newMilestoneStatus}, updated_at = now()
        where id = ${input.milestoneId}
    `)

    // Check if all milestones for project are received
    const { rows: unreceivedRows } = await database.execute(sql`
        select count(*) as cnt from ${mTable}
        where project_id = ${projectId} and deleted_at is null and status != 'Received'
    `)
    const unreceivedCount = Number((unreceivedRows[0] as unknown as { cnt: string | number })?.cnt ?? 0)
    let projectCompleted = false
    if (unreceivedCount === 0) {
        await database.execute(sql`
            update ${pTable} set status = 'COMPLETED', updated_at = now() where id = ${projectId}
        `)
        projectCompleted = true
    }

    // Auto-generate invoice if requested
    let createdInvoice: Record<string, unknown> | undefined
    if (input.autoGenerateInvoice === true) {
        const grossAmount = roundToTwo(amount / 1.18)
        const gstAmount = roundToTwo(amount - grossAmount)
        const invoiceNumber = await getNextInvoiceNumber(database, schemaName)

        const { rows: invRows } = await database.execute(sql`
            insert into ${iTable}
            (project_id, receipt_id, invoice_number, invoice_date, gross_amount, gst_percentage, gst_amount, net_amount, status, created_by)
            values
            (${projectId}, ${receipt.id}, ${invoiceNumber}, ${paymentDate}, ${grossAmount}, 18.00, ${gstAmount}, ${amount}, 'Paid', ${userId})
            returning *
        `)
        const invRow = invRows[0] as unknown as Parameters<typeof toInvoiceResponse>[0]
        createdInvoice = toInvoiceResponse(invRow)

        if (project.lead_id) {
            await database.execute(sql`
                insert into ${aTable} (lead_id, activity_type, description, performed_by)
                values (${project.lead_id}, ${LEAD_ACTIVITY_TYPES.INVOICE_GENERATED}, ${`Invoice ${invoiceNumber} generated for ₹${amount}`}, ${userId})
            `)
        }
    }

    // Log activities on linked lead
    if (project.lead_id) {
        await database.execute(sql`
            insert into ${aTable} (lead_id, activity_type, description, performed_by)
            values (${project.lead_id}, ${LEAD_ACTIVITY_TYPES.PAYMENT_RECORDED}, ${`Payment of ₹${amount} recorded for ${milestone.milestone_name} via ${input.mode}`}, ${userId})
        `)

        if (newMilestoneStatus === 'Received') {
            await database.execute(sql`
                insert into ${aTable} (lead_id, activity_type, description, performed_by)
                values (${project.lead_id}, ${LEAD_ACTIVITY_TYPES.MILESTONE_COMPLETED}, ${`Milestone '${milestone.milestone_name}' fully received (₹${totalDue})`}, ${userId})
            `)
        }

        if (projectCompleted) {
            await database.execute(sql`
                insert into ${aTable} (lead_id, activity_type, description, performed_by)
                values (${project.lead_id}, ${LEAD_ACTIVITY_TYPES.PROJECT_COMPLETED}, 'All milestones received. Project marked as Completed', ${userId})
            `)
        }
    }

    const receiptResult = {
        id: receipt.id,
        projectId: receipt.project_id,
        milestoneId: receipt.milestone_id,
        amount: Number(receipt.amount),
        mode: receipt.mode,
        referenceNumber: receipt.reference_number,
        paymentDate: new Date(receipt.payment_date).toISOString(),
        status: receipt.status,
        recordedBy: receipt.recorded_by,
        createdAt: new Date(receipt.created_at).toISOString()
    }

    return {
        receipt: receiptResult,
        milestone: {
            id: milestone.id,
            paidAmount: newPaidAmount,
            status: newMilestoneStatus
        },
        ...(createdInvoice !== undefined ? { invoice: createdInvoice } : {})
    }
}

export const listReceipts = async (
    companyId: string,
    filters: ReceiptFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const rTable = receiptTable(schemaName)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)

    const conditions: SQL[] = [sql`r.deleted_at is null`]

    if (filters.search) {
        const searchPattern = `%${filters.search}%`
        conditions.push(sql`(p.project_name ilike ${searchPattern} or m.milestone_name ilike ${searchPattern} or r.reference_number ilike ${searchPattern})`)
    }

    if (filters.status) {
        conditions.push(sql`r.status = ${filters.status}`)
    }

    if (filters.mode) {
        conditions.push(sql`r.mode = ${filters.mode}`)
    }

    if (filters.projectId) {
        parseUuid(filters.projectId, 'projectId')
        conditions.push(sql`r.project_id = ${filters.projectId}`)
    }

    if (filters.dateFrom) {
        conditions.push(sql`r.payment_date >= ${filters.dateFrom}`)
    }

    if (filters.dateTo) {
        conditions.push(sql`r.payment_date <= ${filters.dateTo}`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        paymentDate: 'r.payment_date',
        amount: 'r.amount'
    } as const
    const orderCol = sortColumns[filters.sortBy] ?? 'r.payment_date'
    const orderDirection = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const offset = (filters.page - 1) * filters.limit

    const { rows } = await database.execute(sql`
        with filtered as (
            select r.*,
                   p.project_name,
                   p.customer_name,
                   p.customer_phone,
                   m.milestone_name,
                   concat(u.first_name, ' ', u.last_name) as recorder_name,
                   count(*) over() as _total_count
            from ${rTable} r
            left join ${pTable} p on p.id = r.project_id
            left join ${mTable} m on m.id = r.milestone_id
            left join root.users u on u.id = r.recorded_by
            where ${where}
        )
        select * from filtered
        order by ${sql.raw(`${orderCol.replace('r.', '')} ${orderDirection}`)}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as ReceiptRowWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    const formattedData = typedRows.map((r) => ({
        id: r.id,
        dateLogged: new Date(r.payment_date).toISOString(),
        projectName: r.project_name ?? 'Project',
        projectDetails: r.milestone_name ?? 'Payment',
        amount: Number(r.amount),
        mode: r.mode,
        refNo: r.reference_number ?? '-',
        status: r.status,
        customerPhone: r.customer_phone ?? '',
        projectId: r.project_id,
        milestoneId: r.milestone_id,
        recordedBy: {
            id: r.recorded_by,
            name: r.recorder_name ?? 'User'
        }
    }))

    return { data: formattedData, total }
}

export const getReceiptById = async (
    companyId: string,
    receiptId: string
): Promise<Record<string, unknown>> => {
    parseUuid(receiptId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const rTable = receiptTable(schemaName)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const iTable = invoiceTable(schemaName)

    const { rows } = await database.execute(sql`
        select r.*,
               p.project_name,
               p.customer_name,
               p.customer_phone,
               m.milestone_name,
               concat(u.first_name, ' ', u.last_name) as recorder_name,
               i.id as invoice_id,
               i.invoice_number
        from ${rTable} r
        left join ${pTable} p on p.id = r.project_id
        left join ${mTable} m on m.id = r.milestone_id
        left join ${iTable} i on i.receipt_id = r.id
        left join root.users u on u.id = r.recorded_by
        where r.id = ${receiptId} and r.deleted_at is null
        limit 1
    `)

    const receipt = rows[0] as unknown as ReceiptRow | undefined
    if (!receipt) {
        throw new PaymentNotFoundError('Receipt not found')
    }

    return toReceiptDetailResponse(receipt)
}

export const voidReceipt = async (
    companyId: string,
    userRole: string,
    userId: string,
    receiptId: string,
    reason: string
): Promise<{
    receipt: { id: string; status: string }
    milestone: { id: string; paidAmount: number; status: MilestoneStatus }
}> => {
    parseUuid(receiptId, 'id')

    if (userRole !== ROLE_NAMES.ADMIN && userRole !== ROLE_NAMES.SUPER_ADMIN) {
        throw new PaymentForbiddenError('Only administrators can void payment receipts')
    }

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const rTable = receiptTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const pTable = projectTable(schemaName)
    const iTable = invoiceTable(schemaName)
    const aTable = activityTable(schemaName)

    const { rows: rRows } = await database.execute(sql`
        select r.*, m.milestone_name, m.amount_due, m.paid_amount as milestone_paid_amount, p.lead_id
        from ${rTable} r
        left join ${mTable} m on m.id = r.milestone_id
        left join ${pTable} p on p.id = r.project_id
        where r.id = ${receiptId} and r.deleted_at is null
        limit 1
    `)
    const receipt = rRows[0] as unknown as {
        id: string
        project_id: string
        milestone_id: string | null
        amount: string | number
        status: string
        milestone_name: string | null
        amount_due: string | number | null
        milestone_paid_amount: string | number | null
        lead_id: string | null
    } | undefined

    if (!receipt) {
        throw new PaymentNotFoundError('Receipt not found')
    }

    if (receipt.status === 'Failed') {
        throw new PaymentConflictError('Receipt is already voided or failed')
    }

    // Set receipt to Failed
    await database.execute(sql`
        update ${rTable}
        set status = 'Failed', notes = ${reason || 'Voided'}, updated_at = now()
        where id = ${receiptId}
    `)

    // Subtract from milestone
    let newPaidAmount = 0
    let newStatus: MilestoneStatus = 'Pending'
    if (receipt.milestone_id) {
        const amount = Number(receipt.amount)
        const currentPaid = Number(receipt.milestone_paid_amount ?? 0)
        newPaidAmount = Math.max(0, roundToTwo(currentPaid - amount))
        newStatus = newPaidAmount <= 0 ? 'Pending' : 'Partially Received'

        await database.execute(sql`
            update ${mTable}
            set paid_amount = ${newPaidAmount}, status = ${newStatus}, updated_at = now()
            where id = ${receipt.milestone_id}
        `)
    }

    // Reopen project if it was COMPLETED
    await database.execute(sql`
        update ${pTable} set status = 'ACTIVE', updated_at = now() where id = ${receipt.project_id} and status = 'COMPLETED'
    `)

    // Void linked invoice if present
    await database.execute(sql`
        update ${iTable} set status = 'Cancelled', updated_at = now() where receipt_id = ${receiptId} and status != 'Cancelled'
    `)

    // Log activity on lead
    if (receipt.lead_id) {
        await database.execute(sql`
            insert into ${aTable} (lead_id, activity_type, description, performed_by)
            values (${receipt.lead_id}, ${LEAD_ACTIVITY_TYPES.PAYMENT_VOIDED}, ${`Payment of ₹${receipt.amount} voided for ${receipt.milestone_name ?? 'Milestone'}. Reason: ${reason}`}, ${userId})
        `)
    }

    return {
        receipt: { id: receipt.id, status: 'Failed' },
        milestone: {
            id: receipt.milestone_id ?? '',
            paidAmount: newPaidAmount,
            status: newStatus
        }
    }
}

export const shareReceiptWhatsApp = async (
    companyId: string,
    receiptId: string
): Promise<{ message: string; whatsappUrl: string; customerPhone: string }> => {
    parseUuid(receiptId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const rTable = receiptTable(schemaName)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)

    const { rows } = await database.execute(sql`
        select r.*,
               p.project_name,
               p.customer_phone,
               m.milestone_name
        from ${rTable} r
        left join ${pTable} p on p.id = r.project_id
        left join ${mTable} m on m.id = r.milestone_id
        where r.id = ${receiptId} and r.deleted_at is null
        limit 1
    `)

    const receipt = rows[0] as unknown as {
        amount: string | number
        mode: string
        reference_number: string | null
        payment_date: Date | string
        project_name: string | null
        customer_phone: string | null
        milestone_name: string | null
    } | undefined

    if (!receipt) {
        throw new PaymentNotFoundError('Receipt not found')
    }

    const formattedAmount = Number(receipt.amount).toLocaleString('en-IN')
    const dateStr = new Date(receipt.payment_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    })
    const ref = receipt.reference_number ? ` Ref: ${receipt.reference_number}.` : ''
    const pName = receipt.project_name ?? 'Project'
    const mName = receipt.milestone_name ?? 'Payment'

    const message = `Payment of ₹${formattedAmount} received for ${pName} (${mName}) via ${receipt.mode} on ${dateStr}.${ref} Thank you!`

    // Normalize phone number (strip spaces, dashes, plus)
    const rawPhone = receipt.customer_phone ?? ''
    const digits = rawPhone.replace(/\D/g, '')
    const phone = digits.startsWith('91') ? digits : digits.length === 10 ? `91${digits}` : digits

    const whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`

    return {
        message,
        whatsappUrl,
        customerPhone: rawPhone
    }
}

export const generateReceiptPdfBuffer = async (
    companyId: string,
    receiptId: string
): Promise<Buffer> => {
    parseUuid(receiptId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const rTable = receiptTable(schemaName)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const iTable = invoiceTable(schemaName)

    const { rows } = await database.execute(sql`
        select r.*,
               p.project_name,
               p.customer_name,
               p.customer_phone,
               m.milestone_name,
               concat(u.first_name, ' ', u.last_name) as recorder_name,
               i.invoice_number
        from ${rTable} r
        left join ${pTable} p on p.id = r.project_id
        left join ${mTable} m on m.id = r.milestone_id
        left join ${iTable} i on i.receipt_id = r.id
        left join root.users u on u.id = r.recorded_by
        where r.id = ${receiptId} and r.deleted_at is null
        limit 1
    `)

    const receipt = rows[0] as unknown as ReceiptRow | undefined
    if (!receipt) {
        throw new PaymentNotFoundError('Receipt not found')
    }

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' })
        const chunks: Buffer[] = []

        doc.on('data', (chunk: Buffer) => chunks.push(chunk))
        doc.on('end', () => resolve(Buffer.concat(chunks)))
        doc.on('error', (err: Error) => reject(err))

        // Colors
        const primaryColor = '#1e3a8a'
        const textColor = '#1f2937'
        const mutedColor = '#6b7280'

        // Header
        doc.fontSize(22).fillColor(primaryColor).text('PAYMENT RECEIPT', { align: 'right' })
        doc.fontSize(10).fillColor(mutedColor).text(`Receipt ID: ${receipt.id.slice(0, 8).toUpperCase()}`, { align: 'right' })
        doc.moveDown()

        // Company Details (left)
        doc.fontSize(16).fillColor(primaryColor).text('UPSKALOR SOLAR CRM', 50, 50)
        doc.fontSize(9).fillColor(textColor).text('Clean Green Energy Solutions')
        doc.text('GSTIN: 24AAACU8844D1ZZ')
        doc.text('Email: billing@upskalor.com | Web: www.upskalor.com')
        doc.moveDown(2)

        // Divider
        doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(50, 130).lineTo(545, 130).stroke()
        doc.moveDown()

        // Receipt Details Table Header
        const dateStr = new Date(receipt.payment_date).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        })

        const topY = 150
        doc.fontSize(10).fillColor(mutedColor).text('Received From:', 50, topY)
        doc.fontSize(12).fillColor(textColor).text(receipt.customer_name ?? 'Customer', 50, topY + 15)
        doc.fontSize(9).fillColor(mutedColor).text(`Phone: ${receipt.customer_phone ?? 'N/A'}`, 50, topY + 32)
        doc.fontSize(9).text(`Project: ${receipt.project_name ?? 'Solar Project'}`, 50, topY + 46)

        doc.fontSize(10).fillColor(mutedColor).text('Payment Date:', 350, topY)
        doc.fontSize(11).fillColor(textColor).text(dateStr, 350, topY + 15)

        doc.fontSize(10).fillColor(mutedColor).text('Payment Mode:', 350, topY + 35)
        doc.fontSize(11).fillColor(textColor).text(receipt.mode, 350, topY + 50)

        if (receipt.reference_number) {
            doc.fontSize(10).fillColor(mutedColor).text('Reference / Txn ID:', 350, topY + 70)
            doc.fontSize(11).fillColor(textColor).text(receipt.reference_number, 350, topY + 85)
        }

        // Milestone Details Box
        const boxY = 270
        doc.rect(50, boxY, 495, 80).fill('#f9fafb').stroke('#e5e7eb')

        doc.fontSize(11).fillColor(primaryColor).text('Milestone Particulars', 70, boxY + 15)
        doc.fontSize(10).fillColor(textColor).text(receipt.milestone_name ?? 'Advance Payment', 70, boxY + 35)

        doc.fontSize(11).fillColor(primaryColor).text('Amount Paid', 400, boxY + 15, { align: 'right', width: 120 })
        const formattedAmount = Number(receipt.amount).toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })
        doc.fontSize(14).fillColor('#059669').text(`₹${formattedAmount}`, 400, boxY + 35, { align: 'right', width: 120 })

        // Invoice note
        if (receipt.invoice_number) {
            doc.fontSize(9).fillColor(mutedColor).text(`Linked Invoice: ${receipt.invoice_number}`, 70, boxY + 55)
        }

        // Status Stamp
        doc.moveDown(6)
        doc.fontSize(12).fillColor(receipt.status === 'Successful' ? '#059669' : '#dc2626')
            .text(`Status: ${receipt.status.toUpperCase()}`, 50, 380)

        if (receipt.notes) {
            doc.fontSize(9).fillColor(mutedColor).text(`Notes: ${receipt.notes}`, 50, 400)
        }

        // Authorized Signature
        doc.strokeColor('#9ca3af').lineWidth(1).moveTo(350, 480).lineTo(500, 480).stroke()
        doc.fontSize(9).fillColor(textColor).text('Authorized Signatory', 350, 488, { align: 'center', width: 150 })
        doc.fontSize(8).fillColor(mutedColor).text(`Recorded By: ${receipt.recorder_name ?? 'Upskalor Admin'}`, 350, 502, { align: 'center', width: 150 })

        // Footer
        doc.fontSize(8).fillColor(mutedColor).text(
            'This is a computer-generated receipt and requires no physical signature under Indian Information Technology Act.',
            50,
            750,
            { align: 'center', width: 495 }
        )

        doc.end()
    })
}
