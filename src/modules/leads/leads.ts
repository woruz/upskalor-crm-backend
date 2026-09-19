import { randomUUID } from 'node:crypto'

import { eq, and, sql, type SQL } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { ensureCompanyLeadTables } from '../../database/tenants.js'

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED', 'LOST'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LEAD_ACTIVITY_TYPES = {
    CREATED: 'LEAD_CREATED',
    UPDATED: 'LEAD_UPDATED',
    ASSIGNED: 'LEAD_ASSIGNED',
    REASSIGNED: 'LEAD_REASSIGNED',
    STATUS_CHANGED: 'LEAD_STATUS_CHANGED',
    FOLLOW_UP_CHANGED: 'FOLLOW_UP_CHANGED',
    DELETED: 'LEAD_DELETED'
} as const

export class LeadInputError extends Error {}
export class LeadNotFoundError extends Error {}
export class LeadReferenceError extends Error {}

export interface LeadInput {
    customerName: string
    mobileNumber: string
    email?: string | undefined
    address?: string | undefined
    monthlyBillAmount?: number | undefined
    followUpDate: Date
    state?: string | undefined
    city?: string | undefined
    roofOwnership?: string | undefined
    roofType?: string | undefined
    leadSource?: string | undefined
    assignedExecutive?: string | undefined
    status: LeadStatus
}

export interface LeadFilters {
    page: number
    limit: number
    search?: string
    status?: LeadStatus | undefined
    assignedExecutive?: string | undefined
    leadSource?: string | undefined
    state?: string | undefined
    city?: string | undefined
    followUpDate?: Date | undefined
    followUpDateFrom?: Date | undefined
    followUpDateTo?: Date | undefined
    sort: 'createdAt' | 'followUpDate' | 'customerName' | 'status'
    direction: 'asc' | 'desc'
}

interface LeadRow {
    id: string
    customer_name: string
    mobile_number: string
    email: string | null
    address: string | null
    monthly_bill_amount: string | number | null
    follow_up_date: Date | string
    state: string | null
    city: string | null
    roof_ownership: string | null
    roof_type: string | null
    lead_source: string | null
    assigned_executive: string | null
    status: LeadStatus
    created_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
}

interface LeadWithCount extends LeadRow {
    _total_count: string | number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INDIAN_MOBILE_PATTERN = /^[6-9][0-9]{9}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PAGE_SIZE = 100

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredText = (value: unknown, field: string, maxLength: number, minLength = 1): string => {
    if (typeof value !== 'string') {
        throw new LeadInputError(`${field} must be a string`)
    }

    const normalized = value.trim()
    if (normalized.length < minLength || normalized.length > maxLength) {
        throw new LeadInputError(`${field} must be between ${minLength} and ${maxLength} characters`)
    }

    return normalized
}

const optionalText = (value: unknown, field: string, maxLength: number): string | undefined => {
    if (value === undefined || value === null) {
        return undefined
    }
    return requiredText(value, field, maxLength)
}

const parseDate = (value: unknown, field: string): Date => {
    if (typeof value !== 'string' && !(value instanceof Date)) {
        throw new LeadInputError(`${field} must be a valid date`)
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        throw new LeadInputError(`${field} must be a valid date`)
    }
    return date
}

const parseStatus = (value: unknown): LeadStatus => {
    if (typeof value !== 'string' || !LEAD_STATUSES.includes(value.trim().toUpperCase() as LeadStatus)) {
        throw new LeadInputError('status is invalid')
    }
    return value.trim().toUpperCase() as LeadStatus
}

const parseAmount = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') {
        return undefined
    }
    const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999999999.99) {
        throw new LeadInputError('monthlyBillAmount is invalid')
    }
    return amount
}

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new LeadInputError(`${field} is invalid`)
    }
    return value
}

export const parseLeadInput = (body: unknown, partial = false): Partial<LeadInput> => {
    if (!isRecord(body)) {
        throw new LeadInputError('Request body must be a JSON object')
    }
    const result: Partial<LeadInput> = {}

    if (!partial || body['customerName'] !== undefined) {
        result.customerName = requiredText(body['customerName'], 'customerName', 150, 2)
    }
    if (!partial || body['mobileNumber'] !== undefined) {
        const mobileNumber = requiredText(body['mobileNumber'], 'mobileNumber', 20).replace(/[\s-]/g, '')
        if (!INDIAN_MOBILE_PATTERN.test(mobileNumber)) {
            throw new LeadInputError('mobileNumber is invalid')
        }
        result.mobileNumber = mobileNumber
    }
    if (!partial || body['followUpDate'] !== undefined) {
        result.followUpDate = parseDate(body['followUpDate'], 'followUpDate')
    }
    if (body['email'] !== undefined && body['email'] !== null && body['email'] !== '') {
        const email = requiredText(body['email'], 'email', 320).toLowerCase()
        if (!EMAIL_PATTERN.test(email)) {
            throw new LeadInputError('email is invalid')
        }
        result.email = email
    } else if (partial && body['email'] !== undefined) {
        ;(result as Record<string, unknown>)['email'] = undefined
    }

    const textFields: Array<[keyof LeadInput, string, number]> = [
        ['address', 'address', 500],
        ['state', 'state', 100],
        ['city', 'city', 100],
        ['roofOwnership', 'roofOwnership', 100],
        ['roofType', 'roofType', 100],
        ['leadSource', 'leadSource', 100]
    ]
    for (const [key, field, maxLength] of textFields) {
        if (body[field] !== undefined) {
            ;(result as Record<string, unknown>)[key] = optionalText(body[field], field, maxLength)
        }
    }
    if (body['monthlyBillAmount'] !== undefined) {
        ;(result as Record<string, unknown>)['monthlyBillAmount'] = parseAmount(body['monthlyBillAmount'])
    }
    if (body['assignedExecutive'] !== undefined && body['assignedExecutive'] !== null && body['assignedExecutive'] !== '') {
        result.assignedExecutive = parseUuid(requiredText(body['assignedExecutive'], 'assignedExecutive', 36), 'assignedExecutive')
    } else if (partial && body['assignedExecutive'] !== undefined) {
        ;(result as Record<string, unknown>)['assignedExecutive'] = undefined
    }
    if (body['status'] !== undefined) {
        result.status = parseStatus(body['status'])
    } else if (!partial) {
        result.status = 'NEW'
    }

    return result
}

export const parseLeadFilters = (url: URL): LeadFilters => {
    const numberParam = (name: string, fallback: number): number => {
        const value = Number(url.searchParams.get(name) ?? fallback)
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new LeadInputError(`${name} must be a positive integer`)
        }
        return value
    }
    const dateParam = (name: string): Date | undefined => {
        const value = url.searchParams.get(name)
        return value === null ? undefined : parseDate(value, name)
    }
    const sort = url.searchParams.get('sort') ?? 'createdAt'
    if (!['createdAt', 'followUpDate', 'customerName', 'status'].includes(sort)) {
        throw new LeadInputError('sort is invalid')
    }
    const direction = url.searchParams.get('direction') ?? 'desc'
    if (direction !== 'asc' && direction !== 'desc') {
        throw new LeadInputError('direction is invalid')
    }

    const limit = numberParam('limit', 20)
    if (limit > MAX_PAGE_SIZE) {
        throw new LeadInputError(`limit must be at most ${MAX_PAGE_SIZE}`)
    }
    const filters: LeadFilters = {
        page: numberParam('page', 1),
        limit,
        sort: sort as LeadFilters['sort'],
        direction
    }
    const search = url.searchParams.get('search')?.trim()
    if (search) {
        filters.search = search
    }
    const status = url.searchParams.get('status')
    if (status) {
        filters.status = parseStatus(status)
    }
    for (const field of ['assignedExecutive', 'leadSource', 'state', 'city'] as const) {
        const value = url.searchParams.get(field)?.trim()
        if (value) {
            filters[field] = field === 'assignedExecutive' ? parseUuid(value, field) : value
        }
    }
    filters.followUpDate = dateParam('followUpDate')
    filters.followUpDateFrom = dateParam('followUpDateFrom')
    filters.followUpDateTo = dateParam('followUpDateTo')
    if (filters.followUpDateFrom && filters.followUpDateTo && filters.followUpDateFrom > filters.followUpDateTo) {
        throw new LeadInputError('followUpDateFrom must be before followUpDateTo')
    }
    return filters
}

const toLead = (row: LeadRow): Record<string, unknown> => ({
    id: row.id,
    customerName: row.customer_name,
    mobileNumber: row.mobile_number,
    email: row.email,
    address: row.address,
    monthlyBillAmount: row.monthly_bill_amount === null ? null : Number(row.monthly_bill_amount),
    followUpDate: new Date(row.follow_up_date).toISOString(),
    state: row.state,
    city: row.city,
    roofOwnership: row.roof_ownership,
    roofType: row.roof_type,
    leadSource: row.lead_source,
    assignedExecutive: row.assigned_executive,
    status: row.status,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
})

const leadTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".leads`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

/**
 * Verifies that a user exists within the company and is active.
 * Uses Drizzle typed query on the root.users table (no raw SQL).
 */
const verifyExecutive = async (companyId: string, executiveId: string): Promise<void> => {
    const [user] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, executiveId), eq(users.companyId, companyId), eq(users.isActive, true)))
        .limit(1)

    if (user === undefined) {
        throw new LeadReferenceError('assignedExecutive is invalid')
    }
}

const buildWhereConditions = (schemaName: string, filters: LeadFilters): SQL[] => {
    const table = leadTable(schemaName)
    const conditions: SQL[] = [sql`${table}.deleted_at is null`]

    if (filters.search) {
        conditions.push(
            sql`(${table}.customer_name ilike ${`%${filters.search}%`} or ${table}.mobile_number ilike ${`%${filters.search}%`} or ${table}.email ilike ${`%${filters.search}%`})`
        )
    }
    if (filters.status) conditions.push(sql`${table}.status = ${filters.status}`)
    if (filters.assignedExecutive) conditions.push(sql`${table}.assigned_executive = ${filters.assignedExecutive}`)
    if (filters.leadSource) conditions.push(sql`${table}.lead_source = ${filters.leadSource}`)
    if (filters.state) conditions.push(sql`${table}.state = ${filters.state}`)
    if (filters.city) conditions.push(sql`${table}.city = ${filters.city}`)
    if (filters.followUpDate) conditions.push(sql`date(${table}.follow_up_date) = date(${filters.followUpDate})`)
    if (filters.followUpDateFrom) conditions.push(sql`${table}.follow_up_date >= ${filters.followUpDateFrom}`)
    if (filters.followUpDateTo) conditions.push(sql`${table}.follow_up_date <= ${filters.followUpDateTo}`)

    return conditions
}

export const createLead = async (companyId: string, userId: string, input: LeadInput): Promise<Record<string, unknown>> => {
    let schemaName = await ensureCompanyLeadTables(companyId)
    if (input.assignedExecutive) {
        await verifyExecutive(companyId, input.assignedExecutive)
    }
    const id = randomUUID()
    let table = leadTable(schemaName)
    let aTable = activityTable(schemaName)

    let createRows: unknown[]
    try {
        const { rows } = await database.execute(sql`
            insert into ${table}
            (id, customer_name, mobile_number, email, address, monthly_bill_amount, follow_up_date, state, city, roof_ownership, roof_type, lead_source, assigned_executive, status, created_by)
            values (${id}, ${input.customerName}, ${input.mobileNumber}, ${input.email ?? null}, ${input.address ?? null}, ${input.monthlyBillAmount ?? null}, ${input.followUpDate}, ${input.state ?? null}, ${input.city ?? null}, ${input.roofOwnership ?? null}, ${input.roofType ?? null}, ${input.leadSource ?? null}, ${input.assignedExecutive ?? null}, ${input.status}, ${userId}) returning *
        `)
        createRows = rows
    } catch (error) {
        if (error instanceof Error && (error.message.includes('does not exist') || error.message.includes('relation'))) {
            schemaName = await ensureCompanyLeadTables(companyId, true)
            table = leadTable(schemaName)
            aTable = activityTable(schemaName)
            const { rows } = await database.execute(sql`
                insert into ${table}
                (id, customer_name, mobile_number, email, address, monthly_bill_amount, follow_up_date, state, city, roof_ownership, roof_type, lead_source, assigned_executive, status, created_by)
                values (${id}, ${input.customerName}, ${input.mobileNumber}, ${input.email ?? null}, ${input.address ?? null}, ${input.monthlyBillAmount ?? null}, ${input.followUpDate}, ${input.state ?? null}, ${input.city ?? null}, ${input.roofOwnership ?? null}, ${input.roofType ?? null}, ${input.leadSource ?? null}, ${input.assignedExecutive ?? null}, ${input.status}, ${userId}) returning *
            `)
            createRows = rows
        } else {
            throw error
        }
    }
    const row = createRows[0] as unknown as LeadRow | undefined
    if (row === undefined) {
        throw new Error('Lead creation failed')
    }
    await database.execute(
        sql`insert into ${aTable} (lead_id, activity_type, description, performed_by) values (${id}, ${LEAD_ACTIVITY_TYPES.CREATED}, 'Lead created', ${userId})`
    )
    return toLead(row)
}

export const listLeads = async (companyId: string, filters: LeadFilters): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyLeadTables(companyId)
    const conditions = buildWhereConditions(schemaName, filters)
    const where = sql.join(conditions, sql` and `)

    const sortColumns = {
        createdAt: 'created_at',
        followUpDate: 'follow_up_date',
        customerName: 'customer_name',
        status: 'status'
    } as const
    // Safe: sortColumns keys are statically constrained by LeadFilters['sort'] type
    const orderCol = sortColumns[filters.sort]
    const orderDir = filters.direction === 'asc' ? 'asc' : 'desc'
    const order = sql.raw(`${orderCol} ${orderDir}`)
    const offset = (filters.page - 1) * filters.limit
    const table = leadTable(schemaName)

    // Single query with CTE — eliminates the separate count round-trip
    const { rows } = await database.execute(sql`
        with filtered as (
            select *, count(*) over() as _total_count
            from ${table}
            where ${where}
        )
        select * from filtered
        order by ${order}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as LeadWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return { data: typedRows.map(toLead), total }
}

export const queryLeadsForExport = async (companyId: string, filters: LeadFilters, maxRows: number): Promise<Record<string, unknown>[]> => {
    const schemaName = await ensureCompanyLeadTables(companyId)
    const where = sql.join(buildWhereConditions(schemaName, filters), sql` and `)
    const sortColumns = { createdAt: 'created_at', followUpDate: 'follow_up_date', customerName: 'customer_name', status: 'status' } as const
    const order = sql.raw(`${sortColumns[filters.sort]} ${filters.direction === 'asc' ? 'asc' : 'desc'}`)
    const table = leadTable(schemaName)
    const { rows } = await database.execute(sql`select * from ${table} where ${where} order by ${order} limit ${maxRows}`)
    return (rows as unknown as LeadRow[]).map(toLead)
}

export const getLead = async (companyId: string, id: string): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyLeadTables(companyId)
    const table = leadTable(schemaName)
    const { rows } = await database.execute(sql`select * from ${table} where id = ${id} and deleted_at is null`)
    const row = rows[0] as unknown as LeadRow | undefined
    if (row === undefined) {
        throw new LeadNotFoundError('Lead not found')
    }
    return toLead(row)
}

export const updateLead = async (companyId: string, userId: string, id: string, input: Partial<LeadInput>): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyLeadTables(companyId)
    if (input.assignedExecutive) {
        await verifyExecutive(companyId, input.assignedExecutive)
    }

    // Build explicit update fields — no sql.raw(column) injection risk
    const updateFields: SQL[] = [sql`updated_at = now()`]
    if ('customerName' in input) updateFields.push(sql`customer_name = ${input.customerName ?? null}`)
    if ('mobileNumber' in input) updateFields.push(sql`mobile_number = ${input.mobileNumber ?? null}`)
    if ('email' in input) updateFields.push(sql`email = ${input.email ?? null}`)
    if ('address' in input) updateFields.push(sql`address = ${input.address ?? null}`)
    if ('monthlyBillAmount' in input) updateFields.push(sql`monthly_bill_amount = ${input.monthlyBillAmount ?? null}`)
    if ('followUpDate' in input) updateFields.push(sql`follow_up_date = ${input.followUpDate ?? null}`)
    if ('state' in input) updateFields.push(sql`state = ${input.state ?? null}`)
    if ('city' in input) updateFields.push(sql`city = ${input.city ?? null}`)
    if ('roofOwnership' in input) updateFields.push(sql`roof_ownership = ${input.roofOwnership ?? null}`)
    if ('roofType' in input) updateFields.push(sql`roof_type = ${input.roofType ?? null}`)
    if ('leadSource' in input) updateFields.push(sql`lead_source = ${input.leadSource ?? null}`)
    if ('assignedExecutive' in input) updateFields.push(sql`assigned_executive = ${input.assignedExecutive ?? null}`)
    if ('status' in input) updateFields.push(sql`status = ${input.status ?? null}`)

    if (updateFields.length === 1) {
        // Only updated_at — no real fields to update
        throw new LeadInputError('No fields to update')
    }

    const table = leadTable(schemaName)
    const aTable = activityTable(schemaName)
    const setClause = sql.join(updateFields, sql`, `)

    const { rows } = await database.execute(
        sql`update ${table} set ${setClause} where id = ${id} and deleted_at is null returning *`
    )
    const row = rows[0] as unknown as LeadRow | undefined
    if (row === undefined) {
        throw new LeadNotFoundError('Lead not found')
    }
    await database.execute(
        sql`insert into ${aTable} (lead_id, activity_type, description, performed_by) values (${id}, ${LEAD_ACTIVITY_TYPES.UPDATED}, 'Lead updated', ${userId})`
    )
    return toLead(row)
}

export const updateLeadStatus = async (companyId: string, userId: string, id: string, status: LeadStatus): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyLeadTables(companyId)
    const table = leadTable(schemaName)
    const aTable = activityTable(schemaName)
    const { rows } = await database.execute(
        sql`update ${table} set status = ${status}, updated_at = now() where id = ${id} and deleted_at is null returning *`
    )
    const row = rows[0] as unknown as LeadRow | undefined
    if (row === undefined) {
        throw new LeadNotFoundError('Lead not found')
    }
    await database.execute(
        sql`insert into ${aTable} (lead_id, activity_type, new_value, performed_by) values (${id}, ${LEAD_ACTIVITY_TYPES.STATUS_CHANGED}, ${status}, ${userId})`
    )
    return toLead(row)
}

export const assignLead = async (
    companyId: string,
    userId: string,
    id: string,
    assignedExecutive: string | undefined
): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    if (assignedExecutive) {
        parseUuid(assignedExecutive, 'assignedExecutive')
        await verifyExecutive(companyId, assignedExecutive)
    }
    const schemaName = await ensureCompanyLeadTables(companyId)
    const table = leadTable(schemaName)
    const aTable = activityTable(schemaName)
    const { rows } = await database.execute(
        sql`update ${table} set assigned_executive = ${assignedExecutive ?? null}, updated_at = now() where id = ${id} and deleted_at is null returning *`
    )
    const row = rows[0] as unknown as LeadRow | undefined
    if (row === undefined) {
        throw new LeadNotFoundError('Lead not found')
    }
    await database.execute(
        sql`insert into ${aTable} (lead_id, activity_type, new_value, performed_by) values (${id}, ${assignedExecutive ? LEAD_ACTIVITY_TYPES.ASSIGNED : LEAD_ACTIVITY_TYPES.REASSIGNED}, ${assignedExecutive ?? null}, ${userId})`
    )
    return toLead(row)
}

export const deleteLead = async (companyId: string, userId: string, id: string): Promise<void> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyLeadTables(companyId)
    const table = leadTable(schemaName)
    const aTable = activityTable(schemaName)
    const result = await database.execute(
        sql`update ${table} set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null`
    )
    if (Number(result.rowCount) === 0) {
        throw new LeadNotFoundError('Lead not found')
    }
    await database.execute(
        sql`insert into ${aTable} (lead_id, activity_type, performed_by) values (${id}, ${LEAD_ACTIVITY_TYPES.DELETED}, ${userId})`
    )
}

export const listActivities = async (
    companyId: string,
    leadId: string,
    page: number,
    limit: number
): Promise<{ data: unknown[]; total: number }> => {
    parseUuid(leadId, 'id')
    const schemaName = await ensureCompanyLeadTables(companyId)
    const table = activityTable(schemaName)
    const offset = (page - 1) * limit

    // Single CTE query — eliminates separate count round-trip
    const { rows } = await database.execute(sql`
        with filtered as (
            select *, count(*) over() as _total_count
            from ${table}
            where lead_id = ${leadId}
        )
        select * from filtered
        order by created_at desc
        limit ${limit} offset ${offset}
    `)

    const typedRows = rows as unknown as Array<{ _total_count: string | number }>
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return { data: rows as unknown[], total }
}
