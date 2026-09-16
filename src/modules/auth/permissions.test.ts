import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_DEFINITIONS, RESOURCE_DEFINITIONS } from '../../database/permissions.js'
import {
    buildDefaultRolePermissions,
    normalizePermissionAssignment,
    buildPermissionKey,
    hasCompanyPermission,
    normalizeRoleAssignment
} from './permissions.js'

test('normalizePermissionAssignment accepts valid company permission payload', () => {
    const payload = normalizePermissionAssignment({
        roleName: 'admin',
        resourceName: 'contacts',
        actionName: 'read'
    })

    assert.deepEqual(payload, {
        roleName: 'admin',
        resourceName: 'contacts',
        actionName: 'read'
    })
})

test('normalizePermissionAssignment rejects unknown resource', () => {
    assert.throws(
        () =>
            normalizePermissionAssignment({
                roleName: 'admin',
                resourceName: 'invalid-resource',
                actionName: 'read'
            }),
        /resource/i
    )
})

test('buildPermissionKey returns a stable company-scoped key', () => {
    assert.equal(buildPermissionKey('admin', 'contacts', 'read'), 'admin:contacts:read')
})

test('buildDefaultRolePermissions seeds a full access profile for super_admin', () => {
    const permissions = buildDefaultRolePermissions('super_admin')

    assert.equal(permissions.length, RESOURCE_DEFINITIONS.length * ACTION_DEFINITIONS.length)
    assert.ok(
        permissions.some(
            ({ roleName, resourceName, actionName }) => roleName === 'super_admin' && resourceName === 'users' && actionName === 'create'
        )
    )
    assert.ok(
        permissions.some(
            ({ roleName, resourceName, actionName }) => roleName === 'super_admin' && resourceName === 'files' && actionName === 'delete'
        )
    )
})

test('normalizeRoleAssignment accepts valid role assignment payload', () => {
    const assignment = normalizeRoleAssignment({
        userId: '123e4567-e89b-12d3-a456-426614174000',
        roleName: 'admin'
    })

    assert.deepEqual(assignment, {
        userId: '123e4567-e89b-12d3-a456-426614174000',
        roleName: 'admin'
    })
})

test('hasCompanyPermission checks whether a role is allowed to perform an action', () => {
    const permissionSet = new Set(['admin:contacts:read', 'admin:contacts:update', 'super_admin:users:delete'])

    assert.equal(hasCompanyPermission(permissionSet, 'admin', 'contacts', 'read'), true)
    assert.equal(hasCompanyPermission(permissionSet, 'admin', 'contacts', 'delete'), false)
    assert.equal(hasCompanyPermission(permissionSet, 'super_admin', 'users', 'delete'), true)
})

