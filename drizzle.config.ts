import { defineConfig } from 'drizzle-kit'

import { loadDatabaseConfig } from './src/config/environment.js'

const config = loadDatabaseConfig()

export default defineConfig({
    dialect: 'postgresql',
    schema: './src/database/schema.ts',
    out: './src/database/migrations',
    dbCredentials: {
        url: config.url
    },
    strict: true,
    verbose: true
})