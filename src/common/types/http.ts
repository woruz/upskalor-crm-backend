export interface ErrorResponse {
    error: {
        code: string
        message: string
        details?: unknown
        requestId: string
    }
}

