import { randomUUID } from 'node:crypto'

import { and, desc, eq, ilike, or, sql, count } from 'drizzle-orm'

import { database } from '../../database/client.js'
import { roles, users } from '../../database/schema.js'
import { hashPassword } from '../auth/registration.js'

export interface UserRecord {
    id: string
    firstName: string
    lastName: string
    email: string
    role: string
    status: 'ACTIVE' | 'INACTIVE'
    createdAt: string
    updatedAt: string
}

export interface UserListFilters {
    page?: number | undefined
    limit?: number | undefined
    search?: string | undefined
    role?: string | undefined
    status?: string | undefined
}

export interface CreateUserInput {
    firstName: string
    lastName: string
    email: string
    password?: string
    role: string
    status?: 'ACTIVE' | 'INACTIVE'
}

export interface UpdateUserInput {
    firstName?: string
    lastName?: string
    password?: string
    role?: string
    status?: 'ACTIVE' | 'INACTIVE'
}

export class UserInputError extends Error {
    constructor(
        message: string,
        public code = 'INVALID_INPUT'
    ) {
        super(message)
    }
}

export class UserNotFoundError extends Error {
    constructor(message = 'User not found') {
        super(message)
    }
}

export class UserConflictError extends Error {
    constructor(message: string) {
        super(message)
    }
}

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

const parseUuid = (value: string, field = 'id'): string => {
    const trimmed = value.trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        throw new UserInputError(`${field} must be a valid UUID`)
    }
    return trimmed
}

export const listUsers = async (
    companyId: string,
    filters: UserListFilters = {}
): Promise<{
    data: UserRecord[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}> => {
    parseUuid(companyId, 'companyId')

    const page = Math.max(1, Number(filters.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
    const offset = (page - 1) * limit

    const conditions = [eq(users.companyId, companyId)]

    if (filters.search && filters.search.trim() !== '') {
        const pattern = `%${filters.search.trim()}%`
        conditions.push(
            or(
                ilike(users.firstName, pattern),
                ilike(users.lastName, pattern),
                ilike(users.email, pattern)
            )!
        )
    }

    if (filters.role && filters.role.trim() !== '' && filters.role !== 'all') {
        conditions.push(eq(users.role, filters.role.trim().toLowerCase()))
    }

    if (filters.status && filters.status.trim() !== '' && filters.status !== 'all') {
        const upper = filters.status.trim().toUpperCase() as 'ACTIVE' | 'INACTIVE'
        conditions.push(eq(users.status, upper))
    }

    const whereClause = and(...conditions)!

    // Query total count
    const [totalRow] = await database.select({ count: count() }).from(users).where(whereClause)
    const total = Number(totalRow?.count ?? 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    // Query paginated users
    const rows = await database
        .select()
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset)

    const data: UserRecord[] = rows.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        status: (u.status as 'ACTIVE' | 'INACTIVE') || (u.isActive ? 'ACTIVE' : 'INACTIVE'),
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString()
    }))

    return {
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages
        }
    }
}

export const getUserById = async (companyId: string, userId: string): Promise<UserRecord> => {
    parseUuid(companyId, 'companyId')
    parseUuid(userId, 'userId')

    const [user] = await database
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.companyId, companyId)))

    if (!user) {
        throw new UserNotFoundError()
    }

    return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: (user.status as 'ACTIVE' | 'INACTIVE') || (user.isActive ? 'ACTIVE' : 'INACTIVE'),
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString()
    }
}

export const createUser = async (companyId: string, input: CreateUserInput): Promise<UserRecord> => {
    parseUuid(companyId, 'companyId')

    const firstName = input.firstName?.trim()
    if (!firstName || firstName.length < 1 || firstName.length > 100) {
        throw new UserInputError('First name must be between 1 and 100 characters')
    }

    const lastName = input.lastName?.trim()
    if (!lastName || lastName.length < 1 || lastName.length > 100) {
        throw new UserInputError('Last name must be between 1 and 100 characters')
    }

    const email = input.email?.trim().toLowerCase()
    if (!email || !EMAIL_PATTERN.test(email)) {
        throw new UserInputError('A valid email address is required')
    }

    const role = input.role?.trim().toLowerCase()
    if (!role) {
        throw new UserInputError('Role is required')
    }

    // Check email conflict within company
    const [existing] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.companyId, companyId), eq(users.email, email)))

    if (existing) {
        throw new UserConflictError('A user with this email already exists in this company')
    }

    // Validate role exists
    const [roleRow] = await database
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, role), or(eq(roles.companyId, companyId), eq(roles.isSystem, true), sql`company_id is null`)))

    if (!roleRow) {
        throw new UserInputError(`Role "${role}" does not exist`)
    }

    const rawPassword = input.password?.trim() || 'Password123456'
    if (rawPassword.length < 8) {
        throw new UserInputError('Password must be at least 8 characters long')
    }

    const passwordHash = await hashPassword(rawPassword)
    const status = input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    const isActive = status === 'ACTIVE'

    const newUserId = randomUUID()
    const [created] = await database
        .insert(users)
        .values({
            id: newUserId,
            companyId,
            email,
            firstName,
            lastName,
            passwordHash,
            role,
            status,
            isActive
        })
        .returning()

    if (!created) {
        throw new Error('Failed to create user')
    }

    return {
        id: created.id,
        firstName: created.firstName,
        lastName: created.lastName,
        email: created.email,
        role: created.role,
        status: (created.status as 'ACTIVE' | 'INACTIVE') || (created.isActive ? 'ACTIVE' : 'INACTIVE'),
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString()
    }
}

export const updateUser = async (
    companyId: string,
    userId: string,
    input: UpdateUserInput
): Promise<UserRecord> => {
    parseUuid(companyId, 'companyId')
    parseUuid(userId, 'userId')

    const [existing] = await database
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.companyId, companyId)))

    if (!existing) {
        throw new UserNotFoundError()
    }

    const updates: Record<string, unknown> = {
        ['updatedAt']: new Date()
    }

    if (input.firstName !== undefined) {
        const trimmed = input.firstName.trim()
        if (trimmed.length < 1 || trimmed.length > 100) {
            throw new UserInputError('First name must be between 1 and 100 characters')
        }
        updates['firstName'] = trimmed
    }

    if (input.lastName !== undefined) {
        const trimmed = input.lastName.trim()
        if (trimmed.length < 1 || trimmed.length > 100) {
            throw new UserInputError('Last name must be between 1 and 100 characters')
        }
        updates['lastName'] = trimmed
    }

    if (input.role !== undefined) {
        const role = input.role.trim().toLowerCase()
        const [roleRow] = await database
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.name, role), or(eq(roles.companyId, companyId), eq(roles.isSystem, true), sql`company_id is null`)))

        if (!roleRow) {
            throw new UserInputError(`Role "${role}" does not exist`)
        }
        updates['role'] = role
    }

    if (input.status !== undefined) {
        const status = input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
        updates['status'] = status
        updates['isActive'] = status === 'ACTIVE'
    }

    if (input.password !== undefined && input.password.trim() !== '') {
        const raw = input.password.trim()
        if (raw.length < 8) {
            throw new UserInputError('Password must be at least 8 characters long')
        }
        updates['passwordHash'] = await hashPassword(raw)
    }

    const [updated] = await database
        .update(users)
        .set(updates)
        .where(and(eq(users.id, userId), eq(users.companyId, companyId)))
        .returning()

    if (!updated) {
        throw new UserNotFoundError()
    }

    return {
        id: updated.id,
        firstName: updated.firstName,
        lastName: updated.lastName,
        email: updated.email,
        role: updated.role,
        status: (updated.status as 'ACTIVE' | 'INACTIVE') || (updated.isActive ? 'ACTIVE' : 'INACTIVE'),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString()
    }
}

export const deleteUser = async (
    companyId: string,
    userId: string,
    currentUserId: string
): Promise<void> => {
    parseUuid(companyId, 'companyId')
    parseUuid(userId, 'userId')

    if (userId === currentUserId) {
        throw new UserInputError('You cannot delete your own user account', 'CANNOT_DELETE_SELF')
    }

    const [existing] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.companyId, companyId)))

    if (!existing) {
        throw new UserNotFoundError()
    }

    await database
        .delete(users)
        .where(and(eq(users.id, userId), eq(users.companyId, companyId)))
}
