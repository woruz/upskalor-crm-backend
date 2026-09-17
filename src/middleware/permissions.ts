import type { IncomingMessage } from 'node:http'

import { sql } from 'drizzle-orm'

import { CACHE_KEYS, CACHE_TTL, getCache, setCache } from '../database/redis.js'
import { database } from '../database/client.js'
import { getCompanySchemaNameById } from '../database/tenants.js'
import { hasCompanyPermission } from '../modules/auth/permissions.js'
import { ROLE_NAMES, type RoleName } from '../modules/auth/rbac.js'
import { authorizeRequest } from './auth.js'

export interface CompanyPermissionRequest {
    resourceName: string
    actionName: string
}

/**
 * Returns the permission set for a given company + role.
 *
 * Cache strategy:
 *  - Redis hit  → return immediately (0 DB queries)
 *  - Redis miss → 1 DB query, then cache for CACHE_TTL.PERMISSION_SET seconds
 *
 * The cache is invalidated in `tenants.ts` whenever a permission is upserted
 * or deleted via the admin API, so stale reads are bounded to the TTL.
 */
const getPermissionSetForRole = async (companyId: string, roleName: string): Promise<Set<string>> => {
    const cacheKey = CACHE_KEYS.permissionSet(companyId, roleName)

    // ── 1. Redis hit ──────────────────────────────────────────────────────────
    const cached = await getCache<string[]>(cacheKey)
    if (cached !== null) {
        return new Set(cached)
    }

    // ── 2. DB query — schema name is itself cached, so often 0 extra round-trips
    const schemaName = await getCompanySchemaNameById(companyId)

    const rows = (await database.execute(
        sql`select resource_name, action_name from ${sql.raw(`"${schemaName}".role_permissions`)} where role_name = ${roleName}`
    )) as unknown as Array<{ resource_name: string; action_name: string }>

    const permissionKeys = rows.map(({ resource_name, action_name }) => `${roleName}:${String(resource_name)}:${String(action_name)}`)

    // ── 3. Populate cache ─────────────────────────────────────────────────────
    await setCache(cacheKey, permissionKeys, CACHE_TTL.PERMISSION_SET)

    return new Set(permissionKeys)
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
