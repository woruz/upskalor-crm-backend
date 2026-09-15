export type Environment = 'development' | 'test' | 'production'

export interface DatabaseConfig {
    url: string
}

export interface StorageConfig {
    region: string
    bucket: string
    presignExpiresIn: number
    maxLeadImportFileSize: number
    maxLeadExportRows: number
}

export interface AppConfig {
    environment: Environment
    host: string
    port: number
    requestBodyLimit: number
    jwtSecret: string
    database: DatabaseConfig
    storage: StorageConfig
}

