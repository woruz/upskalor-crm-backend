import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_DEFINITIONS, RESOURCE_DEFINITIONS } from './permissions.js'

test('permission catalog contains the CRUD actions', () => {
    assert.deepEqual(
        ACTION_DEFINITIONS.map((action) => action.name),
        ['create', 'read', 'update', 'delete']
    )
})

test('permission catalog contains shared resources', () => {
    const resourceNames = RESOURCE_DEFINITIONS.map((resource) => resource.name)

    assert.ok(resourceNames.includes('users'))
    assert.ok(resourceNames.includes('contacts'))
})

