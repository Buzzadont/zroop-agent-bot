import * as db from '../database/db';
import logger from '../../shared/utils/logger'; // Import logger

const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COMPLETED_TASK_RETENTION_DAYS = 7;

export class HousekeepingService {
    private intervalId: NodeJS.Timeout | null = null;

    constructor() {
        logger.info('[HousekeepingService] Initialized.');
    }

    public start(): void {
        if (this.intervalId) {
            logger.warn('[HousekeepingService] Already running.');
            return;
        }
        logger.info(`[HousekeepingService] Starting periodic cleanup. Interval: ${HOUSEKEEPING_INTERVAL_MS / (60 * 60 * 1000)} hours. Retention: ${COMPLETED_TASK_RETENTION_DAYS} days.`);
        
        this.cleanupOldProofTasks(); 

        this.intervalId = setInterval(() => {
            this.cleanupOldProofTasks();
        }, HOUSEKEEPING_INTERVAL_MS);
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('[HousekeepingService] Stopped.');
        } else {
            logger.info('[HousekeepingService] Was not running, no action taken to stop.');
        }
    }

    private cleanupOldProofTasks(): void {
        try {
            logger.info('[HousekeepingService] Running cleanupOldProofTasks...');
            const deletedCount = db.deleteCompletedProofTasksOlderThan(COMPLETED_TASK_RETENTION_DAYS);
            logger.info(`[HousekeepingService] cleanupOldProofTasks completed. Deleted ${deletedCount} tasks.`);
        } catch (error) {
            logger.error({ err: error }, '[HousekeepingService] Error during cleanupOldProofTasks:');
        }
    }
}

// Optional: Export a singleton instance if preferred
// export const housekeepingServiceInstance = new HousekeepingService(); 