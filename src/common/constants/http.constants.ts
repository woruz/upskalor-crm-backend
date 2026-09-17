export const HTTP_METHODS = {
    GET: 'GET',
    HEAD: 'HEAD',
    POST: 'POST',
    PATCH: 'PATCH',
    DELETE: 'DELETE'
} as const

export const HTTP_STATUS = {
    OK: 200,
    ACCEPTED: 202,
    CREATED: 201,
    INTERNAL_SERVER_ERROR: 500,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    PAYLOAD_TOO_LARGE: 413
} as const

export const HTTP_HEADERS = {
    ALLOW: 'allow',
    CONTENT_LENGTH: 'content-length',
    CONTENT_TYPE: 'content-type',
    REQUEST_ID: 'x-request-id'
} as const

export const HEALTH_ROUTES = {
    LIVE: '/health/live',
    READY: '/health/ready'
} as const

export const AUTH_ROUTES = {
    REGISTER: '/auth/register',
    LOGIN: '/auth/login',
    REFRESH: '/auth/refresh',
    LOGOUT: '/auth/logout'
} as const

export const ADMIN_ROUTES = {
    USERS: '/admin/users',
    PERMISSIONS: '/admin/permissions',
    ROLE_ASSIGNMENTS: '/admin/role-assignments'
} as const

export const LEAD_ROUTES = {
    COLLECTION: '/leads'
} as const

export const QUOTATION_ROUTES = {
    COLLECTION: '/quotations'
} as const

export const DEFAULT_URL_BASE = 'http://localhost'
export const MAX_REQUEST_ID_LENGTH = 128
