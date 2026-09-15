import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

import { ALLOWED_ENVIRONMENTS, ENVIRONMENT_VARIABLES } from '../common/constants/environment.constants.js'
import type { AppConfig, DatabaseConfig, Environment, StorageConfig } from '../common/types/config.js'

if (existsSync('.env')) {
    loadEnvFile()
}

const requireEnvironmentValue = (environment: NodeJS.ProcessEnv, name: string): string => {
    const value = environment[name]

    if (value === undefined || value.trim() === '') {
        throw new Error(`${name} is required`)
    }

    return value.trim()
}

const parsePositiveInteger = (value: string, name: string): number => {
    const parsedValue = Number(value)

    if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        throw new Error(`${name} must be a positive safe integer`)
    }

    return parsedValue
}

const parseEnvironment = (value: string): Environment => {
    if ((ALLOWED_ENVIRONMENTS as readonly string[]).includes(value)) {
        return value as Environment
    }

    throw new Error(`${ENVIRONMENT_VARIABLES.NODE_ENV} must be one of: ${ALLOWED_ENVIRONMENTS.join(', ')}`)
}

export const loadDatabaseConfig = (environment: NodeJS.ProcessEnv = process.env): DatabaseConfig => ({
    url: requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.DATABASE_URL)
})

export const loadStorageConfig = (environment: NodeJS.ProcessEnv = process.env): StorageConfig => ({
    region: requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.AWS_REGION),
    bucket: requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.S3_BUCKET),
    presignExpiresIn: parsePositiveInteger(requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.S3_PRESIGN_EXPIRES_IN), ENVIRONMENT_VARIABLES.S3_PRESIGN_EXPIRES_IN),
    maxLeadImportFileSize: parsePositiveInteger(
        requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.MAX_LEAD_IMPORT_FILE_SIZE),
        ENVIRONMENT_VARIABLES.MAX_LEAD_IMPORT_FILE_SIZE
    ),
    maxLeadExportRows: parsePositiveInteger(requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.MAX_LEAD_EXPORT_ROWS), ENVIRONMENT_VARIABLES.MAX_LEAD_EXPORT_ROWS)
})

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
    const nodeEnvironment = requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.NODE_ENV)
    const host = requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.HOST)
    const port = requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.PORT)
    const requestBodyLimit = requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.REQUEST_BODY_LIMIT)
    const jwtSecret = requireEnvironmentValue(environment, ENVIRONMENT_VARIABLES.JWT_SECRET)
    const database = loadDatabaseConfig(environment)
    const storage = loadStorageConfig(environment)

    return {
        environment: parseEnvironment(nodeEnvironment),
        host,
        port: parsePositiveInteger(port, ENVIRONMENT_VARIABLES.PORT),
        requestBodyLimit: parsePositiveInteger(requestBodyLimit, ENVIRONMENT_VARIABLES.REQUEST_BODY_LIMIT),
        jwtSecret,
        database,
        storage
    }
}

