import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'

import { eq } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { companies } from '../../database/schema.js'
import { registerCompany } from '../../database/tenants.js'

const scrypt = promisify(scryptCallback)
const PASSWORD_HASH_LENGTH = 32
const PASSWORD_MIN_LENGTH = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface RegisterCompanyRequest {
    companyName: string
    companySlug?: string | undefined
    firstName: string
    lastName: string
    email: string
    password: string
}

export interface RegisteredCompanyResponse {
    company: {
        id: string
        name: string
        slug: string
        schemaName: string
    }
    owner: {
        id: string
        email: string
        firstName: string
        lastName: string
        role: string
    }
}

export class RegistrationInputError extends Error {}

const getString = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string') {
        throw new RegistrationInputError(`${field} must be a string`)
    }

    const normalizedValue = value.trim()

    if (normalizedValue === '' || normalizedValue.length > maxLength) {
        throw new RegistrationInputError(`${field} is invalid`)
    }

    return normalizedValue
}

export const parseRegistrationRequest = (body: unknown): RegisterCompanyRequest => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new RegistrationInputError('Request body must be a JSON object')
    }

    const payload = body as Record<string, unknown>
    const email = getString(payload['email'], 'email', 320).toLowerCase()
    const password = payload['password']

    if (!EMAIL_PATTERN.test(email)) {
        throw new RegistrationInputError('email is invalid')
    }

    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
        throw new RegistrationInputError(`password must be between ${PASSWORD_MIN_LENGTH} and 200 characters`)
    }

    let companySlug: string | undefined
    if (
        payload['companySlug'] !== undefined &&
        payload['companySlug'] !== null &&
        typeof payload['companySlug'] === 'string' &&
        payload['companySlug'].trim() !== ''
    ) {
        const slug = getString(payload['companySlug'], 'companySlug', 100).toLowerCase()
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new RegistrationInputError('companySlug is invalid')
        }
        companySlug = slug
    }

    return {
        companyName: getString(payload['companyName'], 'companyName', 150),
        companySlug,
        firstName: getString(payload['firstName'], 'firstName', 100),
        lastName: getString(payload['lastName'], 'lastName', 100),
        email,
        password
    }
}

export const hashPassword = async (password: string): Promise<string> => {
    const salt = randomBytes(16).toString('hex')
    const derivedKey = await scrypt(password, salt, PASSWORD_HASH_LENGTH)

    if (!Buffer.isBuffer(derivedKey)) {
        throw new Error('Password hashing failed')
    }

    return `scrypt:${salt}:${derivedKey.toString('hex')}`
}

const generateUniqueCompanySlug = async (companyName: string): Promise<string> => {
    let baseSlug = companyName
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')

    if (!baseSlug) {
        baseSlug = 'company'
    }

    const candidate = baseSlug.slice(0, 100)
    const [existing] = await database
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.slug, candidate))
        .limit(1)

    if (existing === undefined) {
        return candidate
    }

    const suffix = randomBytes(3).toString('hex')
    return `${baseSlug.slice(0, 93)}-${suffix}`
}

export const registerCompanyWithOwner = async (request: RegisterCompanyRequest): Promise<RegisteredCompanyResponse> => {
    const passwordHash = await hashPassword(request.password)
    const slug = request.companySlug ?? (await generateUniqueCompanySlug(request.companyName))

    const registration = await registerCompany({
        name: request.companyName,
        slug,
        owner: {
            email: request.email,
            firstName: request.firstName,
            lastName: request.lastName,
            passwordHash
        }
    })

    return {
        company: {
            id: registration.company.id,
            name: registration.company.name,
            slug: registration.company.slug,
            schemaName: registration.company.schemaName
        },
        owner: {
            id: registration.owner.id,
            email: registration.owner.email,
            firstName: registration.owner.firstName,
            lastName: registration.owner.lastName,
            role: registration.owner.role
        }
    }
}
