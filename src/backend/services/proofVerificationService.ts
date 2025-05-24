// @ts-nocheck
// TODO: Remove ts-nocheck and fix all type errors

import {
    ProofTask,
    updateProofTaskStatus,
    findProcessableTasks, 
    getStuckAndExpiredTasks,
    getWallet,
    saveWalletLink,
    updateProofTaskAttempts
} from '../database/db';
import { checkOwnershipAfter as checkZeroTxProof, ProofResult } from './proofChecker'; // Correct import for proof checking
import { CHECK_WALLET, PROOF_CHECK_INTERVAL_MS, PROOF_RETRY_LIMIT } from '../../shared/utils/constants';
import { hashTelegramId, decryptWallet, encryptWallet } from '../../shared/utils/crypto';
import logger from '../../shared/utils/logger'; // Import logger

const SERVICE_NAME = 'ProofVerificationService';

export class ProofVerificationService {
    private pollingIntervalId: NodeJS.Timeout | null = null;
    private isProcessingCycle = false;
    private isCleaningUp = false;

    constructor(private pollingIntervalMs: number = PROOF_CHECK_INTERVAL_MS || 30000) {
        logger.info(`[${SERVICE_NAME}] Initialized with interval ${pollingIntervalMs}ms.`);
    }

    public start(): void {
        if (!CHECK_WALLET) {
            logger.error(`[${SERVICE_NAME}] CRITICAL: CHECK_WALLET environment variable is not set. Service will not start.`);
            return; // Do not start the service if CHECK_WALLET is missing
        }

        if (this.pollingIntervalId) {
            logger.warn(`[${SERVICE_NAME}] Processor already running.`);
            return;
        }
        logger.info(`[${SERVICE_NAME}] Starting task processor.`);
        this.pollingIntervalId = setInterval(() => this.runFullCycle(), this.pollingIntervalMs);
        this.runFullCycle(); 
    }

    public stop(): void {
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
            logger.info(`[${SERVICE_NAME}] Task processor stopped.`);
        } else {
            logger.info(`[${SERVICE_NAME}] Task processor was not running.`);
        }
    }

    private async runFullCycle(): Promise<void> {
        logger.debug(`[${SERVICE_NAME}] Running full cycle.`);
        await this.handleStuckOrExpiredTasks();
        await this.processPendingTasks();
        logger.debug(`[${SERVICE_NAME}] Full cycle finished.`);
    }

    private async handleStuckOrExpiredTasks(): Promise<void> {
        if (this.isCleaningUp) return;
        this.isCleaningUp = true;
        try {
            const nowUtc = Math.floor(Date.now() / 1000);
            const tasks = await getStuckAndExpiredTasks(nowUtc);

            if (tasks && tasks.length > 0) {
                logger.info(`[${SERVICE_NAME}] Found ${tasks.length} stuck/expired tasks to process.`);
                for (const task of tasks) {
                    if (task.status === 'pending' || task.status === 'processing') {
                         logger.warn({ taskUid: task.task_uid, user: task.telegram_id, status: task.status }, `[${SERVICE_NAME}] Task is stuck/expired. Setting to EXPIRED.`);
                         await updateProofTaskStatus(task.task_uid, 'expired', { errorMessage: 'Task auto-expired by cleanup.' });
                    }
                }
            }
        } catch (error: any) {
            logger.error({ err: error }, `[${SERVICE_NAME}] Error in handleStuckOrExpiredTasks`);
        }
        this.isCleaningUp = false;
    }

    private async processPendingTasks(): Promise<void> {
        if (this.isProcessingCycle) return;
        this.isProcessingCycle = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const tasks = await findProcessableTasks(10);
            
            if (tasks.length > 0) {
                logger.info(`[${SERVICE_NAME}] Found ${tasks.length} pending tasks to process.`);
                for (const task of tasks) {
                    if (task.check_deadline_utc <= now) {
                        logger.warn({ taskUid: task.task_uid, wallet: task.wallet_address, deadline: new Date(task.check_deadline_utc * 1000).toISOString() }, `[${SERVICE_NAME}] Task passed deadline before processing. Marking expired.`);
                        await updateProofTaskStatus(task.task_uid, 'expired', { errorMessage: 'Deadline passed before processing attempt.' });
                        continue;
                    }
                    
                    const existingWalletLink = await getWallet(task.telegram_id);

                    if (existingWalletLink && existingWalletLink.proofed) {
                        logger.info({ wallet: existingWalletLink.wallet, telegramId: task.telegram_id, taskUid: task.task_uid }, `[${SERVICE_NAME}] Wallet already proofed. Task marked success.`);
                        await updateProofTaskStatus(task.task_uid, 'success', { errorMessage: 'Wallet already proofed.' });
                        
                        if (!existingWalletLink.raw_telegram_id && existingWalletLink.wallet) {
                             await saveWalletLink(task.telegram_id, existingWalletLink.wallet, true, task.telegram_id);
                             const telegramIdHash = hashTelegramId(task.telegram_id);
                             logger.info({ telegramIdHash, rawTelegramId: task.telegram_id }, `[${SERVICE_NAME}] Updated existing wallet with raw_telegram_id.`);
                        }
                        continue; 
                    }
                    await this.processSingleTask(task);
                }
            }
        } catch (error: any) {
            logger.error({ err: error }, `[${SERVICE_NAME}] Error in processPendingTasks`);
        }
        this.isProcessingCycle = false;
    }

    private async processSingleTask(task: ProofTask): Promise<void> {
        logger.info({ taskUid: task.task_uid, wallet: task.wallet_address_encrypted }, `[${SERVICE_NAME}] Processing single task.`);

        if (!CHECK_WALLET) {
            logger.error({ taskUid: task.task_uid }, `[${SERVICE_NAME}] CRITICAL: CHECK_WALLET not set during single task processing.`);
            await updateProofTaskStatus(task.task_uid, 'error', { errorMessage: 'CHECK_WALLET not configured on server' });
            return;
        }

        await updateProofTaskStatus(task.task_uid, 'processing');
        const currentAttempts = task.attempts || 0;
        const newAttempts = currentAttempts + 1;

        try {
            await updateProofTaskAttempts(task.task_uid, newAttempts);
        } catch (dbError: any) {
            logger.error({ err: dbError, taskUid: task.task_uid }, `[${SERVICE_NAME}] Failed to update attempts for task`);
        }

        let proofFound = false;
        try {
            const decryptedWalletAddress = decryptWallet(task.wallet_address_encrypted);
            if (!decryptedWalletAddress) {
                logger.error({ taskUid: task.task_uid, encryptedWallet: task.wallet_address_encrypted }, `[${SERVICE_NAME}] Failed to decrypt wallet address for task.`);
                await updateProofTaskStatus(task.task_uid, 'error', { errorMessage: 'Internal error: Failed to decrypt wallet address' });
                return;
            }
            logger.debug({ taskUid: task.task_uid, decryptedWalletAddress }, `[${SERVICE_NAME}] Decrypted wallet address.`);

            const proofResult: ProofResult = await checkZeroTxProof(
                decryptedWalletAddress,
                task.after_timestamp,
                task.check_deadline_utc,
                CHECK_WALLET
            );

            if (proofResult.isProofConfirmed) {
                logger.info({ taskUid: task.task_uid, txHash: proofResult.txHash, wallet: decryptedWalletAddress }, `[${SERVICE_NAME}] Proof FOUND for task.`);
                await saveWalletLink(task.telegram_id, decryptedWalletAddress, true, task.telegram_id);
                logger.info({ telegramId: task.telegram_id, wallet: decryptedWalletAddress }, `[${SERVICE_NAME}] Wallet link saved/updated.`);
                await updateProofTaskStatus(task.task_uid, 'success', { foundTxHash: proofResult.txHash });
            } else {
                logger.info({ taskUid: task.task_uid, attempts: newAttempts, error: proofResult.error }, `[${SERVICE_NAME}] Proof NOT FOUND for task.`);
                const nowUtc = Math.floor(Date.now() / 1000);
                if (task.check_deadline_utc <= nowUtc) {
                    logger.warn({ taskUid: task.task_uid }, `[${SERVICE_NAME}] Task EXPIRED after check.`);
                    await updateProofTaskStatus(task.task_uid, 'expired', { errorMessage: 'Deadline passed, proof not found.' });
                } else if (newAttempts >= PROOF_RETRY_LIMIT) {
                    logger.warn({ taskUid: task.task_uid, attempts: newAttempts, limit: PROOF_RETRY_LIMIT }, `[${SERVICE_NAME}] Task FAILED - max retries reached.`);
                    await updateProofTaskStatus(task.task_uid, 'failed_no_tx', { errorMessage: `Max retry limit (${PROOF_RETRY_LIMIT}) reached. Attempts: ${newAttempts}` });
                } else {
                    logger.info({ taskUid: task.task_uid, attempts: newAttempts }, `[${SERVICE_NAME}] Task attempt failed. Will retry.`);
                }
            }
        } catch (error: any) {
            logger.error({ err: error, taskUid: task.task_uid, taskDetails: task }, `[${SERVICE_NAME}] Error processing task`);
            await updateProofTaskStatus(task.task_uid, 'error', { errorMessage: error.message });
        }
    }
} 