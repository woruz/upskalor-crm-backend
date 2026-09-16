import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'

import { registerCompany } from '../../database/tenants.js'

const scrypt = promisify(scryptCallback)
const PASSWORD_HASH_LENGTH = 32
const PASSWORD_MIN_LENGTH = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface RegisterCompanyRequest {
    companyName: string
    companySlug: string
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
    const companySlug = getString(payload['companySlug'], 'companySlug', 100).toLowerCase()
    const email = getString(payload['email'], 'email', 320).toLowerCase()
    const password = payload['password']

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(companySlug)) {
        throw new RegistrationInputError('companySlug is invalid')
    }

    if (!EMAIL_PATTERN.test(email)) {
        throw new RegistrationInputError('email is invalid')
    }

    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
        throw new RegistrationInputError(`password must be between ${PASSWORD_MIN_LENGTH} and 200 characters`)
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

const hashPassword = async (password: string): Promise<string> => {
    const salt = randomBytes(16).toString('hex')
    const derivedKey = await scrypt(password, salt, PASSWORD_HASH_LENGTH)

    if (!Buffer.isBuffer(derivedKey)) {
        throw new Error('Password hashing failed')
    }

    return `scrypt:${salt}:${derivedKey.toString('hex')}`
}

export const registerCompanyWithOwner = async (request: RegisterCompanyRequest): Promise<RegisteredCompanyResponse> => {
    const passwordHash = await hashPassword(request.password)
    const registration = await registerCompany({
        name: request.companyName,
        slug: request.companySlug,
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
