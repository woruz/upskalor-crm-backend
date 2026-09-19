import type { IncomingMessage } from 'node:http'

import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { CACHE_KEYS, CACHE_TTL, getCache, setCache } from '../database/redis.js'
import { database } from '../database/client.js'
import { roles, rolePermissions } from '../database/schema.js'
import { ensureCompanyTables } from '../database/tenants.js'
import { hasCompanyPermission } from '../modules/auth/permissions.js'
import { ROLE_NAMES, type RoleName } from '../modules/auth/rbac.js'
import { authorizeRequest } from './auth.js'

export interface CompanyPermissionRequest {
    resourceName: string
    actionName: string
}

export interface AuthContext {
    id: string
    role: RoleName
    companyId: string
    companySlug: string
    email: string
}

/**
 * Returns the permission set for a given company + role.
 */
const getPermissionSetForRole = async (companyId: string, roleName: string): Promise<Set<string>> => {
    const cacheKey = CACHE_KEYS.permissionSet(companyId, roleName)

    // ── 1. Redis hit ──────────────────────────────────────────────────────────
    const cached = await getCache<string[]>(cacheKey)
    if (cached !== null) {
        return new Set(cached)
    }

    // ── 2. Ensure schema & tenant tables exist (guarded by Redis flag) ───────
    let schemaName = await ensureCompanyTables(companyId)

    let rows: Array<{ resource_name: string; action_name: string }>
    try {
        const result = (await database.execute(
            sql`select resource_name, action_name from ${sql.raw(`"${schemaName}".role_permissions`)} where role_name = ${roleName}`
        )) as unknown as { rows: Array<{ resource_name: string; action_name: string }> }
        rows = result.rows
    } catch (error) {
        if (error instanceof Error && (error.message.includes('does not exist') || error.message.includes('relation'))) {
            schemaName = await ensureCompanyTables(companyId, true)
            const result = (await database.execute(
                sql`select resource_name, action_name from ${sql.raw(`"${schemaName}".role_permissions`)} where role_name = ${roleName}`
            )) as unknown as { rows: Array<{ resource_name: string; action_name: string }> }
            rows = result.rows
        } else {
            throw error
        }
    }

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
): Promise<AuthContext> => {
    const authContext = await authorizeRequest(request, jwtSecret, allowedRoles)
    const permissionSet = await getPermissionSetForRole(authContext.companyId, authContext.role)

    if (!hasCompanyPermission(permissionSet, authContext.role, permission.resourceName, permission.actionName)) {
        throw new Error('User is not authorized for this permission')
    }

    return authContext
}

/**
 * Reusable RBAC role middleware:
 * - Verifies req.user.role is in allowedRoles
 * - super_admin automatically bypasses
 */
export const requireRole = async (
    request: IncomingMessage,
    jwtSecret: string,
    ...allowedRoles: (RoleName | string)[]
): Promise<AuthContext> => {
    const flattened = allowedRoles.flat()
    return authorizeRequest(request, jwtSecret, flattened as RoleName[])
}

/**
 * Reusable RBAC resource permission middleware:
 * - Queries or decodes user permissions for resource
 * - Ensures action exists in granted actions array
 * - super_admin bypasses all resource permission checks
 */
export const requirePermission = async (
    request: IncomingMessage,
    jwtSecret: string,
    resource: string,
    action: string
): Promise<AuthContext> => {
    // Authorize token
    const authContext = await authorizeRequest(request, jwtSecret, [
        ROLE_NAMES.SUPER_ADMIN,
        ROLE_NAMES.ADMIN,
        ROLE_NAMES.USER
    ])

    // super_admin bypasses all resource checks
    if (authContext.role === ROLE_NAMES.SUPER_ADMIN) {
        return authContext
    }

    const normalizedResource = resource.trim().toLowerCase()
    const normalizedAction = action.trim().toLowerCase()
    const cacheKey = CACHE_KEYS.permissionSet(authContext.companyId, authContext.role)

    // Check Redis cache
    const cached = await getCache<string[]>(cacheKey)
    if (cached !== null) {
        const requiredKey = `${authContext.role}:${normalizedResource}:${normalizedAction}`
        if (!cached.includes(requiredKey)) {
            throw new Error(`Role "${authContext.role}" is not authorized for "${action}" on "${resource}"`)
        }
        return authContext
    }

    // Lookup role & role_permissions from root schema
    const [roleRow] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(
            and(
                eq(roles.name, authContext.role),
                or(eq(roles.companyId, authContext.companyId), isNull(roles.companyId), eq(roles.isSystem, true))
            )
        )

    if (!roleRow) {
        throw new Error(`Role "${authContext.role}" does not exist`)
    }

    const rows = await database
        .select({
            resource: rolePermissions.resource,
            actions: rolePermissions.actions
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleRow.id))

    const permissionKeys = rows.flatMap((p) => {
        const res = p.resource.toLowerCase()
        const acts = Array.isArray(p.actions) ? p.actions : []
        return acts.map((act) => `${authContext.role}:${res}:${String(act).toLowerCase()}`)
    })

    await setCache(cacheKey, permissionKeys, CACHE_TTL.PERMISSION_SET)

    const requiredKey = `${authContext.role}:${normalizedResource}:${normalizedAction}`
    if (!permissionKeys.includes(requiredKey)) {
        throw new Error(`Role "${authContext.role}" is not authorized for "${action}" on "${resource}"`)
    }

    return authContext
}
