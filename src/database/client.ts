import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { DATABASE_POOL } from '../common/constants/database.constants.js'
import { loadDatabaseConfig } from '../config/environment.js'

const config = loadDatabaseConfig()

export const pool = new Pool({
    connectionString: config.url,
    max: DATABASE_POOL.MAX_CONNECTIONS,
    idleTimeoutMillis: DATABASE_POOL.IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DATABASE_POOL.CONNECTION_TIMEOUT_MS
})

pool.on('error', (error) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', message: 'Unexpected PostgreSQL pool error', error: error.message, timestamp: new Date().toISOString() })}\n`)
})

export const database = drizzle(pool)

export const closeDatabase = async (): Promise<void> => {
    await pool.end()
}