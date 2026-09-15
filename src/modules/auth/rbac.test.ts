import assert from 'node:assert/strict'
import test from 'node:test'

import jwt from 'jsonwebtoken'

import { hasRole, requireRole, ROLE_NAMES } from './rbac.js'

test('hasRole returns true when the user matches the required role', () => {
    const payload = {
        id: 'user-1',
        role: ROLE_NAMES.SUPER_ADMIN,
        companyId: 'company-1',
        companySlug: 'acme',
        email: 'owner@acme.com'
    }

    assert.equal(hasRole(payload, ROLE_NAMES.SUPER_ADMIN), true)
    assert.equal(hasRole(payload, [ROLE_NAMES.ADMIN, ROLE_NAMES.SUPER_ADMIN]), true)
})

test('requireRole rejects a token with a disallowed role', () => {
    const token = jwt.sign(
        {
            id: 'user-2',
            role: ROLE_NAMES.USER,
            companyId: 'company-1',
            companySlug: 'acme',
            email: 'user@acme.com'
        },
        'test-secret',
        { expiresIn: '1h' }
    )

    assert.throws(() => requireRole(token, 'test-secret', [ROLE_NAMES.SUPER_ADMIN, ROLE_NAMES.ADMIN]), /not authorized/i)
})

