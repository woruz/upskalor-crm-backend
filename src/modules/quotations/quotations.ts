import { randomUUID } from 'node:crypto'

import { sql, type SQL } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { ensureCompanyQuotationTables } from '../../database/tenants.js'

export const QUOTATION_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]

export class QuotationInputError extends Error { }
export class QuotationNotFoundError extends Error { }
export class QuotationReferenceError extends Error { }

export interface QuotationItemInput {
    productId?: string | undefined
    name: string
    brand?: string | undefined
    quantity: number
    rate: number
    gstRate: number
    total?: number | undefined
    sortOrder?: number | undefined
}

export interface QuotationInput {
    leadId?: string | undefined
    quoteNumber?: string | undefined
    systemSizeKw: number
    validityDate: Date
    paymentTermsTemplate: string
    advancePercentage: number
    deliveryPercentage: number
    commissioningPercentage: number
    stateSubsidyCapOverride?: number | undefined
    leadState?: string | undefined
    subtotal: number
    totalGst: number
    grandTotal: number
    centralSubsidy: number
    stateSubsidy: number
    netCustomerCost: number
    status: QuotationStatus
    notes?: string | undefined
    items: QuotationItemInput[]
}

export interface QuotationFilters {
    page: number
    limit: number
    search?: string | undefined
    leadId?: string | undefined
    status?: QuotationStatus | undefined
    sort: 'createdAt' | 'validityDate' | 'quoteNumber' | 'systemSizeKw' | 'grandTotal'
    direction: 'asc' | 'desc'
}

interface QuotationRow {
    id: string
    lead_id: string | null
    quote_number: string
    system_size_kw: string | number
    validity_date: Date | string
    payment_terms_template: string
    advance_percentage: string | number
    delivery_percentage: string | number
    commissioning_percentage: string | number
    state_subsidy_cap_override: string | number | null
    lead_state: string | null
    subtotal: string | number
    total_gst: string | number
    grand_total: string | number
    central_subsidy: string | number
    state_subsidy: string | number
    net_customer_cost: string | number
    status: QuotationStatus
    notes: string | null
    created_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
    lead_customer_name?: string | null
    lead_mobile_number?: string | null
}

interface QuotationRowWithCount extends QuotationRow {
    _total_count: string | number
}

interface QuotationItemRow {
    id: string
    quotation_id: string
    product_id: string | null
    name: string
    brand: string | null
    quantity: string | number
    rate: string | number
    gst_rate: string | number
    total: string | number
    sort_order: number
    created_at: Date | string
    updated_at: Date | string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PAGE_SIZE = 100

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const roundToTwo = (num: number): number => Math.round((num + Number.EPSILON) * 100) / 100

const requiredText = (value: unknown, field: string, maxLength: number, minLength = 1): string => {
    if (typeof value !== 'string') {
        throw new QuotationInputError(`${field} must be a string`)
    }

    const normalized = value.trim()
    if (normalized.length < minLength || normalized.length > maxLength) {
        throw new QuotationInputError(`${field} must be between ${minLength} and ${maxLength} characters`)
    }

    return normalized
}

const optionalText = (value: unknown, field: string, maxLength: number): string | undefined => {
    if (value === undefined || value === null || value === '') {
        return undefined
    }
    return requiredText(value, field, maxLength)
}

const parseDate = (value: unknown, field: string): Date => {
    if (typeof value !== 'string' && !(value instanceof Date)) {
        throw new QuotationInputError(`${field} must be a valid date`)
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        throw new QuotationInputError(`${field} must be a valid date`)
    }
    return date
}

const parseStatus = (value: unknown): QuotationStatus => {
    if (typeof value !== 'string' || !QUOTATION_STATUSES.includes(value.trim().toUpperCase() as QuotationStatus)) {
        throw new QuotationInputError('status is invalid')
    }
    return value.trim().toUpperCase() as QuotationStatus
}

const parsePositiveNumber = (value: unknown, field: string, allowZero = false, max = 9999999999.99): number => {
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
    if (!Number.isFinite(num) || (allowZero ? num < 0 : num <= 0) || num > max) {
        throw new QuotationInputError(`${field} must be a positive number`)
    }
    return roundToTwo(num)
}

const parsePercentage = (value: unknown, field: string, fallback: number): number => {
    if (value === undefined || value === null || value === '') {
        return fallback
    }
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
    if (!Number.isFinite(num) || num < 0 || num > 100) {
        throw new QuotationInputError(`${field} must be a percentage between 0 and 100`)
    }
    return roundToTwo(num)
}

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new QuotationInputError(`${field} is invalid`)
    }
    return value
}

export const parseQuotationItem = (item: unknown): QuotationItemInput => {
    if (!isRecord(item)) {
        throw new QuotationInputError('Item must be a JSON object')
    }

    const name = requiredText(item['name'], 'name', 200, 1)
    const brand = optionalText(item['brand'], 'brand', 150)
    const quantity = parsePositiveNumber(item['quantity'] ?? 1, 'quantity', false, 100000)
    const rate = parsePositiveNumber(item['rate'], 'rate', true)
    const gstRate = parsePercentage(item['gstRate'], 'gstRate', 0)

    let productId: string | undefined
    if (item['productId'] !== undefined && item['productId'] !== null && item['productId'] !== '') {
        productId = parseUuid(requiredText(item['productId'], 'productId', 36), 'productId')
    }

    const preTax = roundToTwo(quantity * rate)
    const gstAmount = roundToTwo((preTax * gstRate) / 100)
    const calculatedTotal = roundToTwo(preTax + gstAmount)

    const total = item['total'] !== undefined ? parsePositiveNumber(item['total'], 'total', true) : calculatedTotal

    const sortOrder =
        typeof item['sortOrder'] === 'number' && Number.isSafeInteger(item['sortOrder']) && item['sortOrder'] >= 0 ? item['sortOrder'] : 0

    return {
        productId,
        name,
        brand,
        quantity,
        rate,
        gstRate,
        total,
        sortOrder
    }
}

export const calculateFinancialSummary = (
    items: QuotationItemInput[],
    centralSubsidy = 0,
    stateSubsidy = 0
): {
    subtotal: number
    totalGst: number
    grandTotal: number
    centralSubsidy: number
    stateSubsidy: number
    netCustomerCost: number
} => {
    let subtotal = 0
    let totalGst = 0

    for (const item of items) {
        const itemPreTax = roundToTwo(item.quantity * item.rate)
        const itemGst = roundToTwo((itemPreTax * item.gstRate) / 100)
        subtotal += itemPreTax
        totalGst += itemGst
    }

    subtotal = roundToTwo(subtotal)
    totalGst = roundToTwo(totalGst)
    const grandTotal = roundToTwo(subtotal + totalGst)
    const netCustomerCost = roundToTwo(Math.max(0, grandTotal - centralSubsidy - stateSubsidy))

    return {
        subtotal,
        totalGst,
        grandTotal,
        centralSubsidy: roundToTwo(centralSubsidy),
        stateSubsidy: roundToTwo(stateSubsidy),
        netCustomerCost
    }
}

export const parseQuotationInput = (body: unknown, partial = false): Partial<QuotationInput> => {
    if (!isRecord(body)) {
        throw new QuotationInputError('Request body must be a JSON object')
    }

    const result: Partial<QuotationInput> = {}

    if (body['leadId'] !== undefined && body['leadId'] !== null && body['leadId'] !== '') {
        result.leadId = parseUuid(requiredText(body['leadId'], 'leadId', 36), 'leadId')
    } else if (partial && body['leadId'] !== undefined) {
        result.leadId = undefined
    }

    if (body['quoteNumber'] !== undefined && body['quoteNumber'] !== null && body['quoteNumber'] !== '') {
        result.quoteNumber = requiredText(body['quoteNumber'], 'quoteNumber', 50)
    }

    if (!partial || body['systemSizeKw'] !== undefined) {
        result.systemSizeKw = parsePositiveNumber(body['systemSizeKw'], 'systemSizeKw', false, 100000)
    }

    if (!partial || body['validityDate'] !== undefined) {
        result.validityDate = parseDate(body['validityDate'], 'validityDate')
    }

    if (!partial || body['paymentTermsTemplate'] !== undefined) {
        result.paymentTermsTemplate = optionalText(body['paymentTermsTemplate'], 'paymentTermsTemplate', 100) ?? 'Custom Terms'
    }

    if (!partial || body['advancePercentage'] !== undefined) {
        result.advancePercentage = parsePercentage(body['advancePercentage'], 'advancePercentage', 30)
    }

    if (!partial || body['deliveryPercentage'] !== undefined) {
        result.deliveryPercentage = parsePercentage(body['deliveryPercentage'], 'deliveryPercentage', 50)
    }

    if (!partial || body['commissioningPercentage'] !== undefined) {
        result.commissioningPercentage = parsePercentage(body['commissioningPercentage'], 'commissioningPercentage', 20)
    }

    if (body['stateSubsidyCapOverride'] !== undefined && body['stateSubsidyCapOverride'] !== null && body['stateSubsidyCapOverride'] !== '') {
        result.stateSubsidyCapOverride = parsePositiveNumber(body['stateSubsidyCapOverride'], 'stateSubsidyCapOverride', true)
    }

    if (body['leadState'] !== undefined) {
        result.leadState = optionalText(body['leadState'], 'leadState', 100)
    }

    if (body['notes'] !== undefined) {
        result.notes = optionalText(body['notes'], 'notes', 2000)
    }

    if (body['status'] !== undefined) {
        result.status = parseStatus(body['status'])
    } else if (!partial) {
        result.status = 'DRAFT'
    }

    const centralSubsidy = body['centralSubsidy'] !== undefined ? parsePositiveNumber(body['centralSubsidy'], 'centralSubsidy', true) : 0
    const stateSubsidy = body['stateSubsidy'] !== undefined ? parsePositiveNumber(body['stateSubsidy'], 'stateSubsidy', true) : 0

    if (Array.isArray(body['items'])) {
        const parsedItems = body['items'].map((item) => parseQuotationItem(item))
        result.items = parsedItems

        const summary = calculateFinancialSummary(parsedItems, centralSubsidy, stateSubsidy)
        result.subtotal = summary.subtotal
        result.totalGst = summary.totalGst
        result.grandTotal = summary.grandTotal
        result.centralSubsidy = summary.centralSubsidy
        result.stateSubsidy = summary.stateSubsidy
        result.netCustomerCost = summary.netCustomerCost
    } else {
        if (!partial) {
            result.items = []
        }
        if (body['subtotal'] !== undefined) {
            result.subtotal = parsePositiveNumber(body['subtotal'], 'subtotal', true)
        } else if (!partial) {
            result.subtotal = 0
        }
        if (body['totalGst'] !== undefined) {
            result.totalGst = parsePositiveNumber(body['totalGst'], 'totalGst', true)
        } else if (!partial) {
            result.totalGst = 0
        }
        if (body['grandTotal'] !== undefined) {
            result.grandTotal = parsePositiveNumber(body['grandTotal'], 'grandTotal', true)
        } else if (!partial) {
            result.grandTotal = roundToTwo((result.subtotal ?? 0) + (result.totalGst ?? 0))
        }
        result.centralSubsidy = roundToTwo(centralSubsidy)
        result.stateSubsidy = roundToTwo(stateSubsidy)
        if (body['netCustomerCost'] !== undefined) {
            result.netCustomerCost = parsePositiveNumber(body['netCustomerCost'], 'netCustomerCost', true)
        } else if (!partial) {
            result.netCustomerCost = roundToTwo(Math.max(0, (result.grandTotal ?? 0) - result.centralSubsidy - result.stateSubsidy))
        }
    }

    return result
}

export const parseQuotationFilters = (url: URL): QuotationFilters => {
    const numberParam = (name: string, fallback: number): number => {
        const value = Number(url.searchParams.get(name) ?? fallback)
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new QuotationInputError(`${name} must be a positive integer`)
        }
        return value
    }

    const sort = url.searchParams.get('sort') ?? 'createdAt'
    if (!['createdAt', 'validityDate', 'quoteNumber', 'systemSizeKw', 'grandTotal'].includes(sort)) {
        throw new QuotationInputError('sort is invalid')
    }

    const direction = url.searchParams.get('direction') ?? 'desc'
    if (direction !== 'asc' && direction !== 'desc') {
        throw new QuotationInputError('direction is invalid')
    }

    const limit = numberParam('limit', 20)
    if (limit > MAX_PAGE_SIZE) {
        throw new QuotationInputError(`limit must be at most ${MAX_PAGE_SIZE}`)
    }

    const filters: QuotationFilters = {
        page: numberParam('page', 1),
        limit,
        sort: sort as QuotationFilters['sort'],
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

    const leadId = url.searchParams.get('leadId')?.trim()
    if (leadId) {
        filters.leadId = parseUuid(leadId, 'leadId')
    }

    return filters
}

// ─── Table reference helpers ─────────────────────────────────────────────────

const quotationTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".quotations`)
const quotationItemTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".quotation_items`)
const leadTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".leads`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

// ─── Quote number generation ─────────────────────────────────────────────────

const generateNextQuoteNumber = async (schemaName: string, year: number): Promise<string> => {
    const prefix = `QT-${year}-`
    const { rows } = await database.execute(
        sql`select quote_number from ${quotationTable(schemaName)} where quote_number like ${`${prefix}%`} order by quote_number desc limit 1`
    )

    const lastQuoteNumber = rows[0]?.['quote_number'] as string | undefined
    let nextSeq = 1

    if (lastQuoteNumber && lastQuoteNumber.startsWith(prefix)) {
        const seqPart = lastQuoteNumber.slice(prefix.length)
        const parsed = parseInt(seqPart, 10)
        if (!Number.isNaN(parsed)) {
            nextSeq = parsed + 1
        }
    }

    return `${prefix}${String(nextSeq).padStart(4, '0')}`
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

const toQuotationItem = (row: QuotationItemRow): Record<string, unknown> => ({
    id: row.id,
    quotationId: row.quotation_id,
    productId: row.product_id,
    name: row.name,
    brand: row.brand,
    quantity: Number(row.quantity),
    rate: Number(row.rate),
    gstRate: Number(row.gst_rate),
    total: Number(row.total),
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
})

const toQuotation = (row: QuotationRow, items?: QuotationItemRow[]): Record<string, unknown> => {
    const quotation: Record<string, unknown> = {
        id: row.id,
        leadId: row.lead_id,
        quoteNumber: row.quote_number,
        systemSizeKw: Number(row.system_size_kw),
        validityDate: new Date(row.validity_date).toISOString(),
        paymentTermsTemplate: row.payment_terms_template,
        advancePercentage: Number(row.advance_percentage),
        deliveryPercentage: Number(row.delivery_percentage),
        commissioningPercentage: Number(row.commissioning_percentage),
        stateSubsidyCapOverride: row.state_subsidy_cap_override === null ? null : Number(row.state_subsidy_cap_override),
        leadState: row.lead_state,
        subtotal: Number(row.subtotal),
        totalGst: Number(row.total_gst),
        grandTotal: Number(row.grand_total),
        centralSubsidy: Number(row.central_subsidy),
        stateSubsidy: Number(row.state_subsidy),
        netCustomerCost: Number(row.net_customer_cost),
        status: row.status,
        notes: row.notes,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (row.lead_customer_name !== undefined) {
        quotation['lead'] = row.lead_id
            ? {
                id: row.lead_id,
                customerName: row.lead_customer_name,
                mobileNumber: row.lead_mobile_number
            }
            : null
    }

    if (items !== undefined) {
        quotation['items'] = items.map(toQuotationItem)
    }

    return quotation
}

// ─── Bulk item insert helper ─────────────────────────────────────────────────

/**
 * Inserts all line items in a single bulk INSERT statement rather than
 * N sequential round-trips. This cuts item insertion from O(n) DB calls to 1.
 */
const bulkInsertItems = async (
    tx: Pick<typeof database, 'execute'>,
    schemaName: string,
    quotationId: string,
    items: QuotationItemInput[]
): Promise<QuotationItemRow[]> => {
    if (items.length === 0) return []

    const iTable = quotationItemTable(schemaName)
    const valueParts: SQL[] = items.map((item, i) =>
        sql`(${randomUUID()}, ${quotationId}, ${item.productId ?? null}, ${item.name}, ${item.brand ?? null}, ${item.quantity}, ${item.rate}, ${item.gstRate}, ${item.total ?? roundToTwo(item.quantity * item.rate * (1 + item.gstRate / 100))}, ${item.sortOrder ?? i})`
    )

    const { rows } = await tx.execute(sql`
        insert into ${iTable}
        (id, quotation_id, product_id, name, brand, quantity, rate, gst_rate, total, sort_order)
        values ${sql.join(valueParts, sql`, `)}
        returning *
    `)

    return rows as unknown as QuotationItemRow[]
}

// ─── Service functions ───────────────────────────────────────────────────────

export const createQuotation = async (companyId: string, userId: string, input: QuotationInput): Promise<Record<string, unknown>> => {
    const schemaName = await ensureCompanyQuotationTables(companyId)
    const qTable = quotationTable(schemaName)
    const lTable = leadTable(schemaName)
    const aTable = activityTable(schemaName)

    let leadState = input.leadState
    if (input.leadId) {
        const { rows } = await database.execute(
            sql`select id, state from ${lTable} where id = ${input.leadId} and deleted_at is null limit 1`
        )
        const lead = rows[0]
        if (lead === undefined) {
            throw new QuotationReferenceError('leadId is invalid or lead does not exist')
        }
        if (!leadState && typeof lead['state'] === 'string') {
            leadState = lead['state']
        }
    }

    const currentYear = input.validityDate.getFullYear() || new Date().getFullYear()
    const quoteNumber = input.quoteNumber || (await generateNextQuoteNumber(schemaName, currentYear))
    const quotationId = randomUUID()

    return database.transaction(async (tx) => {
        const { rows: createRows } = await tx.execute(sql`
            insert into ${qTable}
            (id, lead_id, quote_number, system_size_kw, validity_date, payment_terms_template, advance_percentage, delivery_percentage, commissioning_percentage, state_subsidy_cap_override, lead_state, subtotal, total_gst, grand_total, central_subsidy, state_subsidy, net_customer_cost, status, notes, created_by)
            values (
                ${quotationId},
                ${input.leadId ?? null},
                ${quoteNumber},
                ${input.systemSizeKw},
                ${input.validityDate},
                ${input.paymentTermsTemplate},
                ${input.advancePercentage},
                ${input.deliveryPercentage},
                ${input.commissioningPercentage},
                ${input.stateSubsidyCapOverride ?? null},
                ${leadState ?? null},
                ${input.subtotal},
                ${input.totalGst},
                ${input.grandTotal},
                ${input.centralSubsidy},
                ${input.stateSubsidy},
                ${input.netCustomerCost},
                ${input.status},
                ${input.notes ?? null},
                ${userId}
            ) returning *
        `)

        const row = createRows[0] as unknown as QuotationRow | undefined
        if (row === undefined) {
            throw new Error('Quotation creation failed')
        }

        // Bulk insert all items in a single statement
        const insertedItems = await bulkInsertItems(tx, schemaName, quotationId, input.items)

        if (input.leadId) {
            await tx.execute(
                sql`insert into ${aTable} (lead_id, activity_type, description, performed_by) values (${input.leadId}, 'QUOTATION_CREATED', ${`Quotation ${quoteNumber} created`}, ${userId})`
            )
        }

        return toQuotation(row, insertedItems)
    })
}

export const listQuotations = async (
    companyId: string,
    filters: QuotationFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyQuotationTables(companyId)
    const qTable = quotationTable(schemaName)
    const lTable = leadTable(schemaName)

    const conditions: SQL[] = [sql`q.deleted_at is null`]

    if (filters.search) {
        conditions.push(sql`(q.quote_number ilike ${`%${filters.search}%`} or l.customer_name ilike ${`%${filters.search}%`})`)
    }
    if (filters.status) conditions.push(sql`q.status = ${filters.status}`)
    if (filters.leadId) conditions.push(sql`q.lead_id = ${filters.leadId}`)

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        createdAt: 'q.created_at',
        validityDate: 'q.validity_date',
        quoteNumber: 'q.quote_number',
        systemSizeKw: 'q.system_size_kw',
        grandTotal: 'q.grand_total'
    } as const
    // Safe: sortColumns keys are statically constrained by QuotationFilters['sort'] type
    const order = sql.raw(`${sortColumns[filters.sort]} ${filters.direction === 'asc' ? 'asc' : 'desc'}`)
    const offset = (filters.page - 1) * filters.limit

    // Single CTE query with window function — eliminates the separate count round-trip
    const { rows } = await database.execute(sql`
        with filtered as (
            select q.*, l.customer_name as lead_customer_name, l.mobile_number as lead_mobile_number,
                   count(*) over() as _total_count
            from ${qTable} q
            left join ${lTable} l on l.id = q.lead_id
            where ${where}
        )
        select * from filtered
        order by ${order}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as QuotationRowWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return {
        data: typedRows.map((r) => toQuotation(r)),
        total
    }
}

export const getQuotation = async (companyId: string, id: string): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyQuotationTables(companyId)
    const qTable = quotationTable(schemaName)
    const lTable = leadTable(schemaName)
    const iTable = quotationItemTable(schemaName)

    const { rows } = await database.execute(
        sql`select q.*, l.customer_name as lead_customer_name, l.mobile_number as lead_mobile_number from ${qTable} q left join ${lTable} l on l.id = q.lead_id where q.id = ${id} and q.deleted_at is null`
    )

    const row = rows[0] as unknown as QuotationRow | undefined
    if (row === undefined) {
        throw new QuotationNotFoundError('Quotation not found')
    }

    const { rows: itemRows } = await database.execute(
        sql`select * from ${iTable} where quotation_id = ${id} order by sort_order asc, created_at asc`
    )

    return toQuotation(row, itemRows as unknown as QuotationItemRow[])
}

export const updateQuotation = async (
    companyId: string,
    userId: string,
    id: string,
    input: Partial<QuotationInput>
): Promise<Record<string, unknown>> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyQuotationTables(companyId)
    const qTable = quotationTable(schemaName)
    const iTable = quotationItemTable(schemaName)
    const lTable = leadTable(schemaName)
    const aTable = activityTable(schemaName)

    const existing = await getQuotation(companyId, id)

    if (input.leadId !== undefined && input.leadId !== existing['leadId']) {
        if (input.leadId !== null) {
            const { rows } = await database.execute(
                sql`select id from ${lTable} where id = ${input.leadId} and deleted_at is null limit 1`
            )
            if (rows[0] === undefined) {
                throw new QuotationReferenceError('leadId is invalid or lead does not exist')
            }
        }
    }

    return database.transaction(async (tx) => {
        let itemsToReturn: QuotationItemRow[] | undefined

        if (input.items !== undefined) {
            await tx.execute(sql`delete from ${iTable} where quotation_id = ${id}`)
            // Bulk re-insert updated items
            itemsToReturn = await bulkInsertItems(tx, schemaName, id, input.items)
        }

        const updateFields: SQL[] = [sql`updated_at = now()`]

        if (input.leadId !== undefined) updateFields.push(sql`lead_id = ${input.leadId}`)
        if (input.systemSizeKw !== undefined) updateFields.push(sql`system_size_kw = ${input.systemSizeKw}`)
        if (input.validityDate !== undefined) updateFields.push(sql`validity_date = ${input.validityDate}`)
        if (input.paymentTermsTemplate !== undefined) updateFields.push(sql`payment_terms_template = ${input.paymentTermsTemplate}`)
        if (input.advancePercentage !== undefined) updateFields.push(sql`advance_percentage = ${input.advancePercentage}`)
        if (input.deliveryPercentage !== undefined) updateFields.push(sql`delivery_percentage = ${input.deliveryPercentage}`)
        if (input.commissioningPercentage !== undefined) updateFields.push(sql`commissioning_percentage = ${input.commissioningPercentage}`)
        if (input.stateSubsidyCapOverride !== undefined) updateFields.push(sql`state_subsidy_cap_override = ${input.stateSubsidyCapOverride}`)
        if (input.leadState !== undefined) updateFields.push(sql`lead_state = ${input.leadState}`)
        if (input.subtotal !== undefined) updateFields.push(sql`subtotal = ${input.subtotal}`)
        if (input.totalGst !== undefined) updateFields.push(sql`total_gst = ${input.totalGst}`)
        if (input.grandTotal !== undefined) updateFields.push(sql`grand_total = ${input.grandTotal}`)
        if (input.centralSubsidy !== undefined) updateFields.push(sql`central_subsidy = ${input.centralSubsidy}`)
        if (input.stateSubsidy !== undefined) updateFields.push(sql`state_subsidy = ${input.stateSubsidy}`)
        if (input.netCustomerCost !== undefined) updateFields.push(sql`net_customer_cost = ${input.netCustomerCost}`)
        if (input.status !== undefined) updateFields.push(sql`status = ${input.status}`)
        if (input.notes !== undefined) updateFields.push(sql`notes = ${input.notes}`)

        const setClause = sql.join(updateFields, sql`, `)
        const { rows: updateRows } = await tx.execute(sql`
            update ${qTable} set ${setClause} where id = ${id} and deleted_at is null returning *
        `)

        const row = updateRows[0] as unknown as QuotationRow | undefined
        if (row === undefined) {
            throw new QuotationNotFoundError('Quotation not found')
        }

        if (itemsToReturn === undefined) {
            const { rows: currentItems } = await tx.execute(
                sql`select * from ${iTable} where quotation_id = ${id} order by sort_order asc, created_at asc`
            )
            itemsToReturn = currentItems as unknown as QuotationItemRow[]
        }

        // Log update activity against the lead
        if (existing['leadId']) {
            await tx.execute(
                sql`insert into ${aTable} (lead_id, activity_type, description, performed_by) values (${existing['leadId'] as string}, 'QUOTATION_UPDATED', ${`Quotation ${existing['quoteNumber'] as string} updated`}, ${userId})`
            )
        }

        return toQuotation(row, itemsToReturn)
    })
}

export const deleteQuotation = async (companyId: string, userId: string, id: string): Promise<void> => {
    parseUuid(id, 'id')
    const schemaName = await ensureCompanyQuotationTables(companyId)
    const qTable = quotationTable(schemaName)
    const aTable = activityTable(schemaName)

    const existing = await getQuotation(companyId, id)

    await database.execute(sql`
        update ${qTable} set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null
    `)

    if (existing['leadId']) {
        await database.execute(
            sql`insert into ${aTable} (lead_id, activity_type, description, performed_by) values (${existing['leadId'] as string}, 'QUOTATION_DELETED', ${`Quotation ${existing['quoteNumber'] as string} deleted`}, ${userId})`
        )
    }
}
