import type { IncomingMessage } from 'node:http'

import { eq, sql } from 'drizzle-orm'

import { database } from '../database/client.js'
import { companies } from '../database/schema.js'
import { hasCompanyPermission } from '../modules/auth/permissions.js'
import { ROLE_NAMES, type RoleName } from '../modules/auth/rbac.js'
import { authorizeRequest } from './auth.js'

export interface CompanyPermissionRequest {
    resourceName: string
    actionName: string
}

const getPermissionSetForRole = async (companyId: string, roleName: string): Promise<Set<string>> => {
    const [company] = await database.select({ schemaName: companies.schemaName }).from(companies).where(eq(companies.id, companyId))

    if (company === undefined) {
        throw new Error('Company not found')
    }

    const schemaName = company.schemaName
    const rows = (await database.execute(
        sql`select resource_name, action_name from ${sql.raw(`${schemaName}.role_permissions`)} where role_name = ${roleName}`
    )) as unknown as Array<{ resource_name: string; action_name: string }>

    return new Set(rows.map(({ resource_name, action_name }) => `${roleName}:${String(resource_name)}:${String(action_name)}`))
}

export const requireCompanyPermission = async (
    request: IncomingMessage,
    jwtSecret: string,
    permission: CompanyPermissionRequest,
    allowedRoles: RoleName | RoleName[] = [ROLE_NAMES.SUPER_ADMIN, ROLE_NAMES.ADMIN]
): Promise<{ id: string; role: RoleName; companyId: string; companySlug: string; email: string }> => {
    const authContext = await authorizeRequest(request, jwtSecret, allowedRoles)
    const permissionSet = await getPermissionSetForRole(authContext.companyId, authContext.role)

    if (!hasCompanyPermission(permissionSet, authContext.role, permission.resourceName, permission.actionName)) {
        throw new Error('User is not authorized for this permission')
    }

    return authContext
}

