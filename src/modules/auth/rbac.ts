import jwt, { type JwtPayload } from 'jsonwebtoken'

export const ROLE_NAMES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    USER: 'user'
} as const

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES]

export interface AuthTokenPayload extends JwtPayload {
    id: string
    role: RoleName
    companyId: string
    companySlug: string
    email: string
}

export const hasRole = (payload: Partial<AuthTokenPayload>, required: RoleName | RoleName[]): boolean => {
    const allowedRoles = Array.isArray(required) ? required : [required]
    const userRole = payload.role

    return userRole !== undefined && allowedRoles.includes(userRole)
}

export const verifyToken = (token: string, secret: string): AuthTokenPayload => {
    const decoded = jwt.verify(token, secret) as JwtPayload & Partial<AuthTokenPayload>

    if (typeof decoded.id !== 'string' || decoded.id.trim() === '') {
        throw new Error('Token missing user id')
    }

    if (typeof decoded.role !== 'string' || !Object.values(ROLE_NAMES).includes(decoded.role as RoleName)) {
        throw new Error('Token missing valid role')
    }

    if (typeof decoded.companyId !== 'string' || decoded.companyId.trim() === '') {
        throw new Error('Token missing company id')
    }

    if (typeof decoded.companySlug !== 'string' || decoded.companySlug.trim() === '') {
        throw new Error('Token missing company slug')
    }

    if (typeof decoded.email !== 'string' || decoded.email.trim() === '') {
        throw new Error('Token missing email')
    }

    return {
        id: decoded.id,
        role: decoded.role as RoleName,
        companyId: decoded.companyId,
        companySlug: decoded.companySlug,
        email: decoded.email,
        iat: decoded.iat,
        exp: decoded.exp,
        nbf: decoded.nbf,
        aud: decoded.aud,
        iss: decoded.iss,
        sub: decoded.sub
    }
}

export const requireRole = (token: string, secret: string, allowedRoles: RoleName | RoleName[]): AuthTokenPayload => {
    const payload = verifyToken(token, secret)

    if (!hasRole(payload, allowedRoles)) {
        throw new Error('User is not authorized for this action')
    }

    return payload
}

