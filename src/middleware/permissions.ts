import type { IncomingMessage } from 'node:http'

import { and, eq, isNull, or } from 'drizzle-orm'

import { CACHE_KEYS, CACHE_TTL, getCache, setCache } from '../database/redis.js'
import { database } from '../database/client.js'
import { roles, rolePermissions } from '../database/schema.js'
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
 * Queries root.roles & root.role_permissions and caches in Redis.
 */
const getPermissionSetForRole = async (companyId: string, roleName: string): Promise<Set<string>> => {
    const cacheKey = CACHE_KEYS.permissionSet(companyId, roleName)

    // ── 1. Redis hit ──────────────────────────────────────────────────────────
    const cached = await getCache<string[]>(cacheKey)
    if (cached !== null) {
        return new Set(cached)
    }

    // ── 2. Query root.roles & root.role_permissions ──────────────────────────
    const [roleRow] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(
            and(
                eq(roles.name, roleName),
                or(eq(roles.companyId, companyId), isNull(roles.companyId), eq(roles.isSystem, true))
            )
        )

    if (!roleRow) {
        await setCache(cacheKey, [], CACHE_TTL.PERMISSION_SET)
        return new Set()
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
        return acts.map((act) => `${roleName}:${res}:${String(act).toLowerCase()}`)
    })

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
    
    // super_admin bypasses all permission checks
    if (authContext.role === ROLE_NAMES.SUPER_ADMIN) {
        return authContext
    }

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
 * - Queries user permissions for resource from root.role_permissions
 * - Ensures action exists in granted actions array
 * - super_admin bypasses all resource permission checks
 */
export const requirePermission = async (
    request: IncomingMessage,
    jwtSecret: string,
    resource: string,
    action: string
): Promise<AuthContext> => {
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
    const permissionSet = await getPermissionSetForRole(authContext.companyId, authContext.role)

    const requiredKey = `${authContext.role}:${normalizedResource}:${normalizedAction}`
    if (!permissionSet.has(requiredKey)) {
        throw new Error(`Role "${authContext.role}" is not authorized for "${action}" on "${resource}"`)
    }

    return authContext
}
