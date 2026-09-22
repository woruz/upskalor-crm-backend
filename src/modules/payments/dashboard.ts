import { sql, type SQL } from 'drizzle-orm'
import { database } from '../../database/client.js'
import { ensureCompanyPaymentTables } from '../../database/tenants.js'
import { roundToTwo } from './invoices.js'
import {
    type MilestoneFilters,
    type OutstandingFilters,
    PaymentInputError
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

export const getPaymentDashboardKpis = async (
    companyId: string,
    month?: number | undefined,
    year?: number | undefined
): Promise<{
    totalOutstanding: number
    collectionsThisMonth: number
    overdueReceivables: number
    totalProjects: number
    totalReceipts: number
    collectionsTrend: Array<{ month: string; amount: number }>
}> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)
    const rTable = receiptTable(schemaName)

    const now = new Date()
    const targetMonth = month && month >= 1 && month <= 12 ? month : now.getUTCMonth() + 1
    const targetYear = year && year >= 2000 && year <= 2100 ? year : now.getUTCFullYear()

    // 1. Total Outstanding = sum of (amount_due - paid_amount) across active projects
    const { rows: outstandingRows } = await database.execute(sql`
        select coalesce(sum(m.amount_due - m.paid_amount), 0) as total_outstanding
        from ${mTable} m
        join ${pTable} p on p.id = m.project_id
        where p.status = 'ACTIVE' and p.deleted_at is null and m.deleted_at is null
    `)
    const totalOutstanding = roundToTwo(Number((outstandingRows[0] as unknown as { total_outstanding: string | number })?.total_outstanding ?? 0))

    // 2. Collections This Month
    const startOfMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0))
    const endOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999))

    const { rows: collectionRows } = await database.execute(sql`
        select coalesce(sum(amount), 0) as collections_month
        from ${rTable}
        where status = 'Successful'
          and payment_date >= ${startOfMonth.toISOString()}
          and payment_date <= ${endOfMonth.toISOString()}
          and deleted_at is null
    `)
    const collectionsThisMonth = roundToTwo(Number((collectionRows[0] as unknown as { collections_month: string | number })?.collections_month ?? 0))

    // 3. Overdue Receivables
    const { rows: overdueRows } = await database.execute(sql`
        select coalesce(sum(amount_due - paid_amount), 0) as overdue
        from ${mTable}
        where due_date < now()
          and status != 'Received'
          and deleted_at is null
    `)
    const overdueReceivables = roundToTwo(Number((overdueRows[0] as unknown as { overdue: string | number })?.overdue ?? 0))

    // 4. Total Active Projects
    const { rows: projCountRows } = await database.execute(sql`
        select count(*) as cnt from ${pTable} where status = 'ACTIVE' and deleted_at is null
    `)
    const totalProjects = Number((projCountRows[0] as unknown as { cnt: string | number })?.cnt ?? 0)

    // 5. Total Receipts
    const { rows: receiptCountRows } = await database.execute(sql`
        select count(*) as cnt from ${rTable} where status = 'Successful' and deleted_at is null
    `)
    const totalReceipts = Number((receiptCountRows[0] as unknown as { cnt: string | number })?.cnt ?? 0)

    // 6. Collections Trend (last 6 months)
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const trendMonths: Array<{ monthStr: string; start: Date; end: Date }> = []

    for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(targetYear, targetMonth - 1 - i, 1))
        const m = d.getUTCMonth()
        const y = d.getUTCFullYear()
        const start = new Date(Date.UTC(y, m, 1, 0, 0, 0))
        const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999))
        trendMonths.push({
            monthStr: `${monthNames[m]} ${y}`,
            start,
            end
        })
    }

    const collectionsTrend: Array<{ month: string; amount: number }> = []
    for (const item of trendMonths) {
        const { rows } = await database.execute(sql`
            select coalesce(sum(amount), 0) as amt
            from ${rTable}
            where status = 'Successful'
              and payment_date >= ${item.start.toISOString()}
              and payment_date <= ${item.end.toISOString()}
              and deleted_at is null
        `)
        const amt = roundToTwo(Number((rows[0] as unknown as { amt: string | number })?.amt ?? 0))
        collectionsTrend.push({ month: item.monthStr, amount: amt })
    }

    return {
        totalOutstanding,
        collectionsThisMonth,
        overdueReceivables,
        totalProjects,
        totalReceipts,
        collectionsTrend
    }
}

export const listOutstandingPayments = async (
    companyId: string,
    filters: OutstandingFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const pTable = projectTable(schemaName)
    const mTable = milestoneTable(schemaName)

    const conditions: SQL[] = [sql`p.deleted_at is null`]

    if (filters.search) {
        const searchPattern = `%${filters.search}%`
        conditions.push(sql`(p.project_name ilike ${searchPattern} or p.customer_name ilike ${searchPattern})`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        balance: 'balance',
        totalDue: 'total_due',
        projectName: 'p.project_name'
    } as const
    const orderCol = sortColumns[filters.sortBy] ?? 'balance'
    const orderDirection = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const offset = (filters.page - 1) * filters.limit

    const { rows } = await database.execute(sql`
        with project_milestones as (
            select p.id,
                   p.project_name,
                   p.customer_name,
                   p.status as project_status,
                   coalesce(sum(m.amount_due), 0) as total_due,
                   coalesce(sum(m.paid_amount), 0) as received,
                   coalesce(sum(m.amount_due - m.paid_amount), 0) as balance,
                   coalesce(sum(case when m.due_date < now() and m.status != 'Received' then (m.amount_due - m.paid_amount) else 0 end), 0) as overdue_amount,
                   max(case when m.due_date < now() and m.status != 'Received' then 1 else 0 end) as has_overdue
            from ${pTable} p
            left join ${mTable} m on m.project_id = p.id and m.deleted_at is null
            where ${where}
            group by p.id, p.project_name, p.customer_name, p.status
            having coalesce(sum(m.amount_due - m.paid_amount), 0) > 0
        ),
        counted as (
            select *,
                   count(*) over() as _total_count
            from project_milestones
        )
        select * from counted
        order by ${sql.raw(`${orderCol.replace('p.', '')} ${orderDirection}`)}
        limit ${filters.limit} offset ${offset}
    `)

    interface OutstandingRow {
        id: string
        project_name: string
        customer_name: string
        project_status: string
        total_due: string | number
        received: string | number
        balance: string | number
        overdue_amount: string | number
        has_overdue: number
        _total_count: string | number
    }

    const typedRows = rows as unknown as OutstandingRow[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    const formattedData = typedRows.map((r) => {
        const bal = roundToTwo(Number(r.balance))
        let displayStatus = 'In Progress'
        if (bal === 0) {
            displayStatus = 'Completed'
        } else if (Number(r.has_overdue) === 1) {
            displayStatus = 'Overdue'
        }

        return {
            id: r.id,
            projectName: r.project_name,
            customerName: r.customer_name,
            totalDue: roundToTwo(Number(r.total_due)),
            received: roundToTwo(Number(r.received)),
            balance: bal,
            overdueAmount: roundToTwo(Number(r.overdue_amount)),
            status: displayStatus
        }
    })

    return { data: formattedData, total }
}

export const listPaymentMilestones = async (
    companyId: string,
    filters: MilestoneFilters
): Promise<{ data: Record<string, unknown>[]; total: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const mTable = milestoneTable(schemaName)
    const pTable = projectTable(schemaName)

    const conditions: SQL[] = [sql`m.deleted_at is null`]

    if (filters.search) {
        const searchPattern = `%${filters.search}%`
        conditions.push(sql`(p.project_name ilike ${searchPattern} or m.milestone_name ilike ${searchPattern})`)
    }

    if (filters.status) {
        conditions.push(sql`m.status = ${filters.status}`)
    }

    if (filters.projectId) {
        parseUuid(filters.projectId, 'projectId')
        conditions.push(sql`m.project_id = ${filters.projectId}`)
    }

    const where = sql.join(conditions, sql` and `)
    const sortColumns = {
        dueDate: 'm.due_date',
        amountDue: 'm.amount_due',
        projectName: 'p.project_name'
    } as const
    const orderCol = sortColumns[filters.sortBy] ?? 'm.due_date'
    const orderDirection = filters.sortOrder === 'asc' ? 'asc' : 'desc'
    const offset = (filters.page - 1) * filters.limit

    const { rows } = await database.execute(sql`
        with filtered as (
            select m.*,
                   p.project_name,
                   count(*) over() as _total_count
            from ${mTable} m
            left join ${pTable} p on p.id = m.project_id
            where ${where}
        )
        select * from filtered
        order by ${sql.raw(`${orderCol.replace('m.', '').replace('p.', '')} ${orderDirection}`)} nulls last
        limit ${filters.limit} offset ${offset}
    `)

    interface MilestoneScheduleRow {
        id: string
        project_id: string
        milestone_name: string
        amount_due: string | number
        paid_amount: string | number
        due_date: Date | string | null
        status: string
        project_name: string | null
        _total_count: string | number
    }

    const typedRows = rows as unknown as MilestoneScheduleRow[]
    const total = typedRows[0] !== undefined ? Number(typedRows[0]._total_count) : 0

    const formattedData = typedRows.map((r) => ({
        id: r.id,
        projectName: r.project_name ?? 'Project',
        milestoneName: r.milestone_name,
        amountDue: roundToTwo(Number(r.amount_due)),
        paidAmount: roundToTwo(Number(r.paid_amount)),
        dueDate: r.due_date ? new Date(r.due_date).toISOString() : null,
        status: r.status,
        projectId: r.project_id
    }))

    return { data: formattedData, total }
}

export const checkOverdueMilestones = async (
    companyId: string
): Promise<{ milestonesUpdated: number; invoicesUpdated: number }> => {
    const schemaName = await ensureCompanyPaymentTables(companyId)
    const mTable = milestoneTable(schemaName)
    const iTable = invoiceTable(schemaName)

    // Update milestones
    const { rows: msRows } = await database.execute(sql`
        update ${mTable}
        set status = 'Overdue', updated_at = now()
        where due_date < now()
          and status in ('Pending', 'Partially Received')
          and deleted_at is null
        returning id
    `)

    // Update invoices
    const { rows: invRows } = await database.execute(sql`
        update ${iTable}
        set status = 'Overdue', updated_at = now()
        where due_date < now()
          and status = 'Unpaid'
          and deleted_at is null
        returning id
    `)

    return {
        milestonesUpdated: msRows.length,
        invoicesUpdated: invRows.length
    }
}
