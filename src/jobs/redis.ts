import { Redis } from 'ioredis'

import { getRedisUrl } from '../database/redis.js'

/**
 * Creates a dedicated ioredis instance configured specifically for BullMQ.
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`.
 * Each Queue and Worker instance should use its own dedicated connection.
 */
export const createBullMqRedisConnection = (): Redis => {
    const url = getRedisUrl()
    if (!url) {
        throw new Error('REDIS_URL is required to initialize BullMQ queues and workers')
    }

    return new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
        connectTimeout: 10_000,
        retryStrategy: (times: number) => Math.min(times * 200, 3_000),
        tls: url.startsWith('rediss://') ? {} : undefined
    })
}
