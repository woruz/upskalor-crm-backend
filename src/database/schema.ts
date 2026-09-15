import { relations, sql } from 'drizzle-orm'
import { boolean, index, pgSchema, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'

export const ROOT_SCHEMA_NAME = 'root'
export const rootSchema = pgSchema(ROOT_SCHEMA_NAME)

export const companies = rootSchema.table('companies', {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    schemaName: varchar('schema_name', { length: 63 }).notNull().unique(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const roles = rootSchema.table('roles', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 30 }).notNull().unique(),
    description: varchar('description', { length: 255 }).notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const actions = rootSchema.table('actions', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 30 }).notNull().unique(),
    description: varchar('description', { length: 255 }).notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const resources = rootSchema.table('resources', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 60 }).notNull().unique(),
    description: varchar('description', { length: 255 }).notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const users = rootSchema.table(
    'users',
    {
        id: uuid('id').primaryKey(),
        companyId: uuid('company_id')
            .notNull()
            .references(() => companies.id),
        email: varchar('email', { length: 320 }).notNull(),
        firstName: varchar('first_name', { length: 100 }).notNull(),
        lastName: varchar('last_name', { length: 100 }).notNull(),
        passwordHash: varchar('password_hash', { length: 255 }).notNull(),
        role: varchar('role', { length: 30 }).notNull().default('user'),
        isActive: boolean('is_active').notNull().default(true),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => ({
        companyEmailUnique: uniqueIndex('users_company_email_unique').on(table.companyId, table.email),
        companyIndex: index('users_company_id_idx').on(table.companyId),
        emailLowerIndex: index('users_email_lower_idx').on(sql`lower(${table.email})`)
    })
)

export const refreshTokens = rootSchema.table(
    'refresh_tokens',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
        familyId: uuid('family_id').notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        replacedByTokenId: uuid('replaced_by_token_id'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true })
    },
    (table) => ({
        userIndex: index('refresh_tokens_user_id_idx').on(table.userId),
        familyIndex: index('refresh_tokens_family_id_idx').on(table.familyId),
        expiryIndex: index('refresh_tokens_expires_at_idx').on(table.expiresAt)
    })
)

export const roleRelations = relations(roles, ({ many }) => ({
    users: many(users)
}))

export const companyRelations = relations(companies, ({ many }) => ({
    users: many(users)
}))

export const userRelations = relations(users, ({ one }) => ({
    company: one(companies, {
        fields: [users.companyId],
        references: [companies.id]
    }),
    role: one(roles, {
        fields: [users.role],
        references: [roles.name]
    })
}))
