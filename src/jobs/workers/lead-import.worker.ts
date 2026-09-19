import { Worker, type Job } from 'bullmq'
import type { S3Client } from '@aws-sdk/client-s3'

import { createStorageClient } from '../../common/utils/storage.js'
import type { AppConfig } from '../../common/types/config.js'
import { createBullMqRedisConnection } from '../redis.js'
import { LEAD_IMPORT_QUEUE_NAME, type LeadImportJobData } from '../queues/lead-import.queue.js'
import { executeImportJob } from '../../modules/leads/lead-transfers.js'

let _leadImportWorker: Worker<LeadImportJobData> | null = null

const writeLog = (level: 'info' | 'error' | 'warn', message: string, metadata: Record<string, unknown> = {}): void => {
    process.stdout.write(`${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...metadata })}\n`)
}

export const createLeadImportWorker = (config: AppConfig, s3Client?: S3Client): Worker<LeadImportJobData> => {
    if (_leadImportWorker !== null) {
        return _leadImportWorker
    }

    const storageClient = s3Client ?? createStorageClient(config.storage)

    _leadImportWorker = new Worker<LeadImportJobData>(
        LEAD_IMPORT_QUEUE_NAME,
        async (job: Job<LeadImportJobData>) => {
            const { companyId, userId, importId, s3Key } = job.data

            writeLog('info', 'Starting lead import background job', {
                jobId: job.id,
                importId,
                companyId,
                s3Key
            })

            await executeImportJob(storageClient, config.storage, companyId, userId, importId, s3Key)

            writeLog('info', 'Lead import background job completed successfully', {
                jobId: job.id,
                importId,
                companyId
            })
        },
        {
            connection: createBullMqRedisConnection(),
            concurrency: 3
        }
    )

    _leadImportWorker.on('completed', (job: Job<LeadImportJobData>) => {
        writeLog('info', `BullMQ Job ${job.id} completed`, { importId: job.data.importId })
    })

    _leadImportWorker.on('failed', (job: Job<LeadImportJobData> | undefined, error: Error) => {
        writeLog('error', `BullMQ Job ${job?.id ?? 'unknown'} failed`, {
            importId: job?.data?.importId,
            error: error.message,
            stack: error.stack
        })
    })

    _leadImportWorker.on('error', (error: Error) => {
        writeLog('error', 'BullMQ Worker error', { error: error.message })
    })

    return _leadImportWorker
}

export const closeLeadImportWorker = async (): Promise<void> => {
    if (_leadImportWorker !== null) {
        await _leadImportWorker.close()
        _leadImportWorker = null
    }
}
