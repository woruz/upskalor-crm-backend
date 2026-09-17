import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import ExcelJS from 'exceljs'
import { parse } from 'csv-parse'
import { sql } from 'drizzle-orm'
import type { S3Client } from '@aws-sdk/client-s3'

import { database } from '../../database/client.js'
import { ensureCompanyLeadTables } from '../../database/tenants.js'
import { createDownloadUrl, createUploadUrl, getObjectMetadata, getObjectStream, putObject } from '../../common/utils/storage.js'
import type { StorageConfig } from '../../common/types/config.js'
import { enqueueLeadImportJob } from '../../jobs/index.js'
import {
    LEAD_STATUSES,
    LeadInputError,
    LeadReferenceError,
    parseLeadFilters,
    parseLeadInput,
    queryLeadsForExport,
    type LeadInput,
    type LeadFilters
} from './leads.js'

export const IMPORT_STATUSES = ['UPLOADING', 'UPLOADED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]
export const EXPORT_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]
export type TransferFormat = 'csv' | 'xlsx'

export class TransferInputError extends Error { }
export class TransferNotFoundError extends Error { }
export class TransferOwnershipError extends Error { }

interface UploadRequest {
    fileName: string
    contentType: string
    fileSize: number
    extension: 'csv' | 'xlsx'
}

interface ImportRow {
    rowNumber: number
    values: Record<string, unknown>
}

interface ImportError {
    rowNumber: number
    field?: string
    customerName?: string | undefined
    mobileNumber?: string | undefined
    reason: string
}

const CSV_CONTENT_TYPES = new Set(['text/csv', 'application/csv'])
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHUNK_SIZE = 100
const LEAD_TABLE = (schemaName: string) => sql.raw(`${schemaName}.leads`)
const IMPORT_TABLE = (schemaName: string) => sql.raw(`${schemaName}.lead_imports`)
const IMPORT_ERROR_TABLE = (schemaName: string) => sql.raw(`${schemaName}.lead_import_errors`)
const EXPORT_TABLE = (schemaName: string) => sql.raw(`${schemaName}.lead_exports`)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string') {
        throw new TransferInputError(`${field} must be a string`)
    }
    const normalized = value.trim()
    if (normalized === '' || normalized.length > maxLength) {
        throw new TransferInputError(`${field} is invalid`)
    }
    return normalized
}

const parseUuid = (value: unknown, field: string): string => {
    const normalized = requiredString(value, field, 36)
    if (!UUID_PATTERN.test(normalized)) {
        throw new TransferInputError(`${field} is invalid`)
    }
    return normalized
}

export const parseUploadRequest = (body: unknown, maxFileSize: number): UploadRequest => {
    if (!isRecord(body)) {
        throw new TransferInputError('Request body must be a JSON object')
    }
    const fileName = requiredString(body['fileName'], 'fileName', 255)
    const contentType = requiredString(body['contentType'], 'contentType', 150).toLowerCase()
    const fileSize = Number(body['fileSize'])
    const extension = fileName.toLowerCase().endsWith('.csv') ? 'csv' : fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : undefined

    if (extension === undefined) {
        throw new TransferInputError('Only .csv and .xlsx files are supported')
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxFileSize) {
        throw new TransferInputError('fileSize is invalid or exceeds the maximum')
    }
    if (extension === 'csv' && !CSV_CONTENT_TYPES.has(contentType)) {
        throw new TransferInputError('CSV contentType is invalid')
    }
    if (extension === 'xlsx' && contentType !== XLSX_CONTENT_TYPE) {
        throw new TransferInputError('XLSX contentType is invalid')
    }

    return { fileName, contentType, fileSize, extension }
}

export const parseTransferFormat = (value: unknown): TransferFormat => {
    if (value !== 'csv' && value !== 'xlsx') {
        throw new TransferInputError('format must be csv or xlsx')
    }
    return value
}

const buildImportKey = (companyId: string, userId: string, fileId: string, extension: string): string => `leads/${companyId}/imports/${userId}/${fileId}.${extension}`
const buildExportKey = (companyId: string, exportId: string, format: TransferFormat): string => `leads/${companyId}/exports/${exportId}.${format}`

const expectedImportKey = (companyId: string, userId: string, fileId: string, key: string): boolean =>
    new RegExp(`^leads/${companyId}/imports/${userId}/${fileId}\\.(csv|xlsx)$`).test(key)

const toImportResponse = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: row['id'],
    fileName: row['file_name'],
    status: row['status'],
    totalRows: row['total_rows'],
    successfulRows: row['successful_rows'],
    failedRows: row['failed_rows'],
    duplicateRows: row['duplicate_rows'],
    errorFileKey: row['error_file_key'],
    startedAt: row['started_at'],
    completedAt: row['completed_at'],
    createdAt: row['created_at']
})

const toExportResponse = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: row['id'],
    status: row['status'],
    format: row['format'],
    totalRows: row['total_rows'],
    createdAt: row['created_at'],
    completedAt: row['completed_at']
})

export const requestImportUpload = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    body: unknown
): Promise<{ uploadUrl: string; key: string; fileId: string; expiresIn: number }> => {
    const input = parseUploadRequest(body, storage.maxLeadImportFileSize)
    const fileId = randomUUID()
    const key = buildImportKey(companyId, userId, fileId, input.extension)
    const uploadUrl = await createUploadUrl(client, storage, key, input.contentType, input.fileSize)
    return { uploadUrl, key, fileId, expiresIn: storage.presignExpiresIn }
}

const getOwnedImport = async (companyId: string, userId: string, importId: string): Promise<{ schemaName: string; row: Record<string, unknown> }> => {
    const schemaName = await ensureCompanyLeadTables(companyId)
    const { rows } = await database.execute(sql`select * from ${IMPORT_TABLE(schemaName)} where id = ${importId} and uploaded_by = ${userId}`)
    const row = rows[0] as Record<string, unknown> | undefined
    if (row === undefined) {
        throw new TransferNotFoundError('Import not found')
    }
    return { schemaName, row }
}

export const confirmImport = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    body: unknown
): Promise<Record<string, unknown>> => {
    if (!isRecord(body)) {
        throw new TransferInputError('Request body must be a JSON object')
    }
    const fileId = parseUuid(body['fileId'], 'fileId')
    const key = requiredString(body['key'], 'key', 500)
    if (!expectedImportKey(companyId, userId, fileId, key)) {
        throw new TransferOwnershipError('The uploaded object is not owned by this user')
    }

    const metadata = await getObjectMetadata(client, storage, key)
    if (metadata.ContentLength === undefined || metadata.ContentLength <= 0 || metadata.ContentLength > storage.maxLeadImportFileSize) {
        throw new TransferInputError('The uploaded file size is invalid')
    }
    const extension = key.endsWith('.csv') ? 'csv' : 'xlsx'
    const contentType = (metadata.ContentType ?? '').toLowerCase()
    if ((extension === 'csv' && !CSV_CONTENT_TYPES.has(contentType)) || (extension === 'xlsx' && contentType !== XLSX_CONTENT_TYPE)) {
        throw new TransferInputError('The uploaded file contentType is invalid')
    }

    const schemaName = await ensureCompanyLeadTables(companyId)
    const { rows } = await database.execute(sql`select * from ${IMPORT_TABLE(schemaName)} where id = ${fileId} and uploaded_by = ${userId}`)
    const existing = rows[0] as Record<string, unknown> | undefined
    if (existing !== undefined) {
        return toImportResponse(existing)
    }

    const { rows: insertedRows } = await database.execute(sql`
        insert into ${IMPORT_TABLE(schemaName)} (id, file_name, s3_key, uploaded_by, status)
        values (${fileId}, ${key.split('/').at(-1) ?? key}, ${key}, ${userId}, 'QUEUED')
        returning *
    `)
    const inserted = insertedRows[0] as Record<string, unknown> | undefined
    if (inserted === undefined) {
        throw new Error('Import record creation failed')
    }

    // Asynchronously dispatch background import job to BullMQ
    await enqueueLeadImportJob({
        companyId,
        userId,
        importId: fileId,
        s3Key: key,
        fileName: key.split('/').at(-1) ?? key,
        extension
    })

    return toImportResponse(inserted)
}

const extractCellValue = (cell: unknown): unknown => {
    if (cell === null || cell === undefined) return undefined
    if (cell instanceof Date) return cell
    if (typeof cell === 'object') {
        if ('text' in cell && typeof (cell as { text: unknown }).text === 'string') {
            return (cell as { text: string }).text
        }
        if ('result' in cell) {
            return (cell as { result: unknown }).result
        }
    }
    return cell
}

const normalizeHeader = (value: unknown): string =>
    String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')

const HEADER_MAP: Record<string, keyof Record<string, unknown>> = {
    customername: 'customerName',
    mobilenumber: 'mobileNumber',
    phone: 'mobileNumber',
    email: 'email',
    address: 'address',
    monthlybillamount: 'monthlyBillAmount',
    followupdate: 'followUpDate',
    state: 'state',
    city: 'city',
    roofownership: 'roofOwnership',
    rooftype: 'roofType',
    leadsource: 'leadSource',
    assignedexecutive: 'assignedExecutive'
}

const mapRow = (headers: string[], values: unknown[], rowNumber: number): ImportRow => {
    const mapped: Record<string, unknown> = {}
    headers.forEach((header, index) => {
        const field = HEADER_MAP[normalizeHeader(header)]
        if (field !== undefined) {
            mapped[field] = extractCellValue(values[index])
        }
    })
    return { rowNumber, values: mapped }
}

const csvRows = async function* (body: NodeJS.ReadableStream): AsyncGenerator<ImportRow> {
    let rowNumber = 1
    let headers: string[] | undefined
    const parser = body.pipe(parse({ bom: true, skip_empty_lines: true, relax_column_count: true }))
    for await (const record of parser as AsyncIterable<unknown[]>) {
        if (headers === undefined) {
            headers = record.map((value) => String(value ?? ''))
            continue
        }
        rowNumber += 1
        yield mapRow(headers, record, rowNumber)
    }
}

const xlsxRows = async function* (body: NodeJS.ReadableStream): AsyncGenerator<ImportRow> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(body as Readable, {})
    let headers: string[] | undefined
    let rowNumber = 0
    for await (const worksheet of workbook) {
        for await (const row of worksheet) {
            rowNumber += 1
            const values = row.values as unknown[]
            if (headers === undefined) {
                headers = values.slice(1).map((value) => String(value ?? ''))
                continue
            }
            yield mapRow(headers, values.slice(1), rowNumber)
        }
    }
}

const validateImportRow = async (companyId: string, row: ImportRow): Promise<LeadInput> => {
    try {
        const input = parseLeadInput(row.values) as LeadInput
        if (input.assignedExecutive !== undefined) {
            await validateExecutive(companyId, input.assignedExecutive)
        }
        return input
    } catch (error) {
        if (error instanceof LeadInputError || error instanceof LeadReferenceError) {
            throw error
        }
        throw new LeadInputError('Row is invalid')
    }
}

const validateExecutive = async (companyId: string, executiveId: string): Promise<void> => {
    const { rows } = await database.execute(sql`select id from root.users where id = ${executiveId} and company_id = ${companyId} and is_active = true limit 1`)
    if (rows[0] === undefined) {
        throw new LeadReferenceError('assignedExecutive is invalid')
    }
}

const findDuplicateMobiles = async (schemaName: string, mobiles: string[]): Promise<Set<string>> => {
    if (mobiles.length === 0) {
        return new Set()
    }
    const values = sql.join(mobiles.map((mobile) => sql`${mobile}`), sql`, `)
    const { rows } = await database.execute(sql`select mobile_number from ${LEAD_TABLE(schemaName)} where deleted_at is null and mobile_number in (${values})`)
    return new Set(rows.map((row) => String((row as Record<string, unknown>)['mobile_number'])))
}

const insertLeadChunk = async (schemaName: string, userId: string, inputs: LeadInput[]): Promise<void> => {
    const values = inputs.map((input) => sql`(
        ${randomUUID()}, ${input.customerName}, ${input.mobileNumber}, ${input.email ?? null}, ${input.address ?? null}, ${input.monthlyBillAmount ?? null},
        ${input.followUpDate}, ${input.state ?? null}, ${input.city ?? null}, ${input.roofOwnership ?? null}, ${input.roofType ?? null}, ${input.leadSource ?? null},
        ${input.assignedExecutive ?? null}, ${input.status}, ${userId}, now(), now()
    )`)
    await database.execute(sql`
        insert into ${LEAD_TABLE(schemaName)}
        (id, customer_name, mobile_number, email, address, monthly_bill_amount, follow_up_date, state, city, roof_ownership, roof_type, lead_source, assigned_executive, status, created_by, created_at, updated_at)
        values ${sql.join(values, sql`, `)}
    `)
}

const escapeCsv = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`

const writeErrorReport = async (client: S3Client, storage: StorageConfig, companyId: string, importId: string, errors: ImportError[]): Promise<string | undefined> => {
    if (errors.length === 0) {
        return undefined
    }
    const key = `leads/${companyId}/imports/errors/${importId}.csv`
    const content = [
        ['Row Number', 'Customer Name', 'Mobile Number', 'Field', 'Error'],
        ...errors.map((error) => [error.rowNumber, error.customerName ?? '', error.mobileNumber ?? '', error.field ?? '', error.reason])
    ]
        .map((row) => row.map(escapeCsv).join(','))
        .join('\n')
    await putObject(client, storage, key, Buffer.from(content, 'utf8'), 'text/csv')
    return key
}

export const executeImportJob = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    importId: string,
    key: string
): Promise<void> => {
    const { schemaName } = await getOwnedImport(companyId, userId, importId)
    await database.execute(
        sql`update ${IMPORT_TABLE(schemaName)} set status = 'PROCESSING', started_at = now(), updated_at = now() where id = ${importId} and (status = 'UPLOADED' or status = 'QUEUED')`
    )

    try {
        const { body } = await getObjectStream(client, storage, key)
        const rows = key.endsWith('.csv') ? csvRows(body) : xlsxRows(body)
        const errors: ImportError[] = []
        const validRows: Array<{ row: ImportRow; input: LeadInput }> = []
        let totalRows = 0
        let duplicateRows = 0
        const seenMobiles = new Set<string>()

        for await (const row of rows) {
            totalRows += 1
            try {
                const input = await validateImportRow(companyId, row)
                if (seenMobiles.has(input.mobileNumber)) {
                    duplicateRows += 1
                    errors.push({ rowNumber: row.rowNumber, mobileNumber: input.mobileNumber, reason: 'Duplicate mobile number in import' })
                    continue
                }
                seenMobiles.add(input.mobileNumber)
                validRows.push({ row, input })
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'Row is invalid'
                errors.push({
                    rowNumber: row.rowNumber,
                    customerName: typeof row.values['customerName'] === 'string' ? row.values['customerName'] : undefined,
                    mobileNumber: typeof row.values['mobileNumber'] === 'string' ? row.values['mobileNumber'] : undefined,
                    reason
                })
            }
        }

        const existingMobiles = await findDuplicateMobiles(schemaName, validRows.map(({ input }) => input.mobileNumber))
        const insertable = validRows.filter(({ row, input }) => {
            if (!existingMobiles.has(input.mobileNumber)) {
                return true
            }
            duplicateRows += 1
            errors.push({ rowNumber: row.rowNumber, mobileNumber: input.mobileNumber, reason: 'Duplicate mobile number already exists' })
            return false
        })

        for (let index = 0; index < insertable.length; index += CHUNK_SIZE) {
            await insertLeadChunk(schemaName, userId, insertable.slice(index, index + CHUNK_SIZE).map(({ input }) => input))
        }

        const errorFileKey = await writeErrorReport(client, storage, companyId, importId, errors)
        if (errors.length > 0) {
            const errorValues = errors.map(
                (error) =>
                    sql`(${randomUUID()}, ${importId}, ${error.rowNumber}, ${error.field ?? null}, ${error.customerName ?? null}, ${error.mobileNumber ?? null}, ${error.reason}, now())`
            )
            await database.execute(
                sql`insert into ${IMPORT_ERROR_TABLE(schemaName)} (id, import_id, row_number, field, customer_name, mobile_number, reason, created_at) values ${sql.join(errorValues, sql`, `)}`
            )
        }
        const status: ImportStatus = errors.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'
        await database.execute(
            sql`update ${IMPORT_TABLE(schemaName)} set status = ${status}, total_rows = ${totalRows}, successful_rows = ${insertable.length}, failed_rows = ${errors.length - duplicateRows}, duplicate_rows = ${duplicateRows}, error_file_key = ${errorFileKey ?? null}, completed_at = now(), updated_at = now() where id = ${importId}`
        )
    } catch (err) {
        await database.execute(
            sql`update ${IMPORT_TABLE(schemaName)} set status = 'FAILED', completed_at = now(), updated_at = now() where id = ${importId}`
        )
        throw err
    }
}

export const handleS3UploadHook = async (
    _client: S3Client,
    _storage: StorageConfig,
    body: unknown
): Promise<{ success: boolean; importId: string; status: string }> => {
    if (!isRecord(body)) {
        throw new TransferInputError('Webhook payload must be a JSON object')
    }

    // 1. Resolve S3 key from either AWS S3 Event Notification or direct JSON payload
    let s3Key: string | undefined = undefined
    if (Array.isArray(body['Records']) && body['Records'].length > 0) {
        const record = body['Records'][0] as Record<string, unknown>
        const s3Data = record['s3'] as Record<string, unknown> | undefined
        const objectData = s3Data?.['object'] as Record<string, unknown> | undefined
        s3Key = typeof objectData?.['key'] === 'string' ? objectData['key'] : undefined
    } else if (typeof body['key'] === 'string') {
        s3Key = body['key']
    }

    if (!s3Key) {
        throw new TransferInputError('S3 key could not be extracted from webhook payload')
    }

    // Clean up URL-encoded keys (AWS S3 event notifications encode '+' and '%20' etc.)
    s3Key = decodeURIComponent(s3Key.replace(/\+/g, ' '))

    // 2. Validate S3 key format: leads/{companyId}/imports/{userId}/{fileId}.(csv|xlsx)
    const match = /^leads\/([0-9a-f-]{36})\/imports\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(csv|xlsx)$/i.exec(s3Key)
    if (!match) {
        throw new TransferInputError(`Invalid S3 import key pattern: ${s3Key}`)
    }

    const companyId = match[1]!
    const userId = match[2]!
    const fileId = match[3]!
    const extension = match[4]!.toLowerCase() as 'csv' | 'xlsx'

    // 3. Ensure tenant tables exist
    const schemaName = await ensureCompanyLeadTables(companyId)

    // 4. Check if record already exists in database
    const { rows } = await database.execute(
        sql`select id, status from ${IMPORT_TABLE(schemaName)} where id = ${fileId}`
    )
    const existing = rows[0] as Record<string, unknown> | undefined

    if (existing === undefined) {
        await database.execute(sql`
            insert into ${IMPORT_TABLE(schemaName)} (id, file_name, s3_key, uploaded_by, status)
            values (${fileId}, ${s3Key.split('/').at(-1) ?? s3Key}, ${s3Key}, ${userId}, 'QUEUED')
        `)
    }

    // 5. Enqueue BullMQ job
    await enqueueLeadImportJob({
        companyId,
        userId,
        importId: fileId,
        s3Key,
        fileName: s3Key.split('/').at(-1) ?? s3Key,
        extension
    })

    return { success: true, importId: fileId, status: 'QUEUED' }
}

export const getImportStatus = async (companyId: string, userId: string, importId: string): Promise<Record<string, unknown>> => {
    const { row } = await getOwnedImport(companyId, userId, parseUuid(importId, 'importId'))
    return toImportResponse(row)
}

export const getImportErrorReportUrl = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    importId: string
): Promise<{ downloadUrl: string; expiresIn: number }> => {
    const { row } = await getOwnedImport(companyId, userId, parseUuid(importId, 'importId'))
    const key = row['error_file_key']
    if (typeof key !== 'string' || key === '') {
        throw new TransferNotFoundError('Import error report not found')
    }
    if (!key.startsWith(`leads/${companyId}/imports/errors/${importId}.csv`)) {
        throw new TransferOwnershipError('The error report is not owned by this tenant')
    }
    return { downloadUrl: await createDownloadUrl(client, storage, key), expiresIn: storage.presignExpiresIn }
}

const buildFiltersFromBody = (body: unknown): LeadFilters => {
    if (!isRecord(body)) {
        throw new TransferInputError('Request body must be a JSON object')
    }
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
        if (key === 'format' || value === undefined || value === null) {
            continue
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw new TransferInputError(`${key} is invalid`)
        }
        params.set(key, String(value))
    }
    return parseLeadFilters(new URL(`http://localhost/leads?${params.toString()}`))
}

const createCsv = (rows: Record<string, unknown>[]): Buffer => {
    const fields = ['id', 'customerName', 'mobileNumber', 'email', 'address', 'monthlyBillAmount', 'followUpDate', 'state', 'city', 'roofOwnership', 'roofType', 'leadSource', 'assignedExecutive', 'status', 'createdBy', 'createdAt', 'updatedAt']
    return Buffer.from([fields, ...rows.map((row) => fields.map((field) => row[field]))].map((row) => row.map(escapeCsv).join(',')).join('\n'), 'utf8')
}

const createXlsx = async (rows: Record<string, unknown>[]): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Leads')
    const fields = ['id', 'customerName', 'mobileNumber', 'email', 'address', 'monthlyBillAmount', 'followUpDate', 'state', 'city', 'roofOwnership', 'roofType', 'leadSource', 'assignedExecutive', 'status', 'createdBy', 'createdAt', 'updatedAt']
    worksheet.addRow(fields)
    rows.forEach((row) => worksheet.addRow(fields.map((field) => row[field])))
    return Buffer.from(await workbook.xlsx.writeBuffer())
}

const getOwnedExport = async (companyId: string, userId: string, exportId: string): Promise<{ schemaName: string; row: Record<string, unknown> }> => {
    const schemaName = await ensureCompanyLeadTables(companyId)
    const { rows } = await database.execute(sql`select * from ${EXPORT_TABLE(schemaName)} where id = ${exportId} and requested_by = ${userId}`)
    const row = rows[0] as Record<string, unknown> | undefined
    if (row === undefined) {
        throw new TransferNotFoundError('Export not found')
    }
    return { schemaName, row }
}

const processExport = async (client: S3Client, storage: StorageConfig, companyId: string, userId: string, exportId: string, filters: LeadFilters, format: TransferFormat): Promise<void> => {
    const { schemaName } = await getOwnedExport(companyId, userId, exportId)
    await database.execute(sql`update ${EXPORT_TABLE(schemaName)} set status = 'PROCESSING', updated_at = now() where id = ${exportId} and status = 'QUEUED'`)
    const rows = await queryLeadsForExport(companyId, filters, storage.maxLeadExportRows)
    const body = format === 'csv' ? createCsv(rows) : await createXlsx(rows)
    const key = buildExportKey(companyId, exportId, format)
    await putObject(client, storage, key, body, format === 'csv' ? 'text/csv' : XLSX_CONTENT_TYPE)
    await database.execute(sql`update ${EXPORT_TABLE(schemaName)} set status = 'COMPLETED', s3_key = ${key}, total_rows = ${rows.length}, completed_at = now(), updated_at = now() where id = ${exportId}`)
}

export const createExport = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    body: unknown
): Promise<Record<string, unknown>> => {
    const format = isRecord(body) ? parseTransferFormat(body['format']) : (() => { throw new TransferInputError('format is required') })()
    const filters = buildFiltersFromBody(body)
    const schemaName = await ensureCompanyLeadTables(companyId)
    const exportId = randomUUID()
    const { rows } = await database.execute(sql`insert into ${EXPORT_TABLE(schemaName)} (id, requested_by, filters, format, status) values (${exportId}, ${userId}, ${JSON.stringify(filters)}, ${format}, 'QUEUED') returning *`)
    const row = rows[0] as Record<string, unknown> | undefined
    if (row === undefined) {
        throw new Error('Export creation failed')
    }
    void processExport(client, storage, companyId, userId, exportId, filters, format).catch(async () => {
        await database.execute(sql`update ${EXPORT_TABLE(schemaName)} set status = 'FAILED', failed_at = now(), updated_at = now() where id = ${exportId}`)
    })
    return toExportResponse(row)
}

export const getExportStatus = async (companyId: string, userId: string, exportId: string): Promise<Record<string, unknown>> => {
    const { row } = await getOwnedExport(companyId, userId, parseUuid(exportId, 'exportId'))
    return toExportResponse(row)
}

export const getExportDownloadUrl = async (
    client: S3Client,
    storage: StorageConfig,
    companyId: string,
    userId: string,
    exportId: string
): Promise<{ downloadUrl: string; expiresIn: number }> => {
    const { row } = await getOwnedExport(companyId, userId, parseUuid(exportId, 'exportId'))
    if (row['status'] !== 'COMPLETED' || typeof row['s3_key'] !== 'string') {
        throw new TransferInputError('Export is not complete')
    }
    if (!row['s3_key'].startsWith(`leads/${companyId}/exports/${exportId}.`)) {
        throw new TransferOwnershipError('The export is not owned by this tenant')
    }
    return { downloadUrl: await createDownloadUrl(client, storage, row['s3_key']), expiresIn: storage.presignExpiresIn }
}

export const isLeadStatus = (value: string): boolean => (LEAD_STATUSES as readonly string[]).includes(value)
