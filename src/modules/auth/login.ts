import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import jwt from 'jsonwebtoken'
import { and, eq, isNull } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { companies, refreshTokens, users } from '../../database/schema.js'

const scrypt = promisify(scryptCallback)
const PASSWORD_HASH_LENGTH = 32
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface LoginRequest {
    companySlug: string
    email: string
    password: string
}

export interface LoginResponse {
    token: string
    refreshToken: string
    expiresIn: number
    refreshTokenExpiresIn: number
    user: {
        id: string
        email: string
        firstName: string
        lastName: string
        role: string
    }
    company: {
        id: string
        name: string
        slug: string
    }
}

export class LoginInputError extends Error {}
export class InvalidCredentialsError extends Error {}
export class InvalidRefreshTokenError extends Error {}

export interface RefreshTokenRequest {
    refreshToken: string
}

const REFRESH_TOKEN_BYTES = 48

const getString = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string') {
        throw new LoginInputError(`${field} must be a string`)
    }

    const normalizedValue = value.trim()

    if (normalizedValue === '' || normalizedValue.length > maxLength) {
        throw new LoginInputError(`${field} is invalid`)
    }

    return normalizedValue
}

export const parseLoginRequest = (body: unknown): LoginRequest => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new LoginInputError('Request body must be a JSON object')
    }

    const payload = body as Record<string, unknown>
    const companySlug = getString(payload['companySlug'], 'companySlug', 100).toLowerCase()
    const email = getString(payload['email'], 'email', 320).toLowerCase()
    const password = getString(payload['password'], 'password', 200)

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(companySlug)) {
        throw new LoginInputError('companySlug is invalid')
    }

    if (!EMAIL_PATTERN.test(email)) {
        throw new LoginInputError('email is invalid')
    }

    if (password.length < 8) {
        throw new LoginInputError('password must be at least 8 characters')
    }

    return {
        companySlug,
        email,
        password
    }
}

const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
    if (!storedHash.startsWith('scrypt:')) {
        return false
    }

    const [prefix, salt, hash] = storedHash.split(':')

    if (prefix !== 'scrypt' || salt === undefined || hash === undefined) {
        return false
    }

    const derivedKey = await scrypt(password, salt, PASSWORD_HASH_LENGTH)

    if (!Buffer.isBuffer(derivedKey)) {
        return false
    }

    const expectedHash = Buffer.from(hash, 'hex')
    const actualHash = Buffer.from(derivedKey)

    if (actualHash.length !== expectedHash.length) {
        return false
    }

    return timingSafeEqual(actualHash, expectedHash)
}

const hashRefreshToken = (token: string): string => createHash('sha256').update(token).digest('hex')

const createAccessToken = (
    user: typeof users.$inferSelect,
    company: typeof companies.$inferSelect,
    jwtSecret: string,
    accessTokenExpiresIn: number
): string =>
    jwt.sign(
        {
            id: user.id,
            sub: user.id,
            email: user.email,
            companyId: company.id,
            companySlug: company.slug,
            role: user.role
        },
        jwtSecret,
        {
            expiresIn: accessTokenExpiresIn,
            issuer: 'upskalor-crm'
        }
    )

const createRefreshSession = async (userId: string, refreshTokenExpiresIn: number, familyId = randomUUID()): Promise<string> => {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
    await database.insert(refreshTokens).values({
        userId,
        tokenHash: hashRefreshToken(token),
        familyId,
        expiresAt: new Date(Date.now() + refreshTokenExpiresIn * 1000)
    })
    return token
}

export const parseRefreshTokenRequest = (body: unknown): RefreshTokenRequest => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new LoginInputError('Request body must be a JSON object')
    }

    const refreshToken = (body as Record<string, unknown>)['refreshToken']
    if (typeof refreshToken !== 'string' || refreshToken.trim() === '' || refreshToken.length > 200) {
        throw new LoginInputError('refreshToken is invalid')
    }

    return { refreshToken: refreshToken.trim() }
}

export const loginUser = async (
    request: LoginRequest,
    jwtSecret: string,
    accessTokenExpiresIn: number,
    refreshTokenExpiresIn: number
): Promise<LoginResponse> => {
    if (jwtSecret.trim() === '') {
        throw new Error('JWT secret is missing')
    }

    const [company] = await database.select().from(companies).where(eq(companies.slug, request.companySlug))

    if (company === undefined) {
        throw new InvalidCredentialsError('Invalid credentials')
    }

    const [user] = await database
        .select()
        .from(users)
        .where(and(eq(users.companyId, company.id), eq(users.email, request.email)))

    if (user === undefined) {
        throw new InvalidCredentialsError('Invalid credentials')
    }

    const isValidPassword = await verifyPassword(request.password, user.passwordHash)

    if (!isValidPassword) {
        throw new InvalidCredentialsError('Invalid credentials')
    }

    const token = createAccessToken(user, company, jwtSecret, accessTokenExpiresIn)
    const refreshToken = await createRefreshSession(user.id, refreshTokenExpiresIn)

    return {
        token,
        refreshToken,
        expiresIn: accessTokenExpiresIn,
        refreshTokenExpiresIn,
        user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role
        },
        company: {
            id: company.id,
            name: company.name,
            slug: company.slug
        }
    }
}

export const refreshUserSession = async (
    rawRefreshToken: string,
    jwtSecret: string,
    accessTokenExpiresIn: number,
    refreshTokenExpiresIn: number
): Promise<LoginResponse> => {
    if (jwtSecret.trim() === '') {
        throw new Error('JWT secret is missing')
    }

    const tokenHash = hashRefreshToken(rawRefreshToken)
    return database.transaction(async (transaction) => {
        const [session] = await transaction.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash))

        if (session === undefined || session.expiresAt <= new Date()) {
            throw new InvalidRefreshTokenError('Refresh token is invalid or expired')
        }

        if (session.revokedAt !== null) {
            await transaction.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, session.familyId))
            throw new InvalidRefreshTokenError('Refresh token has already been used')
        }

        const [user] = await transaction
            .select()
            .from(users)
            .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
        if (user === undefined) {
            throw new InvalidRefreshTokenError('Refresh token is invalid')
        }

        const [company] = await transaction
            .select()
            .from(companies)
            .where(and(eq(companies.id, user.companyId), eq(companies.isActive, true)))
        if (company === undefined) {
            throw new InvalidRefreshTokenError('Refresh token is invalid')
        }

        const nextToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
        const [nextSession] = await transaction
            .insert(refreshTokens)
            .values({
                userId: user.id,
                tokenHash: hashRefreshToken(nextToken),
                familyId: session.familyId,
                expiresAt: new Date(Date.now() + refreshTokenExpiresIn * 1000)
            })
            .returning({ id: refreshTokens.id })

        if (nextSession === undefined) {
            throw new Error('Refresh session creation failed')
        }

        await transaction
            .update(refreshTokens)
            .set({ revokedAt: new Date(), replacedByTokenId: nextSession.id, lastUsedAt: new Date() })
            .where(eq(refreshTokens.id, session.id))

        return {
            token: createAccessToken(user, company, jwtSecret, accessTokenExpiresIn),
            refreshToken: nextToken,
            expiresIn: accessTokenExpiresIn,
            refreshTokenExpiresIn,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role
            },
            company: {
                id: company.id,
                name: company.name,
                slug: company.slug
            }
        }
    })
}

export const revokeRefreshToken = async (rawRefreshToken: string): Promise<void> => {
    await database
        .update(refreshTokens)
        .set({ revokedAt: new Date(), lastUsedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, hashRefreshToken(rawRefreshToken)), isNull(refreshTokens.revokedAt)))
}

