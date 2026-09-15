import type { IncomingMessage } from 'node:http'

import { requireRole, type RoleName } from '../modules/auth/rbac.js'

const AUTH_HEADER = 'authorization'
const AUTH_SCHEME = 'Bearer '

export const getAuthTokenFromRequest = (request: IncomingMessage): string => {
    const header = request.headers[AUTH_HEADER]

    if (typeof header !== 'string') {
        throw new Error('Authorization header is missing')
    }

    const trimmed = header.trim()

    if (!trimmed.toLowerCase().startsWith(AUTH_SCHEME.toLowerCase())) {
        throw new Error('Authorization header must use Bearer scheme')
    }

    const token = trimmed.slice(AUTH_SCHEME.length).trim()

    if (token === '') {
        throw new Error('Authorization token is missing')
    }

    return token
}

export const authorizeRequest = async (
    request: IncomingMessage,
    jwtSecret: string,
    allowedRoles: RoleName | RoleName[]
): Promise<{ id: string; role: RoleName; companyId: string; companySlug: string; email: string }> => {
    const token = getAuthTokenFromRequest(request)
    const payload = requireRole(token, jwtSecret, allowedRoles)

    return {
        id: payload.id,
        role: payload.role,
        companyId: payload.companyId,
        companySlug: payload.companySlug,
        email: payload.email
    }
}

