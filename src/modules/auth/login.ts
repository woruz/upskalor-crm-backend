import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import jwt from 'jsonwebtoken'
import { and, eq } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { companies, users } from '../../database/schema.js'

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

export const loginUser = async (request: LoginRequest, jwtSecret: string): Promise<LoginResponse> => {
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

    const token = jwt.sign(
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
            expiresIn: '1h',
            issuer: 'upskalor-crm'
        }
    )

    return {
        token,
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

