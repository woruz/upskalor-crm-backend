/**
 * Redis cache TTL values in seconds.
 * Tune these based on how frequently the underlying data changes.
 */
export const CACHE_TTL = {
    /** Permission sets change rarely — only when an admin edits RBAC */
    PERMISSION_SET: 5 * 60,       // 5 minutes
    /** Schema names are set once and never change after company registration */
    COMPANY_SCHEMA: 60 * 60,      // 1 hour
    /** Tenant init flag — tables exist permanently once created */
    TENANT_INITIALIZED: 24 * 60 * 60 // 24 hours
} as const

/**
 * Redis cache key factories.
 * All keys follow a consistent namespaced format: `ns:segment:...`
 */
export const CACHE_KEYS = {
    /** Cached Set of `role:resource:action` strings for a company + role */
    permissionSet: (companyId: string, role: string): string =>
        `perm:${companyId}:${role}`,

    /** Cached PostgreSQL schema name for a company */
    companySchema: (companyId: string): string =>
        `schema:${companyId}`,

    /** Flag indicating tenant tables have been created */
    tenantInitialized: (companyId: string): string =>
        `tenant_init:${companyId}`,
} as const
