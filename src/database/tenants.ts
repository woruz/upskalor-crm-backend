import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import type { PgSchema } from 'drizzle-orm/pg-core'
import { pgSchema } from 'drizzle-orm/pg-core'

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

const createSchema = async (transaction: Parameters<Parameters<typeof database.transaction>[0]>[0], schemaName: string): Promise<void> => {
    resolveCompanySchema(schemaName)
    await transaction.execute(sql.raw(`create schema ${schemaName}`))
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

    await transaction.execute(
        sql.raw(`
        create table if not exists ${schemaName}.role_permissions (
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
            insert into ${schemaName}.role_permissions (role_name, resource_name, action_name)
            values ${values}
            on conflict (role_name, resource_name, action_name) do nothing
        `)
    )
}

export const createCompanyLeadTables = async (transaction: Pick<typeof database, 'execute'>, schemaName: string): Promise<void> => {
    resolveCompanySchema(schemaName)

    await transaction.execute(
        sql.raw(`
        create table if not exists ${schemaName}.leads (
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
        create index if not exists leads_mobile_number_idx on ${schemaName}.leads (mobile_number);
        create index if not exists leads_status_idx on ${schemaName}.leads (status);
        create index if not exists leads_assigned_executive_idx on ${schemaName}.leads (assigned_executive);
        create index if not exists leads_follow_up_date_idx on ${schemaName}.leads (follow_up_date);
        create index if not exists leads_created_at_idx on ${schemaName}.leads (created_at);
        create index if not exists leads_customer_name_lower_idx on ${schemaName}.leads (lower(customer_name));
        create table if not exists ${schemaName}.lead_activities (
            id uuid primary key default gen_random_uuid(),
            lead_id uuid not null references ${schemaName}.leads(id) on delete cascade,
            activity_type varchar(40) not null,
            description varchar(500) not null default '',
            old_value varchar(500),
            new_value varchar(500),
            performed_by uuid not null references root.users(id),
            created_at timestamptz not null default now()
        );
        create index if not exists lead_activities_lead_id_idx on ${schemaName}.lead_activities (lead_id, created_at);
        create table if not exists ${schemaName}.lead_imports (
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
        create index if not exists lead_imports_uploaded_by_idx on ${schemaName}.lead_imports (uploaded_by, created_at);
        create table if not exists ${schemaName}.lead_import_errors (
            id uuid primary key default gen_random_uuid(),
            import_id uuid not null references ${schemaName}.lead_imports(id) on delete cascade,
            row_number integer not null,
            field varchar(100),
            customer_name varchar(150),
            mobile_number varchar(20),
            reason varchar(500) not null,
            created_at timestamptz not null default now()
        );
        create index if not exists lead_import_errors_import_id_idx on ${schemaName}.lead_import_errors (import_id, row_number);
        create table if not exists ${schemaName}.lead_exports (
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
        create index if not exists lead_exports_requested_by_idx on ${schemaName}.lead_exports (requested_by, created_at);
    `)
    )
}

export const ensureCompanyLeadTables = async (companyId: string): Promise<string> => {
    const schemaName = await getCompanySchemaNameById(companyId)
    await createCompanyLeadTables(database, schemaName)
    return schemaName
}

export const ROLE_NAMES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    USER: 'user'
} as const

export const getCompanySchemaNameById = async (companyId: string): Promise<string> => {
    const [company] = await database.select({ schemaName: companies.schemaName }).from(companies).where(eq(companies.id, companyId))

    if (company === undefined) {
        throw new Error('Company not found')
    }

    return company.schemaName
}

export const upsertRolePermission = async (companyId: string, permission: PermissionAssignment): Promise<PermissionAssignment> => {
    const schemaName = await getCompanySchemaNameById(companyId)

    await database.execute(
        sql.raw(`
            insert into ${schemaName}.role_permissions (role_name, resource_name, action_name)
            values ('${permission.roleName}', '${permission.resourceName}', '${permission.actionName}')
            on conflict (role_name, resource_name, action_name)
            do update set updated_at = now()
        `)
    )

    return permission
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

        return { company, owner: registeredOwner }
    })
}
