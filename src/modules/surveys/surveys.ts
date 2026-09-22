import { randomUUID } from 'node:crypto'

import { eq, and, sql, type SQL } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { ensureCompanySurveyTables } from '../../database/tenants.js'
import { ROLE_NAMES, type RoleName } from '../auth/rbac.js'
import { LEAD_ACTIVITY_TYPES } from '../leads/leads.js'

export const SURVEY_STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'] as const
export type SurveyStatus = (typeof SURVEY_STATUSES)[number]

export const SHADING_OPTIONS = ['None', 'Partial', 'Heavy'] as const
export type ShadingOption = (typeof SHADING_OPTIONS)[number]

export const CONNECTION_TYPES = ['Three-phase', 'Single-phase'] as const
export type ConnectionType = (typeof CONNECTION_TYPES)[number]

const MAX_PAGE_SIZE = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class SurveyInputError extends Error {
    constructor(
        message: string,
        public readonly details?: Record<string, string[]>
    ) {
        super(message)
    }
}

export class SurveyNotFoundError extends Error {
    constructor(message = 'Survey not found') {
        super(message)
    }
}

export class SurveyConflictError extends Error {
    constructor(message: string) {
        super(message)
    }
}

export class SurveyForbiddenError extends Error {
    constructor(message: string) {
        super(message)
    }
}

export interface SurveyInput {
    leadId?: string | undefined
    customerName: string
    mobileNumber: string
    address?: string | undefined
    surveyDateTime: Date
    assignedTechId?: string | undefined
    assignedTech?: string | undefined
    notes?: string | undefined
    roofAreaSqft?: number | undefined
    shading?: ShadingOption | undefined
    connectionType?: ConnectionType | undefined
    sanctionedLoadKw?: number | undefined
    monthlyConsumptionKwh?: number | undefined
    recommendedKw?: number | undefined
    latitude?: string | undefined
    longitude?: string | undefined
}

export interface SurveyFilters {
    page: number
    limit: number
    search?: string | undefined
    status?: SurveyStatus | undefined
    assignedTechId?: string | undefined
    leadId?: string | undefined
    dateFrom?: Date | undefined
    dateTo?: Date | undefined
    sort: 'surveyDateTime' | 'createdAt' | 'customerName'
    direction: 'asc' | 'desc'
    viewAll?: boolean | undefined
}

export interface SurveyPhotoInput {
    fileUrl: string
    fileName: string
    fileSizeBytes?: number | undefined
    mimeType?: string | undefined
}

interface SurveyRow {
    id: string
    lead_id: string | null
    customer_name: string
    mobile_number: string
    address: string | null
    survey_date_time: Date | string
    assigned_tech_id: string | null
    assigned_tech: string
    status: SurveyStatus
    roof_area_sqft: string | number | null
    shading: ShadingOption | null
    connection_type: ConnectionType | null
    sanctioned_load_kw: string | number | null
    monthly_consumption_kwh: string | number | null
    recommended_kw: string | number | null
    latitude: string | null
    longitude: string | null
    notes: string | null
    created_by: string
    created_at: Date | string
    updated_at: Date | string
    deleted_at: Date | string | null
    lead_customer_name?: string | null
    lead_mobile_number?: string | null
    lead_city?: string | null
    lead_state?: string | null
    lead_monthly_bill_amount?: string | number | null
    lead_status?: string | null
}

interface SurveyRowWithCount extends SurveyRow {
    _total_count: string | number
}

interface SurveyPhotoRow {
    id: string
    survey_id: string
    file_url: string
    file_name: string
    file_size_bytes: number | null
    mime_type: string | null
    uploaded_by: string | null
    created_at: Date | string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const parseUuid = (value: string, field: string): string => {
    if (!UUID_PATTERN.test(value)) {
        throw new SurveyInputError(`${field} is invalid`, { [field]: [`${field} must be a valid UUID`] })
    }
    return value
}

const parseDate = (value: unknown, field: string): Date => {
    if (typeof value !== 'string' && !(value instanceof Date)) {
        throw new SurveyInputError(`${field} must be a valid ISO 8601 date string`, {
            [field]: [`${field} must be a valid ISO 8601 date string`]
        })
    }
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        throw new SurveyInputError(`${field} is invalid`, {
            [field]: [`${field} must be a valid date`]
        })
    }
    return parsed
}

const parseNonNegativeNumber = (value: unknown, field: string, max = 100000000): number | undefined => {
    if (value === undefined || value === null || value === '') {
        return undefined
    }
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
    if (!Number.isFinite(num) || num < 0 || num > max) {
        throw new SurveyInputError(`${field} must be a non-negative number`, {
            [field]: [`${field} must be between 0 and ${max}`]
        })
    }
    return Math.round(num * 100) / 100
}

const parseCoordinate = (value: unknown, field: 'latitude' | 'longitude'): string | undefined => {
    if (value === undefined || value === null || value === '') {
        return undefined
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new SurveyInputError(`${field} is invalid`, { [field]: [`${field} must be a valid coordinate string`] })
    }
    const coordStr = String(value).trim()
    const num = Number(coordStr)
    const max = field === 'latitude' ? 90 : 180
    if (!Number.isFinite(num) || num < -max || num > max) {
        throw new SurveyInputError(`${field} must be between -${max} and ${max}`, {
            [field]: [`${field} must be between -${max} and ${max}`]
        })
    }
    return coordStr
}

export const parseSurveyInput = (body: unknown, partial = false): Partial<SurveyInput> => {
    if (!isRecord(body)) {
        throw new SurveyInputError('Request body must be a JSON object')
    }

    const result: Partial<SurveyInput> = {}
    const errors: Record<string, string[]> = {}

    if (body['leadId'] !== undefined && body['leadId'] !== null && body['leadId'] !== '') {
        try {
            result.leadId = parseUuid(String(body['leadId']).trim(), 'leadId')
        } catch {
            errors['leadId'] = ['leadId must be a valid UUID']
        }
    } else if (partial && body['leadId'] === null) {
        result.leadId = undefined
    }

    if (!partial || body['customerName'] !== undefined) {
        const val = typeof body['customerName'] === 'string' ? body['customerName'].trim() : ''
        if (!partial && !val && !result.leadId) {
            errors['customerName'] = ['customerName is required when not linked to a lead']
        } else if (val) {
            if (val.length > 150) {
                errors['customerName'] = ['customerName must not exceed 150 characters']
            } else {
                result.customerName = val
            }
        }
    }

    if (!partial || body['mobileNumber'] !== undefined) {
        const rawPhone = typeof body['mobileNumber'] === 'string' ? body['mobileNumber'].trim() : ''
        const strippedPhone = rawPhone.replace(/[\s-]/g, '')
        if (!partial && !strippedPhone && !result.leadId) {
            errors['mobileNumber'] = ['mobileNumber is required when not linked to a lead']
        } else if (strippedPhone) {
            const digits = strippedPhone.replace(/\D/g, '')
            if (digits.length < 10 || strippedPhone.length > 30) {
                errors['mobileNumber'] = ['mobileNumber must contain at least 10 digits and at most 30 characters']
            } else {
                result.mobileNumber = strippedPhone
            }
        }
    }

    if (!partial || body['surveyDateTime'] !== undefined) {
        try {
            result.surveyDateTime = parseDate(body['surveyDateTime'], 'surveyDateTime')
        } catch (err) {
            if (err instanceof SurveyInputError && err.details) {
                Object.assign(errors, err.details)
            } else {
                errors['surveyDateTime'] = ['surveyDateTime must be a valid ISO 8601 date']
            }
        }
    }

    if (body['address'] !== undefined) {
        result.address = typeof body['address'] === 'string' ? body['address'].trim() : ''
    }

    if (body['assignedTechId'] !== undefined && body['assignedTechId'] !== null && body['assignedTechId'] !== '') {
        try {
            result.assignedTechId = parseUuid(String(body['assignedTechId']).trim(), 'assignedTechId')
        } catch {
            errors['assignedTechId'] = ['assignedTechId must be a valid UUID']
        }
    } else if (partial && (body['assignedTechId'] === null || body['assignedTechId'] === '')) {
        result.assignedTechId = undefined
    }

    if (body['assignedTech'] !== undefined) {
        result.assignedTech = typeof body['assignedTech'] === 'string' ? body['assignedTech'].trim() : 'Unassigned'
    }

    if (body['notes'] !== undefined) {
        result.notes = typeof body['notes'] === 'string' ? body['notes'].trim() : ''
    }

    if (body['shading'] !== undefined && body['shading'] !== null && body['shading'] !== '') {
        const shadingVal = String(body['shading']).trim() as ShadingOption
        if (!SHADING_OPTIONS.includes(shadingVal)) {
            errors['shading'] = [`shading must be one of: ${SHADING_OPTIONS.join(', ')}`]
        } else {
            result.shading = shadingVal
        }
    }

    if (body['connectionType'] !== undefined && body['connectionType'] !== null && body['connectionType'] !== '') {
        const connVal = String(body['connectionType']).trim() as ConnectionType
        if (!CONNECTION_TYPES.includes(connVal)) {
            errors['connectionType'] = [`connectionType must be one of: ${CONNECTION_TYPES.join(', ')}`]
        } else {
            result.connectionType = connVal
        }
    }

    for (const numField of ['roofAreaSqft', 'sanctionedLoadKw', 'monthlyConsumptionKwh', 'recommendedKw'] as const) {
        if (body[numField] !== undefined) {
            try {
                result[numField] = parseNonNegativeNumber(body[numField], numField)
            } catch (err) {
                if (err instanceof SurveyInputError && err.details) {
                    Object.assign(errors, err.details)
                }
            }
        }
    }

    for (const coordField of ['latitude', 'longitude'] as const) {
        if (body[coordField] !== undefined) {
            try {
                result[coordField] = parseCoordinate(body[coordField], coordField)
            } catch (err) {
                if (err instanceof SurveyInputError && err.details) {
                    Object.assign(errors, err.details)
                }
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        throw new SurveyInputError('Survey validation failed', errors)
    }

    return result
}

export const parseSurveyFilters = (
    url: URL,
    userRole?: RoleName,
    userId?: string
): SurveyFilters => {
    const numberParam = (name: string, fallback: number): number => {
        const value = Number(url.searchParams.get(name) ?? fallback)
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new SurveyInputError(`${name} must be a positive integer`, {
                [name]: [`${name} must be a positive integer`]
            })
        }
        return value
    }

    const sort = url.searchParams.get('sort') ?? 'surveyDateTime'
    if (!['surveyDateTime', 'createdAt', 'customerName'].includes(sort)) {
        throw new SurveyInputError('sort is invalid', { sort: ['sort must be surveyDateTime, createdAt, or customerName'] })
    }

    const direction = url.searchParams.get('direction') ?? 'desc'
    if (direction !== 'asc' && direction !== 'desc') {
        throw new SurveyInputError('direction is invalid', { direction: ['direction must be asc or desc'] })
    }

    const limit = numberParam('limit', 20)
    if (limit > MAX_PAGE_SIZE) {
        throw new SurveyInputError(`limit must be at most ${MAX_PAGE_SIZE}`, {
            limit: [`limit must be at most ${MAX_PAGE_SIZE}`]
        })
    }

    const filters: SurveyFilters = {
        page: numberParam('page', 1),
        limit,
        sort: sort as SurveyFilters['sort'],
        direction
    }

    const search = url.searchParams.get('search')?.trim()
    if (search) {
        filters.search = search
    }

    const status = url.searchParams.get('status')?.trim()
    if (status) {
        if (!SURVEY_STATUSES.includes(status as SurveyStatus)) {
            throw new SurveyInputError('status is invalid', {
                status: [`status must be one of: ${SURVEY_STATUSES.join(', ')}`]
            })
        }
        filters.status = status as SurveyStatus
    }

    const leadId = url.searchParams.get('leadId')?.trim()
    if (leadId) {
        filters.leadId = parseUuid(leadId, 'leadId')
    }

    const assignedTechId = url.searchParams.get('assignedTechId')?.trim()
    if (assignedTechId) {
        if (assignedTechId.toLowerCase() === 'unassigned') {
            filters.assignedTechId = 'Unassigned'
        } else {
            filters.assignedTechId = parseUuid(assignedTechId, 'assignedTechId')
        }
    }

    const dateFrom = url.searchParams.get('dateFrom')?.trim()
    if (dateFrom) {
        filters.dateFrom = parseDate(dateFrom, 'dateFrom')
    }

    const dateTo = url.searchParams.get('dateTo')?.trim()
    if (dateTo) {
        filters.dateTo = parseDate(dateTo, 'dateTo')
    }

    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
        throw new SurveyInputError('dateFrom must be before dateTo', {
            dateFrom: ['dateFrom must be before dateTo']
        })
    }

    const viewAllParam = url.searchParams.get('viewAll')
    const viewAll = viewAllParam === 'true'
    filters.viewAll = viewAll

    // Role scoping: technician / field staff (user role) can only view their own surveys unless admin requests viewAll
    const isAdmin = userRole === ROLE_NAMES.ADMIN || userRole === ROLE_NAMES.SUPER_ADMIN
    if (!isAdmin && userId) {
        filters.assignedTechId = userId
    } else if (isAdmin && viewAll) {
        // Admin viewing all surveys; no default assignedTechId override
    }

    return filters
}

export const parsePhotoInput = (body: unknown): SurveyPhotoInput => {
    if (!isRecord(body)) {
        throw new SurveyInputError('Request body must be a JSON object')
    }
    const errors: Record<string, string[]> = {}

    const fileUrl = typeof body['fileUrl'] === 'string' ? body['fileUrl'].trim() : ''
    if (!fileUrl) {
        errors['fileUrl'] = ['fileUrl is required']
    }

    const fileName = typeof body['fileName'] === 'string' ? body['fileName'].trim() : ''
    if (!fileName) {
        errors['fileName'] = ['fileName is required']
    }

    let fileSizeBytes: number | undefined
    if (body['fileSizeBytes'] !== undefined && body['fileSizeBytes'] !== null) {
        const bytes = Number(body['fileSizeBytes'])
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            errors['fileSizeBytes'] = ['fileSizeBytes must be a positive integer']
        } else {
            fileSizeBytes = bytes
        }
    }

    const mimeType = typeof body['mimeType'] === 'string' ? body['mimeType'].trim() : undefined

    if (Object.keys(errors).length > 0) {
        throw new SurveyInputError('Photo input validation failed', errors)
    }

    return {
        fileUrl,
        fileName,
        fileSizeBytes,
        mimeType
    }
}

// ─── Table Reference Helpers ─────────────────────────────────────────────────

const surveyTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".surveys`)
const surveyPhotoTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".survey_photos`)
const leadTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".leads`)
const activityTable = (schemaName: string): SQL => sql.raw(`"${schemaName}".lead_activities`)

// ─── Mappers ─────────────────────────────────────────────────────────────────

const toSurveyPhoto = (row: SurveyPhotoRow): Record<string, unknown> => ({
    id: row.id,
    surveyId: row.survey_id,
    fileUrl: row.file_url,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    createdAt: new Date(row.created_at).toISOString()
})

const toSurvey = (row: SurveyRow, photos?: SurveyPhotoRow[]): Record<string, unknown> => {
    const survey: Record<string, unknown> = {
        id: row.id,
        leadId: row.lead_id,
        customerName: row.customer_name,
        mobileNumber: row.mobile_number,
        address: row.address,
        surveyDateTime: new Date(row.survey_date_time).toISOString(),
        assignedTechId: row.assigned_tech_id,
        assignedTech: row.assigned_tech,
        status: row.status,
        roofAreaSqft: row.roof_area_sqft === null ? 0 : Number(row.roof_area_sqft),
        shading: row.shading ?? 'None',
        connectionType: row.connection_type ?? 'Three-phase',
        sanctionedLoadKw: row.sanctioned_load_kw === null ? 0 : Number(row.sanctioned_load_kw),
        monthlyConsumptionKwh: row.monthly_consumption_kwh === null ? 0 : Number(row.monthly_consumption_kwh),
        recommendedKw: row.recommended_kw === null ? 0 : Number(row.recommended_kw),
        latitude: row.latitude,
        longitude: row.longitude,
        notes: row.notes,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    }

    if (row.lead_customer_name !== undefined || row.lead_id !== null) {
        survey['lead'] = row.lead_id
            ? {
                id: row.lead_id,
                customerName: row.lead_customer_name ?? row.customer_name,
                mobileNumber: row.lead_mobile_number ?? row.mobile_number,
                city: row.lead_city ?? null,
                state: row.lead_state ?? null,
                monthlyBillAmount: row.lead_monthly_bill_amount === null ? null : Number(row.lead_monthly_bill_amount),
                status: row.lead_status ?? null
            }
            : null
    }

    if (photos !== undefined) {
        survey['photos'] = photos.map(toSurveyPhoto)
    }

    return survey
}

// ─── Overlap Check Helper ────────────────────────────────────────────────────

/**
 * Checks if the technician already has another non-cancelled, non-deleted survey
 * within ±45 minutes of the target surveyDateTime.
 * Returns a warning string if overlap is found, or undefined if clear.
 */
export const checkTechnicianOverlap = async (
    schemaName: string,
    techId: string,
    surveyDateTime: Date,
    excludeSurveyId?: string
): Promise<string | undefined> => {
    const sTable = surveyTable(schemaName)
    const windowStart = new Date(surveyDateTime.getTime() - 45 * 60 * 1000)
    const windowEnd = new Date(surveyDateTime.getTime() + 45 * 60 * 1000)

    const conditions: SQL[] = [
        sql`assigned_tech_id = ${techId}`,
        sql`status != 'Cancelled'`,
        sql`deleted_at is null`,
        sql`survey_date_time between ${windowStart} and ${windowEnd}`
    ]

    if (excludeSurveyId) {
        conditions.push(sql`id != ${excludeSurveyId}`)
    }

    const { rows } = await database.execute(
        sql`select id from ${sTable} where ${sql.join(conditions, sql` and `)} limit 1`
    )

    if (rows.length > 0) {
        return 'Technician has an overlapping survey scheduled within 45 minutes'
    }

    return undefined
}

// ─── State Machine Validation Helper ─────────────────────────────────────────

export const validateStatusTransition = (
    currentStatus: SurveyStatus,
    newStatus: SurveyStatus,
    userRole?: RoleName
): void => {
    if (currentStatus === newStatus) {
        return
    }

    const isAdmin = userRole === ROLE_NAMES.ADMIN || userRole === ROLE_NAMES.SUPER_ADMIN

    // Scheduled -> In Progress, Completed, Cancelled
    if (currentStatus === 'Scheduled') {
        if (['In Progress', 'Completed', 'Cancelled'].includes(newStatus)) {
            return
        }
    }

    // In Progress -> Completed, Cancelled, Scheduled
    if (currentStatus === 'In Progress') {
        if (['Completed', 'Cancelled', 'Scheduled'].includes(newStatus)) {
            return
        }
    }

    // Completed -> Cancelled (Admin only)
    if (currentStatus === 'Completed') {
        if (newStatus === 'Cancelled') {
            if (!isAdmin) {
                throw new SurveyForbiddenError('Only admins can cancel a completed survey')
            }
            return
        }
    }

    // Cancelled -> Scheduled (Re-opening)
    if (currentStatus === 'Cancelled') {
        if (newStatus === 'Scheduled') {
            return
        }
    }

    throw new SurveyConflictError(`Cannot transition survey status from '${currentStatus}' to '${newStatus}'`)
}

// ─── Resolve Technician Name ────────────────────────────────────────────────

const resolveTechUser = async (
    companyId: string,
    techId?: string,
    providedTechName?: string
): Promise<{ techId: string | null; techName: string }> => {
    if (!techId) {
        return { techId: null, techName: providedTechName || 'Unassigned' }
    }

    const [user] = await database
        .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName
        })
        .from(users)
        .where(and(eq(users.id, techId), eq(users.companyId, companyId)))

    if (user === undefined) {
        throw new SurveyInputError('assignedTechId user does not exist in company', {
            assignedTechId: ['Assigned technician user does not exist in the company']
        })
    }

    const fullName = `${user.firstName} ${user.lastName}`.trim()
    return {
        techId: user.id,
        techName: fullName || providedTechName || 'Technician'
    }
}

// ─── Service Functions ───────────────────────────────────────────────────────

/**
 * Creates and schedules a site survey.
 * If linked to a lead, executes inside a transaction to:
 * - Update lead status to 'SURVEY_SCHEDULED'
 * - Log LEAD_STATUS_CHANGED and SURVEY_SCHEDULED activities
 */
export const createSurvey = async (
    companyId: string,
    userId: string,
    input: SurveyInput
): Promise<{ data: Record<string, unknown>; warning?: string | undefined }> => {
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const lTable = leadTable(schemaName)
    const aTable = activityTable(schemaName)

    const { techId, techName } = await resolveTechUser(companyId, input.assignedTechId, input.assignedTech)

    let warning: string | undefined
    if (techId) {
        warning = await checkTechnicianOverlap(schemaName, techId, input.surveyDateTime)
    }

    const surveyId = randomUUID()
    const roofAreaSqft = input.roofAreaSqft ?? 0
    const shading = input.shading ?? 'None'
    const connectionType = input.connectionType ?? 'Three-phase'
    const sanctionedLoadKw = input.sanctionedLoadKw ?? 0
    const monthlyConsumptionKwh = input.monthlyConsumptionKwh ?? 0
    const recommendedKw = input.recommendedKw ?? 0

    if (input.leadId) {
        return database.transaction(async (tx) => {
            const { rows: leadRows } = await tx.execute(
                sql`select id, customer_name, mobile_number, address, city, state, monthly_bill_amount, status
                    from ${lTable} where id = ${input.leadId} and deleted_at is null limit 1`
            )
            const lead = leadRows[0] as Record<string, unknown> | undefined
            if (lead === undefined) {
                throw new SurveyInputError('leadId is invalid or lead does not exist', {
                    leadId: ['Lead not found or has been deleted']
                })
            }

            const customerName = input.customerName || (lead['customer_name'] as string)
            const mobileNumber = input.mobileNumber || (lead['mobile_number'] as string)
            const address = input.address !== undefined ? input.address : ((lead['address'] as string) || null)

            const { rows: surveyRows } = await tx.execute(sql`
                insert into ${sTable} (
                    id, lead_id, customer_name, mobile_number, address,
                    survey_date_time, assigned_tech_id, assigned_tech, status,
                    roof_area_sqft, shading, connection_type, sanctioned_load_kw,
                    monthly_consumption_kwh, recommended_kw, latitude, longitude,
                    notes, created_by
                ) values (
                    ${surveyId}, ${input.leadId}, ${customerName}, ${mobileNumber}, ${address},
                    ${input.surveyDateTime}, ${techId}, ${techName}, 'Scheduled',
                    ${roofAreaSqft}, ${shading}, ${connectionType}, ${sanctionedLoadKw},
                    ${monthlyConsumptionKwh}, ${recommendedKw}, ${input.latitude ?? null}, ${input.longitude ?? null},
                    ${input.notes ?? null}, ${userId}
                ) returning *
            `)

            const insertedSurvey = surveyRows[0] as unknown as SurveyRow | undefined
            if (insertedSurvey === undefined) {
                throw new Error('Survey creation failed')
            }

            // Update lead status to SURVEY_SCHEDULED
            await tx.execute(
                sql`update ${lTable} set status = 'SURVEY_SCHEDULED', updated_at = now() where id = ${input.leadId}`
            )

            // Log LEAD_STATUS_CHANGED activity
            await tx.execute(
                sql`insert into ${aTable} (lead_id, activity_type, old_value, new_value, performed_by)
                    values (${input.leadId}, ${LEAD_ACTIVITY_TYPES.STATUS_CHANGED}, ${(lead['status'] as string) ?? null}, 'SURVEY_SCHEDULED', ${userId})`
            )

            // Log SURVEY_SCHEDULED activity
            const desc = `Site survey scheduled for ${input.surveyDateTime.toISOString()} with ${techName}`
            await tx.execute(
                sql`insert into ${aTable} (lead_id, activity_type, description, performed_by)
                    values (${input.leadId}, ${LEAD_ACTIVITY_TYPES.SURVEY_SCHEDULED}, ${desc}, ${userId})`
            )

            const responseRow: SurveyRow = {
                ...insertedSurvey,
                lead_customer_name: lead['customer_name'] as string,
                lead_mobile_number: lead['mobile_number'] as string,
                lead_city: lead['city'] as string,
                lead_state: lead['state'] as string,
                lead_monthly_bill_amount: lead['monthly_bill_amount'] as number,
                lead_status: 'SURVEY_SCHEDULED'
            }

            return {
                data: toSurvey(responseRow, []),
                warning
            }
        })
    }

    const { rows } = await database.execute(sql`
        insert into ${sTable} (
            id, lead_id, customer_name, mobile_number, address,
            survey_date_time, assigned_tech_id, assigned_tech, status,
            roof_area_sqft, shading, connection_type, sanctioned_load_kw,
            monthly_consumption_kwh, recommended_kw, latitude, longitude,
            notes, created_by
        ) values (
            ${surveyId}, null, ${input.customerName}, ${input.mobileNumber}, ${input.address ?? null},
            ${input.surveyDateTime}, ${techId}, ${techName}, 'Scheduled',
            ${roofAreaSqft}, ${shading}, ${connectionType}, ${sanctionedLoadKw},
            ${monthlyConsumptionKwh}, ${recommendedKw}, ${input.latitude ?? null}, ${input.longitude ?? null},
            ${input.notes ?? null}, ${userId}
        ) returning *
    `)

    const row = rows[0] as unknown as SurveyRow | undefined
    if (row === undefined) {
        throw new Error('Survey creation failed')
    }

    return {
        data: toSurvey(row, []),
        warning
    }
}

/**
 * Lists site surveys with filtering, search, and single-pass CTE pagination.
 */
export const listSurveys = async (
    companyId: string,
    filters: SurveyFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const lTable = leadTable(schemaName)

    const conditions: SQL[] = [sql`s.deleted_at is null`]

    if (filters.search) {
        conditions.push(sql`(s.customer_name ilike ${`%${filters.search}%`} or s.mobile_number ilike ${`%${filters.search}%`})`)
    }

    if (filters.status) {
        conditions.push(sql`s.status = ${filters.status}`)
    }

    if (filters.leadId) {
        conditions.push(sql`s.lead_id = ${filters.leadId}`)
    }

    if (filters.assignedTechId) {
        if (filters.assignedTechId === 'Unassigned') {
            conditions.push(sql`(s.assigned_tech_id is null or s.assigned_tech = 'Unassigned')`)
        } else {
            conditions.push(sql`s.assigned_tech_id = ${filters.assignedTechId}`)
        }
    }

    if (filters.dateFrom) {
        conditions.push(sql`s.survey_date_time >= ${filters.dateFrom}`)
    }

    if (filters.dateTo) {
        conditions.push(sql`s.survey_date_time <= ${filters.dateTo}`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        surveyDateTime: 'survey_date_time',
        createdAt: 'created_at',
        customerName: 'customer_name'
    } as const
    const order = sql.raw(`${sortColumns[filters.sort]} ${filters.direction === 'asc' ? 'asc' : 'desc'}`)
    const offset = (filters.page - 1) * filters.limit

    // Single CTE query with window function count(*) over() eliminates separate count query
    const { rows } = await database.execute(sql`
        with filtered as (
            select s.*,
                   l.customer_name as lead_customer_name,
                   l.mobile_number as lead_mobile_number,
                   l.city as lead_city,
                   l.state as lead_state,
                   l.monthly_bill_amount as lead_monthly_bill_amount,
                   l.status as lead_status,
                   count(*) over() as _total_count
            from ${sTable} s
            left join ${lTable} l on l.id = s.lead_id
            where ${where}
        )
        select * from filtered
        order by ${order}
        limit ${filters.limit} offset ${offset}
    `)

    const typedRows = rows as unknown as SurveyRowWithCount[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    return {
        data: typedRows.map((r) => toSurvey(r)),
        total
    }
}

/**
 * Retrieves a single survey by ID including linked lead summary and photos.
 */
export const getSurveyById = async (
    companyId: string,
    surveyId: string
): Promise<Record<string, unknown>> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const lTable = leadTable(schemaName)
    const pTable = surveyPhotoTable(schemaName)

    const { rows } = await database.execute(sql`
        select s.*,
               l.customer_name as lead_customer_name,
               l.mobile_number as lead_mobile_number,
               l.city as lead_city,
               l.state as lead_state,
               l.monthly_bill_amount as lead_monthly_bill_amount,
               l.status as lead_status
        from ${sTable} s
        left join ${lTable} l on l.id = s.lead_id
        where s.id = ${surveyId} and s.deleted_at is null
        limit 1
    `)

    const row = rows[0] as unknown as SurveyRow | undefined
    if (row === undefined) {
        throw new SurveyNotFoundError()
    }

    const { rows: photoRows } = await database.execute(sql`
        select * from ${pTable} where survey_id = ${surveyId} order by created_at desc
    `)

    return toSurvey(row, photoRows as unknown as SurveyPhotoRow[])
}

/**
 * Updates survey specs and details.
 * Logs SURVEY_RESCHEDULED if surveyDateTime changed and survey is linked to a lead.
 */
export const updateSurvey = async (
    companyId: string,
    userId: string,
    surveyId: string,
    input: Partial<SurveyInput>
): Promise<{ data: Record<string, unknown>; warning?: string | undefined }> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const aTable = activityTable(schemaName)

    // Retrieve existing survey
    const { rows: existingRows } = await database.execute(sql`
        select * from ${sTable} where id = ${surveyId} and deleted_at is null limit 1
    `)
    const existing = existingRows[0] as unknown as SurveyRow | undefined
    if (existing === undefined) {
        throw new SurveyNotFoundError()
    }

    let warning: string | undefined
    let assignedTechId = existing.assigned_tech_id
    let assignedTech = existing.assigned_tech

    if (input.assignedTechId !== undefined || input.assignedTech !== undefined) {
        const resolved = await resolveTechUser(companyId, input.assignedTechId, input.assignedTech)
        assignedTechId = resolved.techId
        assignedTech = resolved.techName
    }

    const targetDateTime = input.surveyDateTime ?? new Date(existing.survey_date_time)

    if (assignedTechId) {
        warning = await checkTechnicianOverlap(schemaName, assignedTechId, targetDateTime, surveyId)
    }

    const setClauses: SQL[] = [sql`updated_at = now()`]

    if (input.customerName !== undefined) setClauses.push(sql`customer_name = ${input.customerName}`)
    if (input.mobileNumber !== undefined) setClauses.push(sql`mobile_number = ${input.mobileNumber}`)
    if (input.address !== undefined) setClauses.push(sql`address = ${input.address}`)
    if (input.surveyDateTime !== undefined) setClauses.push(sql`survey_date_time = ${input.surveyDateTime}`)
    if (input.assignedTechId !== undefined || input.assignedTech !== undefined) {
        setClauses.push(sql`assigned_tech_id = ${assignedTechId}`)
        setClauses.push(sql`assigned_tech = ${assignedTech}`)
    }
    if (input.notes !== undefined) setClauses.push(sql`notes = ${input.notes}`)
    if (input.roofAreaSqft !== undefined) setClauses.push(sql`roof_area_sqft = ${input.roofAreaSqft}`)
    if (input.shading !== undefined) setClauses.push(sql`shading = ${input.shading}`)
    if (input.connectionType !== undefined) setClauses.push(sql`connection_type = ${input.connectionType}`)
    if (input.sanctionedLoadKw !== undefined) setClauses.push(sql`sanctioned_load_kw = ${input.sanctionedLoadKw}`)
    if (input.monthlyConsumptionKwh !== undefined) setClauses.push(sql`monthly_consumption_kwh = ${input.monthlyConsumptionKwh}`)
    if (input.recommendedKw !== undefined) setClauses.push(sql`recommended_kw = ${input.recommendedKw}`)
    if (input.latitude !== undefined) setClauses.push(sql`latitude = ${input.latitude}`)
    if (input.longitude !== undefined) setClauses.push(sql`longitude = ${input.longitude}`)

    const { rows: updatedRows } = await database.execute(sql`
        update ${sTable}
        set ${sql.join(setClauses, sql`, `)}
        where id = ${surveyId} and deleted_at is null
        returning *
    `)

    const updated = updatedRows[0] as unknown as SurveyRow | undefined
    if (updated === undefined) {
        throw new SurveyNotFoundError()
    }

    // Check if surveyDateTime changed and linked to a lead
    if (input.surveyDateTime !== undefined && existing.lead_id) {
        const oldIso = new Date(existing.survey_date_time).toISOString()
        const newIso = input.surveyDateTime.toISOString()
        if (oldIso !== newIso) {
            await database.execute(sql`
                insert into ${aTable} (lead_id, activity_type, old_value, new_value, description, performed_by)
                values (
                    ${existing.lead_id},
                    ${LEAD_ACTIVITY_TYPES.SURVEY_RESCHEDULED},
                    ${oldIso},
                    ${newIso},
                    ${`Site survey rescheduled to ${newIso}`},
                    ${userId}
                )
            `)
        }
    }

    return {
        data: await getSurveyById(companyId, surveyId),
        warning
    }
}

/**
 * Updates survey status adhering to the state machine.
 * If status changes to 'Completed' and linked to a lead, logs a lead activity.
 */
export const updateSurveyStatus = async (
    companyId: string,
    userId: string,
    userRole: RoleName,
    surveyId: string,
    newStatus: SurveyStatus
): Promise<Record<string, unknown>> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const aTable = activityTable(schemaName)

    const { rows: existingRows } = await database.execute(sql`
        select * from ${sTable} where id = ${surveyId} and deleted_at is null limit 1
    `)
    const existing = existingRows[0] as unknown as SurveyRow | undefined
    if (existing === undefined) {
        throw new SurveyNotFoundError()
    }

    validateStatusTransition(existing.status, newStatus, userRole)

    const { rows: updatedRows } = await database.execute(sql`
        update ${sTable}
        set status = ${newStatus}, updated_at = now()
        where id = ${surveyId} and deleted_at is null
        returning *
    `)

    const updated = updatedRows[0] as unknown as SurveyRow | undefined
    if (updated === undefined) {
        throw new SurveyNotFoundError()
    }

    if (newStatus === 'Completed' && existing.status !== 'Completed' && existing.lead_id) {
        await database.execute(sql`
            insert into ${aTable} (lead_id, activity_type, description, performed_by)
            values (
                ${existing.lead_id},
                ${LEAD_ACTIVITY_TYPES.SURVEY_COMPLETED},
                'Site survey completed',
                ${userId}
            )
        `)
    }

    return getSurveyById(companyId, surveyId)
}

/**
 * Assigns a technician to a survey.
 */
export const assignSurveyTechnician = async (
    companyId: string,
    _userId: string,
    surveyId: string,
    techId: string | null,
    techName?: string
): Promise<{ data: Record<string, unknown>; warning?: string | undefined }> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)

    const { rows: existingRows } = await database.execute(sql`
        select * from ${sTable} where id = ${surveyId} and deleted_at is null limit 1
    `)
    const existing = existingRows[0] as unknown as SurveyRow | undefined
    if (existing === undefined) {
        throw new SurveyNotFoundError()
    }

    const { techId: resolvedTechId, techName: resolvedTechName } = await resolveTechUser(companyId, techId ?? undefined, techName)

    let warning: string | undefined
    if (resolvedTechId) {
        warning = await checkTechnicianOverlap(
            schemaName,
            resolvedTechId,
            new Date(existing.survey_date_time),
            surveyId
        )
    }

    await database.execute(sql`
        update ${sTable}
        set assigned_tech_id = ${resolvedTechId},
            assigned_tech = ${resolvedTechName},
            updated_at = now()
        where id = ${surveyId} and deleted_at is null
    `)

    return {
        data: await getSurveyById(companyId, surveyId),
        warning
    }
}

/**
 * Adds photo metadata to a survey.
 */
export const addSurveyPhoto = async (
    companyId: string,
    userId: string,
    surveyId: string,
    input: SurveyPhotoInput
): Promise<Record<string, unknown>> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const pTable = surveyPhotoTable(schemaName)

    // Verify survey exists and is not soft deleted
    const { rows: surveyRows } = await database.execute(sql`
        select id from ${sTable} where id = ${surveyId} and deleted_at is null limit 1
    `)
    if (surveyRows.length === 0) {
        throw new SurveyNotFoundError()
    }

    const photoId = randomUUID()
    const { rows } = await database.execute(sql`
        insert into ${pTable} (
            id, survey_id, file_url, file_name, file_size_bytes, mime_type, uploaded_by
        ) values (
            ${photoId}, ${surveyId}, ${input.fileUrl}, ${input.fileName},
            ${input.fileSizeBytes ?? null}, ${input.mimeType ?? null}, ${userId}
        ) returning *
    `)

    const row = rows[0] as unknown as SurveyPhotoRow | undefined
    if (row === undefined) {
        throw new Error('Photo insertion failed')
    }

    return toSurveyPhoto(row)
}

/**
 * Deletes photo metadata by photo ID.
 */
export const deleteSurveyPhoto = async (
    companyId: string,
    surveyId: string,
    photoId: string
): Promise<{ message: string; photoId: string }> => {
    parseUuid(surveyId, 'id')
    parseUuid(photoId, 'photoId')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const pTable = surveyPhotoTable(schemaName)

    const { rows: surveyRows } = await database.execute(sql`
        select id from ${sTable} where id = ${surveyId} and deleted_at is null limit 1
    `)
    if (surveyRows.length === 0) {
        throw new SurveyNotFoundError()
    }

    const { rows } = await database.execute(sql`
        delete from ${pTable} where id = ${photoId} and survey_id = ${surveyId} returning id
    `)

    if (rows.length === 0) {
        throw new SurveyNotFoundError('Photo not found')
    }

    return {
        message: 'Photo deleted successfully',
        photoId
    }
}

/**
 * Soft deletes a survey.
 */
export const deleteSurvey = async (
    companyId: string,
    surveyId: string
): Promise<{ message: string; surveyId: string }> => {
    parseUuid(surveyId, 'id')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)

    const { rows } = await database.execute(sql`
        update ${sTable}
        set deleted_at = now(), updated_at = now()
        where id = ${surveyId} and deleted_at is null
        returning id
    `)

    if (rows.length === 0) {
        throw new SurveyNotFoundError()
    }

    return {
        message: 'Survey deleted successfully',
        surveyId
    }
}

/**
 * Retrieves all surveys for a specific lead, ordered by surveyDateTime desc.
 */
export const listSurveysForLead = async (
    companyId: string,
    leadId: string
): Promise<Record<string, unknown>[]> => {
    parseUuid(leadId, 'leadId')
    const schemaName = await ensureCompanySurveyTables(companyId)
    const sTable = surveyTable(schemaName)
    const pTable = surveyPhotoTable(schemaName)
    const lTable = leadTable(schemaName)

    const { rows } = await database.execute(sql`
        select s.*,
               l.customer_name as lead_customer_name,
               l.mobile_number as lead_mobile_number,
               l.city as lead_city,
               l.state as lead_state,
               l.monthly_bill_amount as lead_monthly_bill_amount,
               l.status as lead_status
        from ${sTable} s
        left join ${lTable} l on l.id = s.lead_id
        where s.lead_id = ${leadId} and s.deleted_at is null
        order by s.survey_date_time desc
    `)

    const typedRows = rows as unknown as SurveyRow[]
    if (typedRows.length === 0) {
        return []
    }

    const surveyIds = typedRows.map((r) => r.id)
    const { rows: photoRows } = await database.execute(sql`
        select * from ${pTable}
        where survey_id in (${sql.join(surveyIds.map((id) => sql`${id}`), sql`, `)})
        order by created_at desc
    `)

    const photoMap = new Map<string, SurveyPhotoRow[]>()
    for (const p of photoRows as unknown as SurveyPhotoRow[]) {
        const list = photoMap.get(p.survey_id) ?? []
        list.push(p)
        photoMap.set(p.survey_id, list)
    }

    return typedRows.map((r) => toSurvey(r, photoMap.get(r.id) ?? []))
}
