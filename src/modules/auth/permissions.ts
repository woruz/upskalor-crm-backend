import { ACTION_DEFINITIONS, RESOURCE_DEFINITIONS, type ActionName, type ResourceName } from '../../database/permissions.js'

export interface PermissionAssignment {
    roleName: string
    resourceName: string
    actionName: string
}

export interface RoleAssignment {
    userId: string
    roleName: string
}

const ACTION_NAMES = new Set(ACTION_DEFINITIONS.map((action) => action.name))
const RESOURCE_NAMES = new Set(RESOURCE_DEFINITIONS.map((resource) => resource.name))

export const buildPermissionKey = (roleName: string, resourceName: string, actionName: string): string => {
    return `${roleName}:${resourceName}:${actionName}`
}

export const buildDefaultRolePermissions = (roleName: string): PermissionAssignment[] => {
    return RESOURCE_DEFINITIONS.flatMap(({ name: resourceName }) =>
        ACTION_DEFINITIONS.map(({ name: actionName }) => ({
            roleName,
            resourceName,
            actionName
        }))
    )
}

export const hasCompanyPermission = (
    permissionSet: ReadonlySet<string> | Iterable<string>,
    roleName: string,
    resourceName: string,
    actionName: string
): boolean => {
    const normalizedRoleName = roleName.trim().toLowerCase()
    const normalizedResourceName = resourceName.trim().toLowerCase()
    const normalizedActionName = actionName.trim().toLowerCase()

    if (!RESOURCE_NAMES.has(normalizedResourceName as ResourceName) || !ACTION_NAMES.has(normalizedActionName as ActionName)) {
        return false
    }

    const permissionKey = buildPermissionKey(normalizedRoleName, normalizedResourceName, normalizedActionName)

    for (const permission of permissionSet) {
        if (permission === permissionKey) {
            return true
        }
    }

    return false
}

export const normalizePermissionAssignment = (body: unknown): PermissionAssignment => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('Permission payload must be a JSON object')
    }

    const payload = body as Record<string, unknown>
    const roleName = typeof payload['roleName'] === 'string' ? payload['roleName'].trim().toLowerCase() : ''
    const resourceName = typeof payload['resourceName'] === 'string' ? payload['resourceName'].trim().toLowerCase() : ''
    const actionName = typeof payload['actionName'] === 'string' ? payload['actionName'].trim().toLowerCase() : ''

    if (roleName === '') {
        throw new Error('roleName is required')
    }

    if (!RESOURCE_NAMES.has(resourceName as ResourceName)) {
        throw new Error(`resourceName is invalid: ${resourceName}`)
    }

    if (!ACTION_NAMES.has(actionName as ActionName)) {
        throw new Error(`actionName is invalid: ${actionName}`)
    }

    return {
        roleName,
        resourceName,
        actionName
    }
}

export const normalizeRoleAssignment = (body: unknown): RoleAssignment => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('Role assignment payload must be a JSON object')
    }

    const payload = body as Record<string, unknown>
    const userId = typeof payload['userId'] === 'string' ? payload['userId'].trim() : ''
    const roleName = typeof payload['roleName'] === 'string' ? payload['roleName'].trim().toLowerCase() : ''

    if (userId === '') {
        throw new Error('userId is required')
    }

    if (roleName === '') {
        throw new Error('roleName is required')
    }

    return {
        userId,
        roleName
    }
}

