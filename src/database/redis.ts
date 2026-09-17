import { Redis } from 'ioredis'

import { ENVIRONMENT_VARIABLES } from '../common/constants/environment.constants.js'
import { CACHE_KEYS, CACHE_TTL } from '../common/constants/cache.constants.js'

// ─── Singleton client ────────────────────────────────────────────────────────

let _client: Redis | null = null

export const getRedisUrl = (): string | undefined => {
    const raw = process.env[ENVIRONMENT_VARIABLES.REDIS_URL]?.trim()
    if (!raw) return undefined
    // Strip the redis-cli prefix in case the env was copy-pasted from Upstash docs
    // e.g. "redis-cli --tls -u rediss://..."  →  "rediss://..."
    const cliPrefixMatch = /^redis-cli\s+.*?\s+-u\s+(rediss?:\/\/.+)$/i.exec(raw)
    return cliPrefixMatch?.[1] ?? raw
}

export const getRedisClient = (): Redis | null => {
    if (_client !== null) return _client

    const url = getRedisUrl()
    if (!url) return null

    const client = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableAutoPipelining: true,
        lazyConnect: false,
        connectTimeout: 5_000,
        commandTimeout: 3_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        tls: url.startsWith('rediss://') ? {} : undefined
    })

    client.on('error', (err: Error) => {
        process.stderr.write(
            `${JSON.stringify({ level: 'error', message: 'Redis error', error: err.message, timestamp: new Date().toISOString() })}\n`
        )
    })

    client.on('connect', () => {
        process.stdout.write(
            `${JSON.stringify({ level: 'info', message: 'Redis connected', timestamp: new Date().toISOString() })}\n`
        )
    })

    _client = client
    return _client
}

export const closeRedis = async (): Promise<void> => {
    if (_client !== null) {
        await _client.quit()
        _client = null
    }
}

// ─── Typed cache helpers ─────────────────────────────────────────────────────

export const getCache = async <T>(key: string): Promise<T | null> => {
    const client = getRedisClient()
    if (client === null) return null
    try {
        const raw = await client.get(key)
        if (raw === null) return null
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

export const setCache = async (key: string, value: unknown, ttlSeconds: number): Promise<void> => {
    const client = getRedisClient()
    if (client === null) return
    try {
        await client.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    } catch {
        // Cache failure is non-fatal — let the request proceed
    }
}

export const deleteCache = async (key: string): Promise<void> => {
    const client = getRedisClient()
    if (client === null) return
    try {
        await client.del(key)
    } catch {
        // Non-fatal
    }
}

export const deleteCacheByPattern = async (pattern: string): Promise<void> => {
    const client = getRedisClient()
    if (client === null) return
    try {
        const keys = await client.keys(pattern)
        if (keys.length > 0) {
            await client.del(...keys)
        }
    } catch {
        // Non-fatal
    }
}

// ─── Key factories and TTL re-exports for convenience ───────────────────────
export { CACHE_KEYS, CACHE_TTL }
