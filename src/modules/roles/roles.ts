import { randomUUID } from 'node:crypto'

import { and, count, desc, eq, inArray, isNull, or } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { CACHE_KEYS, deleteCache } from '../../database/redis.js'
import { rolePermissions, roles, users } from '../../database/schema.js'

export interface ResourcePermission {
    resource: string
    actions: string[]
}

export interface RoleWithPermissions {
    id: string
    name: string
    displayName: string
    description: string | null
    isSystem: boolean
    userCount: number
    permissions: ResourcePermission[]
    createdAt: string
    updatedAt: string
}

export interface CreateRoleInput {
    name: string
    displayName: string
    description?: string
    permissions: ResourcePermission[]
}

export interface UpdateRoleInput {
    displayName?: string
    description?: string
    permissions?: ResourcePermission[]
}

export class RoleInputError extends Error {
    constructor(
        message: string,
        public code = 'INVALID_INPUT'
    ) {
        super(message)
    }
}

export class RoleNotFoundError extends Error {
    constructor(message = 'Role not found') {
        super(message)
    }
}

export class RoleConflictError extends Error {
    constructor(message: string) {
        super(message)
    }
}

const parseUuid = (value: string, field = 'id'): string => {
    const trimmed = value.trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        throw new RoleInputError(`${field} must be a valid UUID`)
    }
    return trimmed
}

export const listRoles = async (companyId: string): Promise<RoleWithPermissions[]> => {
    parseUuid(companyId, 'companyId')

    // 1. Fetch system roles + company custom roles
    const roleRows = await database
        .select()
        .from(roles)
        .where(or(eq(roles.companyId, companyId), isNull(roles.companyId), eq(roles.isSystem, true)))
        .orderBy(desc(roles.isSystem), roles.name)

    if (roleRows.length === 0) {
        return []
    }

    const roleIds = roleRows.map((r) => r.id)
    const roleNames = roleRows.map((r) => r.name)

    // 2. Fetch all permissions for these roles
    const permissionRows = await database
        .select({
            roleId: rolePermissions.roleId,
            resource: rolePermissions.resource,
            actions: rolePermissions.actions
        })
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleIds))

    const permissionsByRoleId: Record<string, ResourcePermission[]> = {}
    for (const p of permissionRows) {
        let list = permissionsByRoleId[p.roleId]
        if (!list) {
            list = []
            permissionsByRoleId[p.roleId] = list
        }
        list.push({
            resource: p.resource,
            actions: Array.isArray(p.actions) ? p.actions : []
        })
    }

    // 3. Fetch user count per role in this company
    const userCountRows = await database
        .select({
            role: users.role,
            userCount: count()
        })
        .from(users)
        .where(and(eq(users.companyId, companyId), inArray(users.role, roleNames)))
        .groupBy(users.role)

    const userCountByRole: Record<string, number> = {}
    for (const row of userCountRows) {
        userCountByRole[row.role] = Number(row.userCount)
    }

    return roleRows.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.displayName || r.name,
        description: r.description,
        isSystem: r.isSystem,
        userCount: userCountByRole[r.name] ?? 0,
        permissions: permissionsByRoleId[r.id] ?? [],
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString()
    }))
}

export const getRoleById = async (companyId: string, roleId: string): Promise<RoleWithPermissions> => {
    parseUuid(companyId, 'companyId')
    parseUuid(roleId, 'roleId')

    const [roleRow] = await database
        .select()
        .from(roles)
        .where(and(eq(roles.id, roleId), or(eq(roles.companyId, companyId), isNull(roles.companyId), eq(roles.isSystem, true))))

    if (!roleRow) {
        throw new RoleNotFoundError()
    }

    const permissionRows = await database
        .select({
            resource: rolePermissions.resource,
            actions: rolePermissions.actions
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleRow.id))

    const [countRow] = await database
        .select({ userCount: count() })
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.role, roleRow.name)))

    return {
        id: roleRow.id,
        name: roleRow.name,
        displayName: roleRow.displayName || roleRow.name,
        description: roleRow.description,
        isSystem: roleRow.isSystem,
        userCount: Number(countRow?.userCount ?? 0),
        permissions: permissionRows.map((p) => ({
            resource: p.resource,
            actions: Array.isArray(p.actions) ? p.actions : []
        })),
        createdAt: roleRow.createdAt.toISOString(),
        updatedAt: roleRow.updatedAt.toISOString()
    }
}

export const createRole = async (companyId: string, input: CreateRoleInput): Promise<RoleWithPermissions> => {
    parseUuid(companyId, 'companyId')

    const normalizedName = input.name.trim().toLowerCase()
    if (!/^[a-z0-9_]{2,60}$/.test(normalizedName)) {
        throw new RoleInputError('Role name must be between 2 and 60 lowercase alphanumeric characters or underscores')
    }

    const displayName = input.displayName.trim()
    if (displayName.length < 2 || displayName.length > 120) {
        throw new RoleInputError('displayName must be between 2 and 120 characters')
    }

    // Check conflict
    const [existing] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, normalizedName), or(eq(roles.companyId, companyId), isNull(roles.companyId))))

    if (existing) {
        throw new RoleConflictError(`A role with name "${normalizedName}" already exists`)
    }

    const newId = randomUUID()
    const description = input.description?.trim() ?? ''

    const [created] = await database
        .insert(roles)
        .values({
            id: newId,
            name: normalizedName,
            displayName,
            description,
            isSystem: false,
            companyId
        })
        .returning()

    if (!created) {
        throw new Error('Failed to create role')
    }

    // Insert permissions if any
    const permissions: ResourcePermission[] = []
    if (Array.isArray(input.permissions) && input.permissions.length > 0) {
        for (const p of input.permissions) {
            const resource = String(p.resource || '').trim().toLowerCase()
            const actions = Array.isArray(p.actions) ? p.actions.map((a) => String(a).trim().toLowerCase()) : []
            if (!resource) continue

            await database.insert(rolePermissions).values({
                id: randomUUID(),
                roleId: created.id,
                resource,
                actions
            })

            permissions.push({ resource, actions })
        }
    }

    await deleteCache(CACHE_KEYS.permissionSet(companyId, normalizedName))

    return {
        id: created.id,
        name: created.name,
        displayName: created.displayName,
        description: created.description,
        isSystem: created.isSystem,
        userCount: 0,
        permissions,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString()
    }
}

export const updateRole = async (
    companyId: string,
    roleId: string,
    input: UpdateRoleInput
): Promise<RoleWithPermissions> => {
    parseUuid(companyId, 'companyId')
    parseUuid(roleId, 'roleId')

    const [existing] = await database
        .select()
        .from(roles)
        .where(and(eq(roles.id, roleId), or(eq(roles.companyId, companyId), isNull(roles.companyId), eq(roles.isSystem, true))))

    if (!existing) {
        throw new RoleNotFoundError()
    }

    const updates: Record<string, unknown> = {
        ['updatedAt']: new Date()
    }

    if (input.displayName !== undefined) {
        const trimmed = input.displayName.trim()
        if (trimmed.length < 2 || trimmed.length > 120) {
            throw new RoleInputError('displayName must be between 2 and 120 characters')
        }
        updates['displayName'] = trimmed
    }

    if (input.description !== undefined) {
        updates['description'] = input.description.trim()
    }

    const [updated] = await database.update(roles).set(updates).where(eq(roles.id, roleId)).returning()
    if (!updated) {
        throw new RoleNotFoundError()
    }

    // Sync permissions if provided
    let permissions: ResourcePermission[] = []
    if (Array.isArray(input.permissions)) {
        await database.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))

        for (const p of input.permissions) {
            const resource = String(p.resource || '').trim().toLowerCase()
            const actions = Array.isArray(p.actions) ? p.actions.map((a) => String(a).trim().toLowerCase()) : []
            if (!resource) continue

            await database.insert(rolePermissions).values({
                id: randomUUID(),
                roleId: existing.id,
                resource,
                actions
            })

            permissions.push({ resource, actions })
        }

        await deleteCache(CACHE_KEYS.permissionSet(companyId, existing.name))
    } else {
        const pRows = await database
            .select({ resource: rolePermissions.resource, actions: rolePermissions.actions })
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId))

        permissions = pRows.map((p) => ({ resource: p.resource, actions: p.actions }))
    }

    const [countRow] = await database
        .select({ userCount: count() })
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.role, existing.name)))

    return {
        id: updated.id,
        name: updated.name,
        displayName: updated.displayName,
        description: updated.description,
        isSystem: updated.isSystem,
        userCount: Number(countRow?.userCount ?? 0),
        permissions,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString()
    }
}

export const deleteRole = async (companyId: string, roleId: string): Promise<void> => {
    parseUuid(companyId, 'companyId')
    parseUuid(roleId, 'roleId')

    const [role] = await database
        .select()
        .from(roles)
        .where(eq(roles.id, roleId))

    if (!role) {
        throw new RoleNotFoundError()
    }

    if (role.isSystem) {
        throw new RoleInputError('Cannot delete system role', 'SYSTEM_ROLE_PROTECTED')
    }

    if (role.companyId !== companyId) {
        throw new RoleInputError('You are not authorized to delete this role', 'FORBIDDEN')
    }

    // Check if any users in company have this role
    const [assignedCount] = await database
        .select({ cnt: count() })
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.role, role.name)))

    if (Number(assignedCount?.cnt ?? 0) > 0) {
        throw new RoleConflictError('Cannot delete role that is currently assigned to users. Please reassign users first.')
    }

    await database.delete(roles).where(eq(roles.id, roleId))
    await deleteCache(CACHE_KEYS.permissionSet(companyId, role.name))
}
