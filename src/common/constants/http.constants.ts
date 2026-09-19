export const HTTP_METHODS = {
    GET: 'GET',
    HEAD: 'HEAD',
    POST: 'POST',
    PATCH: 'PATCH',
    DELETE: 'DELETE',
    OPTIONS: 'OPTIONS'
} as const

export const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,
    INTERNAL_SERVER_ERROR: 500,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413
} as const

export const HTTP_HEADERS = {
    ALLOW: 'allow',
    CONTENT_LENGTH: 'content-length',
    CONTENT_TYPE: 'content-type',
    REQUEST_ID: 'x-request-id',
    ACCESS_CONTROL_ALLOW_ORIGIN: 'access-control-allow-origin',
    ACCESS_CONTROL_ALLOW_METHODS: 'access-control-allow-methods',
    ACCESS_CONTROL_ALLOW_HEADERS: 'access-control-allow-headers',
    ACCESS_CONTROL_ALLOW_CREDENTIALS: 'access-control-allow-credentials',
    ACCESS_CONTROL_EXPOSE_HEADERS: 'access-control-expose-headers',
    ACCESS_CONTROL_MAX_AGE: 'access-control-max-age'
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

export const USER_ROUTES = {
    COLLECTION: '/users'
} as const

export const ROLE_ROUTES = {
    COLLECTION: '/roles'
} as const

export const QUOTATION_ROUTES = {
    COLLECTION: '/quotations'
} as const

export const DEFAULT_URL_BASE = 'http://localhost'
export const MAX_REQUEST_ID_LENGTH = 128
