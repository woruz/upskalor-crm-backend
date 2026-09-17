import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import type { PgSchema } from 'drizzle-orm/pg-core'
import { pgSchema } from 'drizzle-orm/pg-core'

import { CACHE_KEYS, CACHE_TTL, deleteCache, getCache, setCache } from './redis.js'
import { database } from './client.js'
import { ACTION_DEFINITIONS, RESOURCE_DEFINITIONS } from './permissions.js'
import { companies, roles, users } from './schema.js'
import type { PermissionAssignment, RoleAssignment } from '../modules/auth/permissions.js'

const COMPANY_SCHEMA_PREFIX = 'company_'
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

export interface NewCompany {
    name: string
    slug: string
    owner: NewCompanyOwner
}

export interface NewCompanyOwner {
    email: string
    firstName: string
    lastName: string
    passwordHash: string
}

export const createCompanySchemaName = (companyId: string): string => {
    const normalizedId = companyId.replaceAll('-', '').toLowerCase()

    if (!/^[0-9a-f]{32}$/.test(normalizedId)) {
        throw new Error('Company ID must be a UUID')
    }

    return `${COMPANY_SCHEMA_PREFIX}${normalizedId}`
}

export const resolveCompanySchema = (schemaName: string): PgSchema => {
    if (!SCHEMA_NAME_PATTERN.test(schemaName) || schemaName.startsWith('pg_') || schemaName === 'root') {
        throw new Error('Invalid company schema name')
    }

    return pgSchema(schemaName)
}

export const resolveCompanySchemaById = async (companyId: string): Promise<PgSchema> => {
    const [company] = await database.select({ schemaName: companies.schemaName }).from(companies).where(eq(companies.id, companyId))

    if (company === undefined) {
        throw new Error('Company not found')
    }

    return resolveCompanySchema(company.schemaName)
}

/**
 * Returns the double-quoted schema identifier safe for embedding in sql.raw().
 * e.g. "company_abc123" — PostgreSQL treats it as an identifier, not syntax.
 */
const quotedSchema = (schemaName: string): string => `"${schemaName}"`

const createSchema = async (transaction: Parameters<Parameters<typeof database.transaction>[0]>[0], schemaName: string): Promise<void> => {
    resolveCompanySchema(schemaName)
    await transaction.execute(sql.raw(`create schema ${quotedSchema(schemaName)}`))
}

const buildDefaultCompanyPermissions = (roleName: string): Array<{ roleName: string; resourceName: string; actionName: string }> => {
    return RESOURCE_DEFINITIONS.flatMap(({ name: resourceName }) =>
        ACTION_DEFINITIONS.map(({ name: actionName }) => ({
            roleName,
            resourceName,
            actionName
        }))
    )
}

export const createCompanyPermissionTables = async (
    transaction: Parameters<Parameters<typeof database.transaction>[0]>[0],
    schemaName: string
): Promise<void> => {
    resolveCompanySchema(schemaName)
    const qs = quotedSchema(schemaName)

    await transaction.execute(
        sql.raw(`
        create table if not exists ${qs}.role_permissions (
            id uuid primary key default gen_random_uuid(),
            role_name varchar(30) not null,
            resource_name varchar(60) not null,
            action_name varchar(30) not null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (role_name, resource_name, action_name)
        )
    `)
    )

    const defaultPermissions = [
        ...buildDefaultCompanyPermissions(ROLE_NAMES.SUPER_ADMIN),
        ...buildDefaultCompanyPermissions(ROLE_NAMES.ADMIN),
        ...buildDefaultCompanyPermissions(ROLE_NAMES.USER)
    ]

    if (defaultPermissions.length === 0) {
        return
    }

    const values = defaultPermissions
        .map(({ roleName, resourceName, actionName }) => `('${roleName}', '${resourceName}', '${actionName}')`)
        .join(', ')

    await transaction.execute(
        sql.raw(`
            insert into ${qs}.role_permissions (role_name, resource_name, action_name)
            values ${values}
            on conflict (role_name, resource_name, action_name) do nothing
        `)
    )
}

export const createCompanyLeadTables = async (transaction: Pick<typeof database, 'execute'>, schemaName: string): Promise<void> => {
    resolveCompanySchema(schemaName)
    const qs = quotedSchema(schemaName)

    await transaction.execute(
        sql.raw(`
        create table if not exists ${qs}.leads (
            id uuid primary key default gen_random_uuid(),
            customer_name varchar(150) not null,
            mobile_number varchar(20) not null,
            email varchar(320),
            address varchar(500),
            monthly_bill_amount numeric(12, 2),
            follow_up_date timestamptz not null,
            state varchar(100),
            city varchar(100),
            roof_ownership varchar(100),
            roof_type varchar(100),
            lead_source varchar(100),
            assigned_executive uuid references root.users(id),
            status varchar(30) not null default 'NEW',
            created_by uuid not null references root.users(id),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            deleted_at timestamptz
        );
        create index if not exists leads_mobile_number_idx on ${qs}.leads (mobile_number);
        create index if not exists leads_status_idx on ${qs}.leads (status);
        create index if not exists leads_assigned_executive_idx on ${qs}.leads (assigned_executive);
        create index if not exists leads_follow_up_date_idx on ${qs}.leads (follow_up_date);
        create index if not exists leads_created_at_idx on ${qs}.leads (created_at);
        create index if not exists leads_customer_name_lower_idx on ${qs}.leads (lower(customer_name));
        create table if not exists ${qs}.lead_activities (
            id uuid primary key default gen_random_uuid(),
            lead_id uuid not null references ${qs}.leads(id) on delete cascade,
            activity_type varchar(40) not null,
            description varchar(500) not null default '',
            old_value varchar(500),
            new_value varchar(500),
            performed_by uuid not null references root.users(id),
            created_at timestamptz not null default now()
        );
        create index if not exists lead_activities_lead_id_idx on ${qs}.lead_activities (lead_id, created_at);
        create table if not exists ${qs}.lead_imports (
            id uuid primary key default gen_random_uuid(),
            file_name varchar(255) not null,
            s3_key varchar(500) not null unique,
            uploaded_by uuid not null references root.users(id),
            status varchar(30) not null,
            total_rows integer not null default 0,
            successful_rows integer not null default 0,
            failed_rows integer not null default 0,
            duplicate_rows integer not null default 0,
            error_file_key varchar(500),
            started_at timestamptz,
            completed_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
        create index if not exists lead_imports_uploaded_by_idx on ${qs}.lead_imports (uploaded_by, created_at);
        create table if not exists ${qs}.lead_import_errors (
            id uuid primary key default gen_random_uuid(),
            import_id uuid not null references ${qs}.lead_imports(id) on delete cascade,
            row_number integer not null,
            field varchar(100),
            customer_name varchar(150),
            mobile_number varchar(20),
            reason varchar(500) not null,
            created_at timestamptz not null default now()
        );
        create index if not exists lead_import_errors_import_id_idx on ${qs}.lead_import_errors (import_id, row_number);
        create table if not exists ${qs}.lead_exports (
            id uuid primary key default gen_random_uuid(),
            requested_by uuid not null references root.users(id),
            filters jsonb not null default '{}'::jsonb,
            format varchar(10) not null,
            status varchar(20) not null,
            s3_key varchar(500) unique,
            total_rows integer not null default 0,
            created_at timestamptz not null default now(),
            completed_at timestamptz,
            failed_at timestamptz,
            updated_at timestamptz not null default now()
        );
        create index if not exists lead_exports_requested_by_idx on ${qs}.lead_exports (requested_by, created_at);
    `)
    )
}

export const createCompanyQuotationTables = async (transaction: Pick<typeof database, 'execute'>, schemaName: string): Promise<void> => {
    resolveCompanySchema(schemaName)
    const qs = quotedSchema(schemaName)

    await transaction.execute(
        sql.raw(`
        create table if not exists ${qs}.quotations (
            id uuid primary key default gen_random_uuid(),
            lead_id uuid references ${qs}.leads(id) on delete set null,
            quote_number varchar(50) not null,
            system_size_kw numeric(8, 2) not null,
            validity_date timestamptz not null,
            payment_terms_template varchar(100) not null default 'Custom Terms',
            advance_percentage numeric(5, 2) not null default 30,
            delivery_percentage numeric(5, 2) not null default 50,
            commissioning_percentage numeric(5, 2) not null default 20,
            state_subsidy_cap_override numeric(12, 2),
            lead_state varchar(100),
            subtotal numeric(12, 2) not null default 0,
            total_gst numeric(12, 2) not null default 0,
            grand_total numeric(12, 2) not null default 0,
            central_subsidy numeric(12, 2) not null default 0,
            state_subsidy numeric(12, 2) not null default 0,
            net_customer_cost numeric(12, 2) not null default 0,
            status varchar(30) not null default 'DRAFT',
            notes text,
            created_by uuid not null references root.users(id),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            deleted_at timestamptz,
            unique (quote_number)
        );
        create index if not exists quotations_lead_id_idx on ${qs}.quotations (lead_id);
        create index if not exists quotations_quote_number_idx on ${qs}.quotations (quote_number);
        create index if not exists quotations_status_idx on ${qs}.quotations (status);
        create index if not exists quotations_created_at_idx on ${qs}.quotations (created_at);
        create index if not exists quotations_deleted_at_idx on ${qs}.quotations (deleted_at);

        create table if not exists ${qs}.quotation_items (
            id uuid primary key default gen_random_uuid(),
            quotation_id uuid not null references ${qs}.quotations(id) on delete cascade,
            product_id uuid,
            name varchar(200) not null,
            brand varchar(150),
            quantity numeric(10, 2) not null default 1,
            rate numeric(12, 2) not null,
            gst_rate numeric(5, 2) not null default 0,
            total numeric(12, 2) not null,
            sort_order integer not null default 0,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
        create index if not exists quotation_items_quotation_id_idx on ${qs}.quotation_items (quotation_id, sort_order);
    `)
    )
}

export const ROLE_NAMES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    USER: 'user'
} as const

/**
 * Fetches the schema name for a company from the database.
 * Result is cached in Redis for CACHE_TTL.COMPANY_SCHEMA seconds.
 */
export const getCompanySchemaNameById = async (companyId: string): Promise<string> => {
    // ── 1. Cache hit ──────────────────────────────────────────────────────────
    const cached = await getCache<string>(CACHE_KEYS.companySchema(companyId))
    if (cached !== null) return cached

    // ── 2. DB query ───────────────────────────────────────────────────────────
    const [company] = await database
        .select({ schemaName: companies.schemaName })
        .from(companies)
        .where(eq(companies.id, companyId))

    if (company === undefined) {
        throw new Error('Company not found')
    }

    // ── 3. Populate cache ─────────────────────────────────────────────────────
    await setCache(CACHE_KEYS.companySchema(companyId), company.schemaName, CACHE_TTL.COMPANY_SCHEMA)

    return company.schemaName
}

/**
 * Returns the schema name for the company, running `CREATE TABLE IF NOT EXISTS`
 * only on the very first request per company (flag cached in Redis with 24h TTL).
 * On subsequent requests the Redis flag short-circuits the DDL entirely.
 */
export const ensureCompanyLeadTables = async (companyId: string): Promise<string> => {
    // ── 1. Check init flag ────────────────────────────────────────────────────
    const initKey = CACHE_KEYS.tenantInitialized(companyId)
    const initialized = await getCache<boolean>(initKey)

    if (initialized === true) {
        // Tables exist and schema name is cached — fast path, no DDL/DB
        const schemaName = await getCompanySchemaNameById(companyId)
        return schemaName
    }

    // ── 2. First-time: fetch schema name and ensure all tenant tables ─────────
    const schemaName = await getCompanySchemaNameById(companyId)
    await createCompanyLeadTables(database, schemaName)
    await createCompanyQuotationTables(database, schemaName)

    // ── 3. Set the init flag so DDL never runs again ──────────────────────────
    await setCache(initKey, true, CACHE_TTL.TENANT_INITIALIZED)

    return schemaName
}

/**
 * Returns the schema name, ensuring tenant tables exist.
 * Reuses the single tenantInitialized Redis guard.
 */
export const ensureCompanyQuotationTables = async (companyId: string): Promise<string> => {
    return ensureCompanyLeadTables(companyId)
}

export const upsertRolePermission = async (companyId: string, permission: PermissionAssignment): Promise<PermissionAssignment> => {
    const schemaName = await getCompanySchemaNameById(companyId)
    const qs = quotedSchema(schemaName)

    await database.execute(
        sql.raw(`
            insert into ${qs}.role_permissions (role_name, resource_name, action_name)
            values ('${permission.roleName}', '${permission.resourceName}', '${permission.actionName}')
            on conflict (role_name, resource_name, action_name)
            do update set updated_at = now()
        `)
    )

    // Invalidate cached permission set for this role so the change takes effect immediately
    await deleteCache(CACHE_KEYS.permissionSet(companyId, permission.roleName))

    return permission
}

export const deleteRolePermission = async (companyId: string, permission: PermissionAssignment): Promise<void> => {
    const schemaName = await getCompanySchemaNameById(companyId)
    const qs = quotedSchema(schemaName)

    await database.execute(
        sql.raw(`
            delete from ${qs}.role_permissions
            where role_name = '${permission.roleName}'
              and resource_name = '${permission.resourceName}'
              and action_name = '${permission.actionName}'
        `)
    )

    await deleteCache(CACHE_KEYS.permissionSet(companyId, permission.roleName))
}

export const assignUserRole = async (companyId: string, assignment: RoleAssignment): Promise<RoleAssignment> => {
    const [role] = await database.select({ name: roles.name }).from(roles).where(eq(roles.name, assignment.roleName))

    if (role === undefined) {
        throw new Error('Role not found')
    }

    const [user] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, assignment.userId), eq(users.companyId, companyId)))

    if (user === undefined) {
        throw new Error('User not found in company')
    }

    await database
        .update(users)
        .set({
            role: assignment.roleName,
            updatedAt: new Date()
        })
        .where(and(eq(users.id, assignment.userId), eq(users.companyId, companyId)))

    return assignment
}

export const registerCompany = async ({
    name,
    slug,
    owner
}: NewCompany): Promise<{
    company: typeof companies.$inferSelect
    owner: typeof users.$inferSelect
}> => {
    const companyId = randomUUID()
    const schemaName = createCompanySchemaName(companyId)

    return database.transaction(async (transaction) => {
        await createSchema(transaction, schemaName)
        await createCompanyPermissionTables(transaction, schemaName)
        await createCompanyLeadTables(transaction, schemaName)
        await createCompanyQuotationTables(transaction, schemaName)

        await transaction
            .insert(roles)
            .values([
                { name: ROLE_NAMES.SUPER_ADMIN, description: 'Company owner and full access administrator' },
                { name: ROLE_NAMES.ADMIN, description: 'Company manager with administrative access' },
                { name: ROLE_NAMES.USER, description: 'Standard company user' }
            ])
            .onConflictDoNothing()

        const [company] = await transaction
            .insert(companies)
            .values({
                id: companyId,
                name,
                slug,
                schemaName
            })
            .returning()

        if (company === undefined) {
            throw new Error('Company registration failed')
        }

        const [registeredOwner] = await transaction
            .insert(users)
            .values({
                id: randomUUID(),
                companyId,
                email: owner.email,
                firstName: owner.firstName,
                lastName: owner.lastName,
                passwordHash: owner.passwordHash,
                role: ROLE_NAMES.SUPER_ADMIN
            })
            .returning()

        if (registeredOwner === undefined) {
            throw new Error('Owner registration failed')
        }

        // Pre-warm cache so the first request is already fast
        await setCache(CACHE_KEYS.companySchema(companyId), schemaName, CACHE_TTL.COMPANY_SCHEMA)
        await setCache(CACHE_KEYS.tenantInitialized(companyId), true, CACHE_TTL.TENANT_INITIALIZED)

        return { company, owner: registeredOwner }
    })
}
