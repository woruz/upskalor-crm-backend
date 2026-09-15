import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLoginRequest } from './login.js'

test('parseLoginRequest accepts valid company login payload', () => {
    const parsed = parseLoginRequest({
        companySlug: 'acme',
        email: 'owner@acme.com',
        password: 'securePassword123'
    })

    assert.deepEqual(parsed, {
        companySlug: 'acme',
        email: 'owner@acme.com',
        password: 'securePassword123'
    })
})

test('parseLoginRequest rejects invalid email', () => {
    assert.throws(
        () =>
            parseLoginRequest({
                companySlug: 'acme',
                email: 'not-an-email',
                password: 'securePassword123'
            }),
        /email is invalid/
    )
})

