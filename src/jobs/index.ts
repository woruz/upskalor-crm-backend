import { ENVIRONMENT_VARIABLES } from '../common/constants/environment.constants.js'
import type { AppConfig } from '../common/types/config.js'
import { getLeadImportQueue, closeLeadImportQueue } from './queues/lead-import.queue.js'
import { createLeadImportWorker, closeLeadImportWorker } from './workers/lead-import.worker.js'

export const initWorkers = (config: AppConfig): void => {
    // Only initialize queues and workers if REDIS_URL is provided
    const redisUrl = config.redisUrl ?? process.env[ENVIRONMENT_VARIABLES.REDIS_URL]
    if (redisUrl) {
        getLeadImportQueue()
        createLeadImportWorker(config)
        process.stdout.write(
            `${JSON.stringify({ level: 'info', message: 'BullMQ workers initialized', timestamp: new Date().toISOString() })}\n`
        )
    }
}

export const closeWorkers = async (): Promise<void> => {
    await closeLeadImportWorker()
}

export const closeQueues = async (): Promise<void> => {
    await closeLeadImportQueue()
}

export { enqueueLeadImportJob, type LeadImportJobData } from './queues/lead-import.queue.js'
