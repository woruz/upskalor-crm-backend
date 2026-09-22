import { sql, type SQL } from 'drizzle-orm'
import { database } from '../../database/client.js'
import { ensureCompanyPaymentTables } from '../../database/tenants.js'
import { ROLE_NAMES } from '../auth/rbac.js'
import { LEAD_ACTIVITY_TYPES } from '../leads/leads.js'
import { roundToTwo } from './invoices.js'
import {
    type AddMilestoneInput,
    type CreateProjectInput,
    type MilestoneStatus,
    type ProjectFilters,
    type ProjectStatus,
    PROJECT_STATUSES,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    type UpdateMilestoneInput,
    type UpdateProjectInput
} from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new PaymentInputError(`${field} must be a valid UUID`, [{ field, message: `${field} must be a valid UUID` }])
    }
    return value
}

const projectTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".projects`)
const milestoneTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".payment_milestones`)
const receiptTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".payment_receipts`)
const invoiceTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".invoices`)
const quoteTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".quotations`)
const leadTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".leads`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

interface ProjectRow {
    id: string
    lead_id: string | null
    quotation_id: string | null
    project_name: string
    customer_name: string
    customer_phone: string | null
    customer_email: string | null
    system_size_kw: string | number
    grand_total: string | number
    net_customer_cost: string | number
    status: ProjectStatus
    created_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
    lead_customer_name?: string | null
    quote_number?: string | null
}

interface ProjectRowWithCount extends ProjectRow {
    _total_count: string | number
}

interface MilestoneRow {
    id: string
    project_id: string
    milestone_name: string
    percentage: string | number | null
    amount_due: string | number
    paid_amount: string | number
    due_date: Date | string | null
    status: MilestoneStatus
    sort_order: number
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
}

interface ReceiptRow {
    id: string
    project_id: string
    milestone_id: string | null
    amount: string | number
    mode: string
    reference_number: string | null
    payment_date: Date | string
    status: string
    notes: string | null
    recorded_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
}

export const toMilestoneResponse = (row: MilestoneRow, receipts?: ReceiptRow[]): Record<string, unknown> => {
    const res: Record<string, unknown> = {
        id: row.id,
        projectId: row.project_id,
        milestoneName: row.milestone_name,
        percentage: row.percentage === null ? null : Number(row.percentage),
        amountDue: Number(row.amount_due),
        paidAmount: Number(row.paid_amount),
        dueDate: row.due_date ? new Date(row.due_date).toISOString() : null,
        status: row.status,
        sortOrder: row.sort_order,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (receipts !== undefined) {
        res['receipts'] = receipts.map((r) => ({
            id: r.id,
            amount: Number(r.amount),
            mode: r.mode,
            referenceNumber: r.reference_number,
            paymentDate: new Date(r.payment_date).toISOString(),
            status: r.status,
            notes: r.notes
        }))
    }

    return res
}

export const toProjectResponse = (row: ProjectRow, milestones?: Record<string, unknown>[]): Record<string, unknown> => {
    const res: Record<string, unknown> = {
        id: row.id,
        leadId: row.lead_id,
        quotationId: row.quotation_id,
        projectName: row.project_name,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        customerEmail: row.customer_email,
        systemSizeKw: Number(row.system_size_kw),
        grandTotal: Number(row.grand_total),
        netCustomerCost: Number(row.net_customer_cost),
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (milestones !== undefined) {
        res['milestones'] = milestones
    }

    return res
}

export const createProjectFromQuotation = async (
    companyId: string,
    userId: string,
    input: CreateProjectInput
): Promise<Record<string, unknown>> => {
    parseUuid(input.quotationId, 'quotationId')

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const qTable = quoteTable(schemaName)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const lTable = leadTable(schemaName)
    const aTable = activityTable(schemaName)

    // Fetch quotation
    const { rows: quoteRows } = await database.execute(sql`
        select * from ${qTable} where id = ${input.quotationId} and deleted_at is null limit 1
    `)
    const quotation = quoteRows[0] as unknown as {
        id: string
        lead_id: string | null
        quote_number: string
        system_size_kw: string | number
        grand_total: string | number
        net_customer_cost: string | number
        advance_percentage: string | number
        delivery_percentage: string | number
        commissioning_percentage: string | number
        status: string
    } | undefined

    if (!quotation) {
        throw new PaymentInputError('Quotation does not exist', [
            { field: 'quotationId', message: 'Quotation does not exist' }
        ])
    }

    if (quotation.status !== 'ACCEPTED') {
        throw new PaymentInputError(`Quotation status is ${quotation.status}. Project can only be created from ACCEPTED quotations.`, [
            { field: 'quotationId', message: `Quotation status is ${quotation.status}. Only ACCEPTED quotations can be converted to projects.` }
        ])
    }

    // Check if project already exists for this quotation
    const { rows: existingProj } = await database.execute(sql`
        select id from ${pTable} where quotation_id = ${input.quotationId} and deleted_at is null limit 1
    `)
    if (existingProj.length > 0) {
        throw new PaymentConflictError('A project already exists for this quotation')
    }

    // Fetch linked lead if available
    let customerName = 'Customer'
    let customerPhone: string | null = null
    let customerEmail: string | null = null

    if (quotation.lead_id) {
        const { rows: leadRows } = await database.execute(sql`
            select customer_name, mobile_number, email from ${lTable} where id = ${quotation.lead_id} limit 1
        `)
        const lead = leadRows[0] as unknown as { customer_name: string; mobile_number: string; email: string | null } | undefined
        if (lead) {
            customerName = lead.customer_name
            customerPhone = lead.mobile_number
            customerEmail = lead.email
        }
    }

    const netCustomerCost = Number(quotation.net_customer_cost)
    const grandTotal = Number(quotation.grand_total)
    const systemSizeKw = Number(quotation.system_size_kw)
    const advancePct = Number(quotation.advance_percentage)
    const deliveryPct = Number(quotation.delivery_percentage)
    const commissioningPct = Number(quotation.commissioning_percentage)

    // Calculate milestone splits
    const advanceAmount = roundToTwo((netCustomerCost * advancePct) / 100)
    const deliveryAmount = roundToTwo((netCustomerCost * deliveryPct) / 100)
    const commissioningAmount = roundToTwo(netCustomerCost - advanceAmount - deliveryAmount)

    // Validate ±₹1 rounding tolerance
    if (Math.abs(advanceAmount + deliveryAmount + commissioningAmount - netCustomerCost) > 1) {
        throw new PaymentInputError('Milestone amounts do not sum to net customer cost')
    }

    const currentYear = new Date().getFullYear()
    const projectName = input.projectName?.trim() || `${customerName} - ${systemSizeKw}kW - ${currentYear}`

    const advanceDueDate = input.milestoneDueDates?.advance ? new Date(input.milestoneDueDates.advance) : null
    const deliveryDueDate = input.milestoneDueDates?.delivery ? new Date(input.milestoneDueDates.delivery) : null
    const commissioningDueDate = input.milestoneDueDates?.commissioning ? new Date(input.milestoneDueDates.commissioning) : null

    // Insert project
    const { rows: projRows } = await database.execute(sql`
        insert into ${pTable}
        (lead_id, quotation_id, project_name, customer_name, customer_phone, customer_email, system_size_kw, grand_total, net_customer_cost, status, created_by)
        values
        (${quotation.lead_id}, ${input.quotationId}, ${projectName}, ${customerName}, ${customerPhone}, ${customerEmail}, ${systemSizeKw}, ${grandTotal}, ${netCustomerCost}, 'ACTIVE', ${userId})
        returning *
    `)
    const project = projRows[0] as unknown as ProjectRow

    // Insert 3 milestones
    const { rows: milestoneRows } = await database.execute(sql`
        insert into ${mTable}
        (project_id, milestone_name, percentage, amount_due, paid_amount, due_date, status, sort_order)
        values
        (${project.id}, 'Advance Payment', ${advancePct}, ${advanceAmount}, 0, ${advanceDueDate}, 'Pending', 0),
        (${project.id}, 'Delivery Payment', ${deliveryPct}, ${deliveryAmount}, 0, ${deliveryDueDate}, 'Pending', 1),
        (${project.id}, 'Commissioning Payment', ${commissioningPct}, ${commissioningAmount}, 0, ${commissioningDueDate}, 'Pending', 2)
        returning *
    `)

    // Update quotation status to CONVERTED
    await database.execute(sql`
        update ${qTable} set status = 'CONVERTED', updated_at = now() where id = ${input.quotationId}
    `)

    // Update lead status to CONVERTED and log activity
    if (quotation.lead_id) {
        await database.execute(sql`
            update ${lTable} set status = 'CONVERTED', updated_at = now() where id = ${quotation.lead_id}
        `)
        await database.execute(sql`
            insert into ${aTable} (lead_id, activity_type, description, performed_by)
            values (${quotation.lead_id}, ${LEAD_ACTIVITY_TYPES.STATUS_CHANGED}, ${`Project '${projectName}' created from quotation ${quotation.quote_number}`}, ${userId})
        `)
    }

    const createdMilestones = (milestoneRows as unknown as MilestoneRow[]).map((m) => toMilestoneResponse(m))
    return toProjectResponse(project, createdMilestones)
}

export const listProjects = async (
    companyId: string,
    filters: ProjectFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)

    const conditions: SQL[] = [sql`p.deleted_at is null`]

    if (filters.search) {
        const searchPattern = `%${filters.search}%`
        conditions.push(sql`(p.project_name ilike ${searchPattern} or p.customer_name ilike ${searchPattern})`)
    }

    if (filters.status) {
        conditions.push(sql`p.status = ${filters.status}`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        createdAt: 'created_at',
        projectName: 'project_name',
        grandTotal: 'grand_total'
    } as const
    const orderCol = sortColumns[filters.sortBy] ?? 'created_at'
    const orderDirection = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const offset = (filters.page - 1) * filters.limit

    const { rows } = await database.execute(sql`
        with filtered as (
            select p.*,
                   count(*) over() as _total_count
            from ${pTable} p
            where ${where}
        )
        select * from filtered
        order by ${sql.raw(`${orderCol} ${orderDirection}`)}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as ProjectRowWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return {
        data: typedRows.map((r) => toProjectResponse(r)),
        total
    }
}

export const getProjectById = async (
    companyId: string,
    projectId: string
): Promise<Record<string, unknown>> => {
    parseUuid(projectId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const rTable = receiptTable(schemaName)
    const qTable = quoteTable(schemaName)
    const lTable = leadTable(schemaName)

    const { rows } = await database.execute(sql`
        select p.*,
               l.customer_name as lead_customer_name,
               q.quote_number
        from ${pTable} p
        left join ${lTable} l on l.id = p.lead_id
        left join ${qTable} q on q.id = p.quotation_id
        where p.id = ${projectId} and p.deleted_at is null
        limit 1
    `)

    const project = rows[0] as unknown as ProjectRow | undefined
    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    // Milestones
    const { rows: milestoneRows } = await database.execute(sql`
        select * from ${mTable} where project_id = ${projectId} and deleted_at is null order by sort_order asc
    `)
    const typedMilestones = milestoneRows as unknown as MilestoneRow[]

    // Receipts
    const { rows: receiptRows } = await database.execute(sql`
        select * from ${rTable} where project_id = ${projectId} and deleted_at is null order by payment_date desc
    `)
    const typedReceipts = receiptRows as unknown as ReceiptRow[]

    const receiptMap = new Map<string, ReceiptRow[]>()
    for (const r of typedReceipts) {
        if (r.milestone_id) {
            const list = receiptMap.get(r.milestone_id) ?? []
            list.push(r)
            receiptMap.set(r.milestone_id, list)
        }
    }

    let totalReceived = 0
    let totalDue = 0
    const milestonesWithReceipts = typedMilestones.map((m) => {
        totalReceived += Number(m.paid_amount)
        totalDue += Number(m.amount_due)
        return toMilestoneResponse(m, receiptMap.get(m.id) ?? [])
    })

    const totalBalance = Math.max(0, roundToTwo(totalDue - totalReceived))

    const response = toProjectResponse(project, milestonesWithReceipts)
    response['totalReceived'] = roundToTwo(totalReceived)
    response['totalBalance'] = totalBalance

    if (project.lead_id) {
        response['lead'] = {
            id: project.lead_id,
            customerName: project.customer_name
        }
    }

    if (project.quotation_id) {
        response['quotation'] = {
            id: project.quotation_id,
            quoteNumber: project.quote_number ?? undefined
        }
    }

    return response
}

export const updateProject = async (
    companyId: string,
    userRole: string,
    projectId: string,
    input: UpdateProjectInput
): Promise<Record<string, unknown>> => {
    parseUuid(projectId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${pTable} where id = ${projectId} and deleted_at is null limit 1
    `)
    const project = rows[0] as unknown as ProjectRow | undefined
    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    const updateFields: SQL[] = [sql`updated_at = now()`]

    if (input.projectName !== undefined) {
        const name = input.projectName.trim()
        if (!name) {
            throw new PaymentInputError('projectName cannot be empty')
        }
        updateFields.push(sql`project_name = ${name}`)
    }

    if (input.customerPhone !== undefined) {
        updateFields.push(sql`customer_phone = ${input.customerPhone.trim() || null}`)
    }

    if (input.status !== undefined) {
        if (!PROJECT_STATUSES.includes(input.status)) {
            throw new PaymentInputError(`Invalid project status: ${input.status}`)
        }
        if (project.status === 'CANCELLED' && input.status === 'ACTIVE') {
            if (userRole !== ROLE_NAMES.ADMIN && userRole !== ROLE_NAMES.SUPER_ADMIN) {
                throw new PaymentForbiddenError('Only administrators can reactivate a CANCELLED project')
            }
        }
        updateFields.push(sql`status = ${input.status}`)
    }

    const { rows: updatedRows } = await database.execute(sql`
        update ${pTable}
        set ${sql.join(updateFields, sql`, `)}
        where id = ${projectId}
        returning *
    `)

    return toProjectResponse(updatedRows[0] as unknown as ProjectRow)
}

export const deleteProject = async (
    companyId: string,
    userRole: string,
    projectId: string
): Promise<{ message: string; projectId: string }> => {
    parseUuid(projectId, 'id')
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const rTable = receiptTable(schemaName)
    const iTable = invoiceTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${pTable} where id = ${projectId} and deleted_at is null limit 1
    `)
    const project = rows[0] as unknown as ProjectRow | undefined
    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    // Check if there are recorded payments
    const { rows: receiptCount } = await database.execute(sql`
        select count(*) as cnt from ${rTable} where project_id = ${projectId} and deleted_at is null and status = 'Successful'
    `)
    const paymentsRecorded = Number((receiptCount[0] as unknown as { cnt: string | number })?.cnt ?? 0) > 0

    if (paymentsRecorded && userRole !== ROLE_NAMES.ADMIN && userRole !== ROLE_NAMES.SUPER_ADMIN) {
        throw new PaymentForbiddenError('Non-admin users cannot delete a project with recorded payments')
    }

    // Cascaded soft delete
    await database.execute(sql`
        update ${pTable} set deleted_at = now(), updated_at = now() where id = ${projectId}
    `)
    await database.execute(sql`
        update ${mTable} set deleted_at = now(), updated_at = now() where project_id = ${projectId} and deleted_at is null
    `)
    await database.execute(sql`
        update ${rTable} set deleted_at = now(), updated_at = now() where project_id = ${projectId} and deleted_at is null
    `)
    await database.execute(sql`
        update ${iTable} set deleted_at = now(), updated_at = now() where project_id = ${projectId} and deleted_at is null
    `)

    return { message: 'Project deleted successfully', projectId }
}

// ─── Milestone Endpoints ──────────────────────────────────────────────────────

export const addProjectMilestone = async (
    companyId: string,
    projectId: string,
    input: AddMilestoneInput
): Promise<Record<string, unknown>> => {
    parseUuid(projectId, 'projectId')

    const name = input.milestoneName.trim()
    if (!name) {
        throw new PaymentInputError('milestoneName is required')
    }

    if (!input.amountDue || input.amountDue <= 0) {
        throw new PaymentInputError('amountDue must be greater than zero')
    }

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)

    const { rows: projRows } = await database.execute(sql`
        select * from ${pTable} where id = ${projectId} and deleted_at is null limit 1
    `)
    const project = projRows[0] as unknown as ProjectRow | undefined
    if (!project) {
        throw new PaymentNotFoundError('Project not found')
    }

    // Check sum of existing milestones + new milestone doesn't exceed netCustomerCost
    const { rows: existingSum } = await database.execute(sql`
        select coalesce(sum(amount_due), 0) as total_due, coalesce(max(sort_order), 0) as max_sort
        from ${mTable} where project_id = ${projectId} and deleted_at is null
    `)
    const currentTotalDue = Number((existingSum[0] as unknown as { total_due: string | number })?.total_due ?? 0)
    const maxSort = Number((existingSum[0] as unknown as { max_sort: string | number })?.max_sort ?? 0)

    const newAmountDue = roundToTwo(input.amountDue)
    const netCost = Number(project.net_customer_cost)

    if (roundToTwo(currentTotalDue + newAmountDue) > roundToTwo(netCost + 1)) {
        throw new PaymentInputError(
            `Total milestone amounts (${roundToTwo(currentTotalDue + newAmountDue)}) would exceed project net customer cost (${netCost})`
        )
    }

    const dueDate = input.dueDate ? new Date(input.dueDate) : null
    const pct = input.percentage !== undefined && input.percentage !== null ? Number(input.percentage) : null

    const { rows: newRows } = await database.execute(sql`
        insert into ${mTable}
        (project_id, milestone_name, percentage, amount_due, paid_amount, due_date, status, sort_order)
        values
        (${projectId}, ${name}, ${pct}, ${newAmountDue}, 0, ${dueDate}, 'Pending', ${maxSort + 1})
        returning *
    `)

    return toMilestoneResponse(newRows[0] as unknown as MilestoneRow)
}

export const updateProjectMilestone = async (
    companyId: string,
    projectId: string,
    milestoneId: string,
    input: UpdateMilestoneInput
): Promise<Record<string, unknown>> => {
    parseUuid(projectId, 'projectId')
    parseUuid(milestoneId, 'milestoneId')

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${mTable} where id = ${milestoneId} and project_id = ${projectId} and deleted_at is null limit 1
    `)
    const milestone = rows[0] as unknown as MilestoneRow | undefined
    if (!milestone) {
        throw new PaymentNotFoundError('Milestone not found')
    }

    const updateFields: SQL[] = [sql`updated_at = now()`]

    if (input.milestoneName !== undefined) {
        const name = input.milestoneName.trim()
        if (!name) throw new PaymentInputError('milestoneName cannot be empty')
        updateFields.push(sql`milestone_name = ${name}`)
    }

    if (input.dueDate !== undefined) {
        updateFields.push(sql`due_date = ${input.dueDate ? new Date(input.dueDate) : null}`)
    }

    if (input.amountDue !== undefined) {
        const newDue = roundToTwo(input.amountDue)
        const paid = Number(milestone.paid_amount)
        if (newDue < paid) {
            throw new PaymentInputError(`Cannot reduce amountDue (${newDue}) below paidAmount (${paid})`)
        }

        // Verify total with other milestones doesn't exceed netCustomerCost
        const { rows: projRows } = await database.execute(sql`
            select net_customer_cost from ${pTable} where id = ${projectId} limit 1
        `)
        const netCost = Number((projRows[0] as unknown as { net_customer_cost: string | number })?.net_customer_cost ?? 0)

        const { rows: otherSum } = await database.execute(sql`
            select coalesce(sum(amount_due), 0) as total_due
            from ${mTable} where project_id = ${projectId} and id != ${milestoneId} and deleted_at is null
        `)
        const otherTotal = Number((otherSum[0] as unknown as { total_due: string | number })?.total_due ?? 0)

        if (roundToTwo(otherTotal + newDue) > roundToTwo(netCost + 1)) {
            throw new PaymentInputError(`Total milestone amounts (${roundToTwo(otherTotal + newDue)}) would exceed project net customer cost (${netCost})`)
        }

        updateFields.push(sql`amount_due = ${newDue}`)
    }

    const { rows: updatedRows } = await database.execute(sql`
        update ${mTable}
        set ${sql.join(updateFields, sql`, `)}
        where id = ${milestoneId}
        returning *
    `)

    return toMilestoneResponse(updatedRows[0] as unknown as MilestoneRow)
}

export const deleteProjectMilestone = async (
    companyId: string,
    projectId: string,
    milestoneId: string
): Promise<{ message: string; milestoneId: string }> => {
    parseUuid(projectId, 'projectId')
    parseUuid(milestoneId, 'milestoneId')

    const schemaName = await ensureCompanyPaymentTables(companyId)
    const mTable = milestoneTable(schemaName)

    const { rows } = await database.execute(sql`
        select * from ${mTable} where id = ${milestoneId} and project_id = ${projectId} and deleted_at is null limit 1
    `)
    const milestone = rows[0] as unknown as MilestoneRow | undefined
    if (!milestone) {
        throw new PaymentNotFoundError('Milestone not found')
    }

    if (Number(milestone.paid_amount) > 0) {
        throw new PaymentForbiddenError('Cannot delete milestone with recorded payments. Void payments first.')
    }

    await database.execute(sql`
        update ${mTable} set deleted_at = now(), updated_at = now() where id = ${milestoneId}
    `)

    return { message: 'Milestone deleted successfully', milestoneId }
}
