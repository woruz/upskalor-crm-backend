import assert from 'node:assert/strict'
import test from 'node:test'

import { ROLE_NAMES } from '../modules/auth/rbac.js'
import { authorizeRequest, getAuthTokenFromRequest } from './auth.js'

const createRequest = (headers: Record<string, string>) =>
    ({
        headers
    }) as any

test('getAuthTokenFromRequest extracts bearer token from Authorization header', () => {
    const request = createRequest({ authorization: 'Bearer test-token-value' })

    assert.equal(getAuthTokenFromRequest(request), 'test-token-value')
})

test('authorizeRequest rejects missing auth header', async () => {
    const request = createRequest({})

    await assert.rejects(() => authorizeRequest(request, 'test-secret', ROLE_NAMES.SUPER_ADMIN), /authorization header/i)
})

