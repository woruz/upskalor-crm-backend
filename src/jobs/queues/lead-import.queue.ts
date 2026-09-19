import { Queue } from 'bullmq'

import { createBullMqRedisConnection } from '../redis.js'

export const LEAD_IMPORT_QUEUE_NAME = 'lead-import'

export interface LeadImportJobData {
    companyId: string
    userId: string
    importId: string
    s3Key: string
    fileName: string
    extension: 'csv' | 'xlsx'
}

let _leadImportQueue: Queue<LeadImportJobData> | null = null

export const getLeadImportQueue = (): Queue<LeadImportJobData> => {
    if (_leadImportQueue === null) {
        _leadImportQueue = new Queue<LeadImportJobData>(LEAD_IMPORT_QUEUE_NAME, {
            connection: createBullMqRedisConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2_000
                },
                removeOnComplete: {
                    count: 500,
                    age: 24 * 3_600
                },
                removeOnFail: {
                    count: 1_000,
                    age: 7 * 24 * 3_600
                }
            }
        })
    }
    return _leadImportQueue
}

export const enqueueLeadImportJob = async (data: LeadImportJobData): Promise<string> => {
    const queue = getLeadImportQueue()
    const job = await queue.add(`import-${data.importId}`, data, {
        jobId: `import-${data.importId}`
    })
    return job.id ?? data.importId
}

export const closeLeadImportQueue = async (): Promise<void> => {
    if (_leadImportQueue !== null) {
        await _leadImportQueue.close()
        _leadImportQueue = null
    }
}
