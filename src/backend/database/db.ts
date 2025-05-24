// Database module for SQLite operations
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { hashTelegramId, hashWallet, encryptWallet, decryptWallet } from '../../shared/utils/crypto';
import logger from '../../shared/utils/logger';

dotenv.config();

const db = new Database(process.env.DB_PATH || './db/zroop.db');

// --- Database Initialization (Table and Trigger) ---

db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id_hash TEXT NOT NULL UNIQUE, -- Hash of (telegramId + SALT)
        raw_telegram_id TEXT DEFAULT NULL,    -- Raw Telegram ID, populated during proofing. NULLABLE for existing records.
        wallet_hash TEXT NOT NULL,            -- Hash of (lowercase_wallet_address + SALT)
        wallet_encrypted TEXT NOT NULL,       -- AES encrypted lowercase_wallet_address (key: SALT)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        proofed INTEGER DEFAULT 0,             -- 0 for false, 1 for true (default: 0)
        last_terminal_activity_at DATETIME    -- Added for terminal activity tracking
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_id_hash ON wallets(telegram_id_hash);
    CREATE INDEX IF NOT EXISTS idx_wallet_hash ON wallets(wallet_hash);
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id_hash TEXT NOT NULL,     -- Hash of (telegramId + SALT)
        raw_telegram_id TEXT NOT NULL,      -- Raw Telegram ID, for sending notifications
        collection_address TEXT NOT NULL,   -- Contract address of the NFT collection
        alert_type TEXT NOT NULL,           -- e.g., 'floor_change', 'offer_change', 'new_mint', 'volume_spike'
        threshold_value REAL,               -- Optional: for 'floor_change' (price), 'volume_spike' (percentage)
        last_floor_notified_at DATETIME DEFAULT NULL, -- Timestamp of the last floor price notification
        last_offer_notified_at DATETIME DEFAULT NULL, -- Timestamp of the last offer price notification
        is_active INTEGER DEFAULT 1,        -- 0 for false, 1 for true
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id_hash) REFERENCES wallets (telegram_id_hash) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_tg_id_hash ON alert_subscriptions (telegram_id_hash);
    CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_collection_address ON alert_subscriptions (collection_address);
    CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_alert_type ON alert_subscriptions (alert_type);
`);

db.exec(`
    -- Trigger to update the updated_at timestamp on row modification for wallets table
    CREATE TRIGGER IF NOT EXISTS update_wallets_timestamp
    AFTER UPDATE ON wallets BEGIN
        UPDATE wallets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
`);

db.exec(`
    -- Trigger to update the updated_at timestamp on row modification for alert_subscriptions table
    CREATE TRIGGER IF NOT EXISTS update_alert_subscriptions_timestamp
    AFTER UPDATE ON alert_subscriptions BEGIN
        UPDATE alert_subscriptions SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
`);

// --- New Table: proof_tasks ---
db.exec(`
    CREATE TABLE IF NOT EXISTS proof_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_uid TEXT NOT NULL UNIQUE,          -- Unique identifier for the task (e.g., UUID)
        telegram_id TEXT NOT NULL,              -- Raw Telegram ID
        wallet_address_encrypted TEXT NOT NULL, -- User's wallet address (lowercase, encrypted)
        after_timestamp INTEGER NOT NULL,       -- Unix timestamp (seconds) after which the transaction must be found
        check_deadline_utc INTEGER NOT NULL,    -- Unix timestamp (seconds) when this task expires
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'success', 'failed_no_tx', 'expired', 'error', 'cancelled'
        attempts INTEGER DEFAULT 0 NOT NULL,    -- Number of verification attempts
        last_checked_block INTEGER,             -- Last block number checked by the processor for this task
        found_tx_hash TEXT,                     -- Hash of the found proof transaction, if successful
        error_message TEXT,                     -- Error message if status is 'error'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_proof_tasks_telegram_id ON proof_tasks(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_proof_tasks_status ON proof_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_proof_tasks_check_deadline_utc ON proof_tasks(check_deadline_utc);
    CREATE INDEX IF NOT EXISTS idx_proof_tasks_task_uid ON proof_tasks(task_uid);
`);

db.exec(`
    -- Trigger to update the updated_at timestamp on row modification for proof_tasks table
    CREATE TRIGGER IF NOT EXISTS update_proof_tasks_timestamp
    AFTER UPDATE ON proof_tasks BEGIN
        UPDATE proof_tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
`);

// --- New Table: modularium_collection_market_state ---
db.exec(`
    CREATE TABLE IF NOT EXISTS modularium_collection_market_state (
        collection_address TEXT PRIMARY KEY,    -- Collection contract address from Modularium.
        last_known_floor_price REAL,            -- Last floor price recorded from Modularium.
        last_known_offer_price REAL,            -- Last best offer price recorded from Modularium.
        last_floor_price_processed_at TEXT,     -- Timestamp when the floor price for this collection was last processed for notifications.
        last_offer_price_processed_at TEXT,     -- Timestamp when the offer price for this collection was last processed for notifications.
        data_updated_at DATETIME,               -- Timestamp when the price data in this row was last updated from the marketplace.
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_modularium_collection_market_state_ca ON modularium_collection_market_state(collection_address);

    CREATE TRIGGER IF NOT EXISTS update_modularium_collection_market_state_updated_at
    AFTER UPDATE ON modularium_collection_market_state
    FOR EACH ROW
    BEGIN
        UPDATE modularium_collection_market_state SET updated_at = CURRENT_TIMESTAMP WHERE collection_address = OLD.collection_address;
    END;
`);

// --- Alert Subscription Types --- //

export interface AlertSubscription {
    id: number;
    telegram_id_hash: string;
    raw_telegram_id: string;
    collection_address: string;
    alert_type: string; // 'floor_change', 'offer_change', etc.
    threshold_value: number | null;
    last_floor_notified_at: string | null;
    last_offer_notified_at: string | null;
    is_active: number; // 0 or 1
    created_at: string;
    updated_at: string;
}

// --- Modularium Collection Market State Types --- //
export interface ModulariumCollectionMarketState {
    collection_address: string;
    last_known_floor_price: number | null;
    last_known_offer_price: number | null;
    last_floor_price_processed_at: string | null;
    last_offer_price_processed_at: string | null;
    data_updated_at: string | null; // ISO string
    created_at: string; // ISO string
    updated_at: string; // ISO string
}

// --- Data Access Functions --- //

/**
 * Saves or updates the link between Telegram ID and wallet address.
 * Uses INSERT OR REPLACE based on the unique telegram_id_hash.
 * @param telegramId - Telegram user ID (string) used for hashing to get telegram_id_hash.
 * @param wallet - Wallet address (string).
 * @param isProofed - Proof status (boolean, defaults to false).
 * @param rawTelegramIdToStore - The raw Telegram ID to store. If not provided, `telegramId` param is used.
 * @returns The result object from better-sqlite3 execution (`RunResult`).
 */
export function saveWalletLink(telegramId: string, wallet: string, isProofed: boolean = false, rawTelegramIdToStore?: string): Database.RunResult {
    const telegramIdHash = hashTelegramId(telegramId);
    // If rawTelegramIdToStore is not explicitly passed, use the telegramId from which hash was derived.
    const finalRawTelegramId = rawTelegramIdToStore || telegramId; 
    const walletLower = wallet.toString().toLowerCase();
    const walletHash = hashWallet(walletLower);
    const walletEncrypted = encryptWallet(walletLower);
    const proofedStatus = isProofed ? 1 : 0;

    const stmt = db.prepare(
        `INSERT INTO wallets (telegram_id_hash, raw_telegram_id, wallet_hash, wallet_encrypted, proofed, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_id_hash) DO UPDATE SET
        raw_telegram_id = excluded.raw_telegram_id,
        wallet_hash = excluded.wallet_hash,
        wallet_encrypted = excluded.wallet_encrypted,
        proofed = excluded.proofed,
        updated_at = CURRENT_TIMESTAMP`
    );
    
    const result = stmt.run(telegramIdHash, finalRawTelegramId, walletHash, walletEncrypted, proofedStatus);
    logger.debug({ telegramIdHash, finalRawTelegramId, changes: result.changes }, `[DB] saveWalletLink`);
    return result;
}

/**
 * Retrieves the decrypted wallet address, proof status, creation time, and last terminal activity.
 * @param telegramId - Telegram user ID (string).
 * @returns An object { wallet: string, proofed: boolean, createdAt: string, lastTerminalActivityAt: string | null } or null if not found.
 */
export function getWallet(telegramId: string): { wallet: string, proofed: boolean, createdAt: string, lastTerminalActivityAt: string | null } | null {
    const telegramIdHash = hashTelegramId(telegramId);
    // logger.debug({ telegramIdHash }, `[DB] Getting wallet for TG Hash`); // Can be noisy for /status
    const sql = 'SELECT wallet_encrypted, proofed, created_at, last_terminal_activity_at FROM wallets WHERE telegram_id_hash = ?';
    const row = db.prepare(sql).get(telegramIdHash) as { wallet_encrypted: string, proofed: number, created_at: string, last_terminal_activity_at: string | null } | undefined;

    if (!row) {
        // logger.debug({ telegramIdHash }, `[DB] No wallet found for TG Hash`); // Informative when null is expected
        return null;
    }
    
    const decryptedWallet = decryptWallet(row.wallet_encrypted);
    return {
        wallet: decryptedWallet,
        proofed: !!row.proofed,
        createdAt: row.created_at,
        lastTerminalActivityAt: row.last_terminal_activity_at
    };
}

/**
 * Deletes the wallet record by Telegram ID.
 * @param telegramId - Telegram user ID (string).
 * @returns true if a record was deleted, false otherwise.
 */
export function unlinkWallet(telegramId: string): boolean {
    const telegramIdHash = hashTelegramId(telegramId);
    logger.info({ telegramIdHash }, `[DB] Unlinking wallet for TG Hash`); // Keep: important operation
    const result = db.prepare('DELETE FROM wallets WHERE telegram_id_hash = ?').run(telegramIdHash);
    return result.changes > 0;
}

/**
 * Finds the Telegram ID hash by wallet hash. Useful for reverse lookups if needed.
 * @param wallet - Wallet address (string).
 * @returns The Telegram ID hash (string) or null if not found.
 */
export function getTelegramIdByWallet(wallet: string): string | null {
    const walletHash = hashWallet(wallet);
    // logger.debug({ walletHash }, `[DB] Getting TG Hash by Wallet Hash`); // If used rarely, can keep. Otherwise, comment.
    const row = db.prepare('SELECT telegram_id_hash FROM wallets WHERE wallet_hash = ?').get(walletHash) as { telegram_id_hash: string } | undefined;
    return row ? row.telegram_id_hash : null;
}

/**
 * Updates the last terminal activity timestamp for a user.
 * @param telegramId - Telegram user ID (string).
 * @returns true if the record was updated, false otherwise.
 */
export function updateLastTerminalActivity(telegramId: string): boolean {
    const telegramIdHash = hashTelegramId(telegramId);
    const now = new Date().toISOString();
    logger.info({ telegramIdHash, now }, `[DB] Updating last terminal activity for TG Hash`); // Keep: important operation
    const stmt = db.prepare('UPDATE wallets SET last_terminal_activity_at = ? WHERE telegram_id_hash = ?');
    const result = stmt.run(now, telegramIdHash);
    return result.changes > 0;
}

// --- Alert Subscription Functions --- //

/**
 * Creates a new alert subscription for a user.
 * @param telegramId - Telegram user ID (string).
 * @param collectionAddress - The contract address of the collection to monitor.
 * @param alertType - Type of alert (e.g., 'floor_change', 'new_mint', 'volume_spike').
 * @param thresholdValue - Optional threshold value (e.g., price for floor_change).
 * @returns The ID of the created subscription, or null if creation failed.
 */
export function createAlertSubscription(
    telegramId: string, 
    collectionAddress: string, 
    alertType: string, 
    thresholdValue?: number
): number | null {
    const telegramIdHash = hashTelegramId(telegramId); // Hash the raw telegramId for storage and lookups
    const rawTelegramIdForDb = telegramId; // Use the raw telegramId directly for the raw_telegram_id column

    //logger.debug({ telegramId, telegramIdHash, collectionAddress, alertType, thresholdValue }, `[DB createAlertSubscription] Received`);

    const userWallet = getWallet(telegramId); // Check if user exists and wallet is proofed
    if (!userWallet || !userWallet.proofed) {
        logger.error({ telegramIdHash }, `[DB] Cannot create alert: User not found or wallet not proofed for telegramId hash ${telegramIdHash}`);
        return null;
    }
    
    const normalizedCollectionAddress = collectionAddress.toLowerCase();
    
    const stmt = db.prepare(`
        INSERT INTO alert_subscriptions 
        (telegram_id_hash, raw_telegram_id, collection_address, alert_type, threshold_value, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
    `);
    
    try {
        const result = stmt.run(telegramIdHash, rawTelegramIdForDb, normalizedCollectionAddress, alertType, thresholdValue);
        //logger.debug({ telegramIdHash, collectionAddress, alertType, subscriptionId: result.lastInsertRowid }, `[DB createAlertSubscription] Insert Result`);
        return result.lastInsertRowid as number;
    } catch (error) {
        logger.error({ error }, '[DB] Error creating alert subscription');
        return null;
    }
}

/**
 * Gets all active alert subscriptions for a user.
 * @param telegramId - Telegram user ID (string).
 * @returns Array of subscription objects or an empty array if none found.
 */
export function getAlertSubscriptions(telegramId: string): Array<AlertSubscription> {
    const telegramIdHash = hashTelegramId(telegramId);
    // logger.debug({ telegramIdHash }, `[DB] Getting alert subscriptions for TG Hash`); // Can be noisy
    const sql = `
        SELECT id, telegram_id_hash, raw_telegram_id, collection_address, alert_type, threshold_value, 
               last_floor_notified_at, last_offer_notified_at, is_active, created_at, updated_at
        FROM alert_subscriptions 
        WHERE telegram_id_hash = ? AND is_active = 1
    `;
    try {
        const rows = db.prepare(sql).all(telegramIdHash) as Array<AlertSubscription>;
        return rows;
    } catch (error) {
        logger.error({ error }, '[DB] Error getting alert subscriptions');
        return [];
    }
}

/**
 * Gets all active alert subscriptions for a specific collection and alert type.
 * Used by AlertProcessorService.
 * @param collectionAddress - The contract address of the collection.
 * @param alertType - The type of alert.
 * @returns Array of subscription objects.
 */
export function getActiveAlertSubscriptionsByCollectionAndType(collectionAddress: string, alertType: string): Array<AlertSubscription> {
    const normalizedCollectionAddress = collectionAddress.toLowerCase();
    const sql = `
        SELECT id, telegram_id_hash, raw_telegram_id, collection_address, alert_type, threshold_value, 
               last_floor_notified_at, last_offer_notified_at, is_active, created_at, updated_at
        FROM alert_subscriptions 
        WHERE collection_address = ? AND alert_type = ? AND is_active = 1
    `;
    try {
        const rows = db.prepare(sql).all(normalizedCollectionAddress, alertType) as Array<AlertSubscription>;
        return rows;
    } catch (error) {
        logger.error({ error }, '[DB] Error getting active alert subscriptions by collection and type');
        return [];
    }
}

/**
 * Gets all active alert subscriptions, regardless of user.
 * Used by AlertProcessorService to fetch all subscriptions to process.
 * @returns Array of all active AlertSubscription objects.
 */
export function getAllActiveAlertSubscriptions(): Array<AlertSubscription> {
    const sql = `
        SELECT id, telegram_id_hash, raw_telegram_id, collection_address, alert_type, threshold_value, 
               last_floor_notified_at, last_offer_notified_at, is_active, created_at, updated_at
        FROM alert_subscriptions 
        WHERE is_active = 1
    `;
    try {
        const rows = db.prepare(sql).all() as Array<AlertSubscription>;
        return rows;
    } catch (error) {
        logger.error({ error }, '[DB] Error getting all active alert subscriptions');
        return [];
    }
}

/**
 * Deletes an alert subscription.
 * @param telegramId - Telegram user ID (string).
 * @param subscriptionId - The ID of the subscription to delete.
 * @returns true if a record was deleted, false otherwise.
 */
export function deleteAlertSubscription(telegramId: string, subscriptionId: number): boolean {
    const telegramIdHash = hashTelegramId(telegramId);
    logger.info({ telegramIdHash, subscriptionId }, '[DB] Deleting alert subscription');
    // Optional: Add a check to ensure the subscription belongs to the user trying to delete it
    const result = db.prepare('DELETE FROM alert_subscriptions WHERE id = ? AND telegram_id_hash = ?').run(subscriptionId, telegramIdHash);
    return result.changes > 0;
}

/**
 * Deletes all alert subscriptions for a given telegram_id_hash.
 * Used when a user unlinks their wallet.
 * @param telegramIdHash - The hashed Telegram ID.
 * @returns true if records were deleted, false otherwise.
 */
export function deleteAlertSubscriptionsByTelegramIdHash(telegramIdHash: string): boolean {
    logger.info({ telegramIdHash }, '[DB] Deleting ALL alert subscriptions for TG Hash');
    const result = db.prepare('DELETE FROM alert_subscriptions WHERE telegram_id_hash = ?').run(telegramIdHash);
    if (result.changes > 0) {
        //logger.debug({ deletedCount: result.changes }, '[DB] Successfully deleted subscriptions for TG Hash');
    } else {
        //logger.debug({ telegramIdHash }, '[DB] No subscriptions found to delete for TG Hash');
    }
    return result.changes > 0;
}

/**
 * Updates the last notified timestamp for a specific alert type on a subscription.
 * @param subscriptionId - The ID of the subscription.
 * @param alertType - 'floor_change' or 'offer_change'.
 * @param notifiedAt - ISO string timestamp of when the notification was sent.
 * @returns true if updated, false otherwise.
 */
export function updateUserSubscriptionLastNotifiedAt(subscriptionId: number, alertType: 'floor_change' | 'offer_change', notifiedAt: string): boolean {
    let columnToUpdate: string;
    if (alertType === 'floor_change') {
        columnToUpdate = 'last_floor_notified_at';
    } else if (alertType === 'offer_change') {
        columnToUpdate = 'last_offer_notified_at';
    } else {
        logger.warn({ alertType, subscriptionId }, '[DB] Invalid alertType for updateUserSubscriptionLastNotifiedAt');
        return false;
    }

    const stmt = db.prepare(`UPDATE alert_subscriptions SET ${columnToUpdate} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const result = stmt.run(notifiedAt, subscriptionId);
    //logger.debug({ subscriptionId, alertType, notifiedAt }, '[DB] Updated user subscription last_notified_at');
    return result.changes > 0;
}

/**
 * Retrieves a single alert subscription by its ID.
 * @param id - The ID of the subscription.
 * @returns The subscription object or null if not found.
 */
export function getAlertSubscriptionById(id: number): AlertSubscription | null {
    const sql = `
        SELECT id, telegram_id_hash, raw_telegram_id, collection_address, alert_type, threshold_value, 
               last_floor_notified_at, last_offer_notified_at, is_active, created_at, updated_at
        FROM alert_subscriptions 
        WHERE id = ?
    `;
    try {
        const row = db.prepare(sql).get(id) as AlertSubscription | undefined;
        return row || null;
    } catch (error) {
        logger.error({ error }, `[DB] Error getting alert subscription by ID ${id}`);
        return null;
    }
}

/**
 * Updates the active status of an alert subscription.
 * @param subscriptionId - The ID of the subscription to update.
 * @param isActive - The new active status (true for active, false for inactive).
 * @returns true if the record was updated, false otherwise.
 */
export function updateAlertSubscriptionActiveStatus(subscriptionId: number, isActive: boolean): boolean {
    const activeStatus = isActive ? 1 : 0;
    logger.info({ subscriptionId, isActive: activeStatus }, '[DB] Updating alert subscription active status');
    const stmt = db.prepare('UPDATE alert_subscriptions SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(activeStatus, subscriptionId);
    if (result.changes === 0) {
        logger.warn({ subscriptionId, isActive: activeStatus }, '[DB] updateAlertSubscriptionActiveStatus: No subscription found with ID ${subscriptionId} to update, or status was already ${activeStatus}.');
    }
    return result.changes > 0;
}

// --- Proof Task Functions --- //

const NFT_CHECKER_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export interface ProofTask {
    task_uid: string;
    telegram_id: string;
    wallet_address_encrypted: string;
    after_timestamp: number;
    check_deadline_utc: number;
    status: 'pending' | 'processing' | 'completed_success' | 'completed_failed' | 'expired' | 'error' | 'cancelled_by_user';
    attempts: number;
    created_at: string;
    updated_at: string;
    found_tx_hash?: string | null;
    error_message?: string | null;
    last_checked_block?: number | null;
}

// Helper function (ensure it's defined if not already)
function rowToProofTask(row: any): ProofTask {
    if (!row) return null as any; // Should not happen if called with valid row
    return {
        task_uid: row.task_uid,
        telegram_id: row.telegram_id,
        wallet_address_encrypted: row.wallet_address_encrypted,
        after_timestamp: row.after_timestamp,
        check_deadline_utc: row.check_deadline_utc,
        status: row.status,
        attempts: row.attempts,
        created_at: row.created_at,
        updated_at: row.updated_at,
        found_tx_hash: row.found_tx_hash,
        error_message: row.error_message,
        last_checked_block: row.last_checked_block
    };
}

/**
 * Creates a new proof task.
 */
export function createProofTask(
    taskUid: string,
    telegramId: string,
    walletAddress: string,
    afterTimestamp: number,
    checkDeadlineUtc: number
): Database.RunResult {
    const encryptedWalletAddress = encryptWallet(walletAddress.toLowerCase());
    const stmt = db.prepare(`
        INSERT INTO proof_tasks (task_uid, telegram_id, wallet_address_encrypted, after_timestamp, check_deadline_utc) 
        VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(taskUid, telegramId, encryptedWalletAddress, afterTimestamp, checkDeadlineUtc);
}

/**
 * Retrieves a proof task by its unique UID.
 */
export function getProofTaskByUid(taskUid: string): ProofTask | null {
    // logger.debug({ taskUid }, `[DB] Getting proof task by UID`); // Usually not needed for regular flow
    const stmt = db.prepare('SELECT * FROM proof_tasks WHERE task_uid = ?');
    const taskRow = stmt.get(taskUid) as any;
    if (!taskRow) return null;
    return rowToProofTask(taskRow);
}

/**
 * Retrieves the most recent non-finalized (pending or processing) proof task for a given Telegram ID.
 */
export function getActiveProofTaskByTelegramId(telegramId: string): ProofTask | null {
    // logger.debug({ telegramId }, `[DB] Getting active proof task for TG`); // Can be noisy if called often by bot status
    try {
        const stmt = db.prepare(`
            SELECT *
            FROM proof_tasks
            WHERE telegram_id = ? AND (status = 'pending' OR status = 'processing')
            ORDER BY created_at DESC
            LIMIT 1
        `);
        const taskRow = stmt.get(telegramId) as any;
        if (!taskRow) return null;
        return rowToProofTask(taskRow);
    } catch (error) {
        logger.error({ error }, `[DB] Error getting active proof task for telegramId ${telegramId}`);
        return null;
    }
}

/**
 * Updates the status and other details of a proof task.
 */
export function updateProofTaskStatus(
    taskUid: string,
    status: ProofTask['status'],
    details?: {
        foundTxHash?: string;
        errorMessage?: string;
        lastCheckedBlock?: number;
    }
): Database.RunResult {
    // logger.debug({ taskUid, status, details }, `[DB] Updating proof task ${taskUid} to status ${status}`); // This is very important, KEEP
    let sql = 'UPDATE proof_tasks SET status = ?';
    const params: any[] = [status];

    if (details?.foundTxHash !== undefined) {
        sql += ', found_tx_hash = ?';
        params.push(details.foundTxHash);
    }
    if (details?.errorMessage !== undefined) {
        sql += ', error_message = ?';
        params.push(details.errorMessage);
    }
    if (details?.lastCheckedBlock !== undefined) {
        sql += ', last_checked_block = ?';
        params.push(details.lastCheckedBlock);
    }

    sql += ', updated_at = CURRENT_TIMESTAMP';
    sql += ' WHERE task_uid = ?';
    params.push(taskUid);

    const stmt = db.prepare(sql);
    return stmt.run(...params);
}

/**
 * Finds tasks that are pending or processing and not past their deadline.
 */
export function findProcessableTasks(limit: number = 5): ProofTask[] {
    // logger.debug({ limit }, `[DB] findProcessableTasks called with limit`); // REMOVE - called periodically
    const nowUtc = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
        SELECT * FROM proof_tasks 
        WHERE status IN ('pending', 'processing') AND check_deadline_utc > ? 
        ORDER BY created_at ASC
        LIMIT ?
    `);
    return stmt.all(nowUtc, limit) as ProofTask[];
}

/**
 * Deletes pending or processing proof tasks for a given Telegram ID.
 * Useful before creating a new task for a user to avoid duplicates.
 */
export function deleteNonFinalizedProofTasksByTelegramId(telegramId: string): Database.RunResult {
    logger.info({ telegramId }, `[DB] Deleting non-finalized (pending/processing) proof tasks for TG`); // Keep: important operation
    const stmt = db.prepare(
        "DELETE FROM proof_tasks WHERE telegram_id = ? AND status IN ('pending', 'processing')"
    );
    return stmt.run(telegramId);
}

export function getStuckAndExpiredTasks(nowUtc: number): ProofTask[] {
    // logger.debug({ nowUtc }, `[DB] getStuckAndExpiredTasks called with nowUtc`); // REMOVE - called periodically
    const stmt = db.prepare(`
        SELECT *
        FROM proof_tasks
        WHERE (status = 'pending' OR status = 'processing')
          AND check_deadline_utc < ?
    `);
    const tasks = stmt.all(nowUtc) as any[];
    const result = tasks.map(rowToProofTask);
    // if (tasks.length > 0) { // Only log if tasks ARE found by this function
    //     logger.debug({ foundCount: tasks.length }, '[DB] Found stuck/expired tasks.');
    // }
    return result;
}

/**
 * Updates the attempts count for a specific proof task.
 * @param taskUid - The unique ID of the task.
 * @param attempts - The new attempts count.
 * @returns The result object from better-sqlite3 execution.
 */
export function updateProofTaskAttempts(taskUid: string, attempts: number): Database.RunResult {
    const stmt = db.prepare('UPDATE proof_tasks SET attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE task_uid = ?');
    return stmt.run(attempts, taskUid);
}

// --- Modularium Collection Market State Functions ---

/**
 * Retrieves the market state for a specific collection.
 * @param collectionAddress - The contract address of the collection.
 * @returns ModulariumCollectionMarketState object or null if not found.
 */
export function getModulariumCollectionMarketStateByAddress(collectionAddress: string): ModulariumCollectionMarketState | null {
    const normalizedCollectionAddress = collectionAddress.toLowerCase();
    const sql = 'SELECT * FROM modularium_collection_market_state WHERE collection_address = ?';
    try {
        const row = db.prepare(sql).get(normalizedCollectionAddress) as ModulariumCollectionMarketState | undefined;
        return row || null;
    } catch (error) {
        logger.error({ error }, `[DB] Error getting modularium_collection_market_state for ${normalizedCollectionAddress}`);
        return null;
    }
}

/**
 * Creates or updates the market state for a collection.
 * @param state - ModulariumCollectionMarketState object.
 * @returns The result object from better-sqlite3 execution.
 */
export function upsertModulariumCollectionMarketState(state: Partial<ModulariumCollectionMarketState> & { collection_address: string }): Database.RunResult | null {
    const {
        collection_address,
        last_known_floor_price,
        last_known_offer_price,
        last_floor_price_processed_at,
        last_offer_price_processed_at,
        data_updated_at
    } = state;

    const normalizedCollectionAddress = collection_address.toLowerCase();

    // Ensure numeric fields are numbers or null
    const floorPrice = typeof last_known_floor_price === 'number' ? last_known_floor_price : null;
    const offerPrice = typeof last_known_offer_price === 'number' ? last_known_offer_price : null;
    
    // For timestamp fields, ensure they are ISO strings or null
    const floorProcessedAt = last_floor_price_processed_at || null;
    const offerProcessedAt = last_offer_price_processed_at || null;
    const dataUpdatedAtValue = data_updated_at || null;

    const updateParts: string[] = [];
    const insertValues: (string | number | null)[] = [];
    const updateValues: (string | number | null)[] = [];

    // Helper to add fields for insert and update clauses
    const addField = (fieldName: string, value: string | number | null) => {
        if (value !== undefined) { // Allow null, but not undefined
            updateParts.push(`${fieldName} = ?`);
            insertValues.push(value); // For the VALUES part of INSERT
            updateValues.push(value); // For the SET part of UPDATE
        }
    };
    
    // Use helper for cleaner logic
    if (last_known_floor_price !== undefined) addField('last_known_floor_price', floorPrice);
    if (last_known_offer_price !== undefined) addField('last_known_offer_price', offerPrice);
    if (last_floor_price_processed_at !== undefined) addField('last_floor_price_processed_at', floorProcessedAt);
    if (last_offer_price_processed_at !== undefined) addField('last_offer_price_processed_at', offerProcessedAt);
    if (data_updated_at !== undefined) addField('data_updated_at', dataUpdatedAtValue);

    // Check if the record exists
    const existingRecord = db.prepare('SELECT 1 FROM modularium_collection_market_state WHERE collection_address = ?').get(normalizedCollectionAddress);

    if (updateParts.length === 0) {
        if (!existingRecord) {
            // No specific fields to update, but record doesn't exist, so insert with defaults.
            const insertSql = `
                INSERT INTO modularium_collection_market_state 
                (collection_address, last_known_floor_price, last_known_offer_price, data_updated_at, updated_at, created_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `;
            try {
                //logger.debug({ collection_address }, `[DB upsertMCMState] Inserting new with defaults: ${normalizedCollectionAddress}`);
                return db.prepare(insertSql).run(normalizedCollectionAddress, floorPrice, offerPrice, dataUpdatedAtValue);
            } catch (error) {
                logger.error({ error }, '[DB] Error inserting default modularium_collection_market_state');
                return null;
            }
        } else {
            // Record exists, but no fields to update. Optionally touch updated_at.
            //logger.debug({ collection_address }, `[DB upsertMCMState] No fields to update for existing collection: ${normalizedCollectionAddress}. Touching updated_at.`);
            try {
                 return db.prepare('UPDATE modularium_collection_market_state SET updated_at = CURRENT_TIMESTAMP WHERE collection_address = ?').run(normalizedCollectionAddress);
            } catch (error) {
                logger.error({ error }, '[DB] Error touching updated_at for modularium_collection_market_state');
                return null;
            }
        }
    }

    // Always update the 'updated_at' timestamp
    updateParts.push('updated_at = CURRENT_TIMESTAMP');

    const columnNamesForInsert = ['collection_address'];
    const placeholdersForInsert = ['?'];
    const finalInsertValues: (string | number | null)[] = [normalizedCollectionAddress];

    if (last_known_floor_price !== undefined) { columnNamesForInsert.push('last_known_floor_price'); placeholdersForInsert.push('?'); finalInsertValues.push(floorPrice); }
    if (last_known_offer_price !== undefined) { columnNamesForInsert.push('last_known_offer_price'); placeholdersForInsert.push('?'); finalInsertValues.push(offerPrice); }
    if (last_floor_price_processed_at !== undefined) { columnNamesForInsert.push('last_floor_price_processed_at'); placeholdersForInsert.push('?'); finalInsertValues.push(floorProcessedAt); }
    if (last_offer_price_processed_at !== undefined) { columnNamesForInsert.push('last_offer_price_processed_at'); placeholdersForInsert.push('?'); finalInsertValues.push(offerProcessedAt); }
    if (data_updated_at !== undefined) { columnNamesForInsert.push('data_updated_at'); placeholdersForInsert.push('?'); finalInsertValues.push(dataUpdatedAtValue); }
    
    // Add created_at for new records, ensure updated_at is part of insert if not handled by trigger only
    if (!existingRecord) {
        columnNamesForInsert.push('created_at');
        placeholdersForInsert.push('CURRENT_TIMESTAMP'); // SQLite handles this keyword
    }
    columnNamesForInsert.push('updated_at'); // Will be set by ON CONFLICT or initial insert
    placeholdersForInsert.push('CURRENT_TIMESTAMP');


    const sql = `
        INSERT INTO modularium_collection_market_state (${columnNamesForInsert.join(', ')})
        VALUES (${placeholdersForInsert.join(', ')})
        ON CONFLICT(collection_address) DO UPDATE SET
        ${updateParts.join(', ')}
    `;
    
    // Values for the SET part of ON CONFLICT DO UPDATE
    const finalUpdateValues = updateValues; // These are already aligned with updateParts '?'

    // For `better-sqlite3`, if ON CONFLICT DO UPDATE SET uses '?', values for the update part are appended after insert values.
    // However, it's often clearer if the SET part uses `excluded.column_name` or direct values.
    // My current `updateParts` uses `column = ?`.
    
    // The execution values should be: [normalizedCollectionAddress, ...values for insert columns that are not collection_address ..., ...values for update SET assignments]
    // The `finalInsertValues` already contains `normalizedCollectionAddress` and values for insert.
    // The `finalUpdateValues` contains values for the `SET` clause.

    const executionValues = [...finalInsertValues.slice(1)]; // Remove duplicate CA for VALUES(...) part, keep others. First ? is CA.
    // For the SET clause, we need to provide values for each '?'
    // Rebuild execution values carefully.
    
    let executionValuesForRun: (string | number | null)[] = [];
    
    // Values for INSERT part
    executionValuesForRun.push(normalizedCollectionAddress); // collection_address
    if (columnNamesForInsert.includes('last_known_floor_price')) executionValuesForRun.push(floorPrice);
    if (columnNamesForInsert.includes('last_known_offer_price')) executionValuesForRun.push(offerPrice);
    if (columnNamesForInsert.includes('last_floor_price_processed_at')) executionValuesForRun.push(floorProcessedAt);
    if (columnNamesForInsert.includes('last_offer_price_processed_at')) executionValuesForRun.push(offerProcessedAt);
    if (columnNamesForInsert.includes('data_updated_at')) executionValuesForRun.push(dataUpdatedAtValue);
    // created_at and updated_at for INSERT are handled by CURRENT_TIMESTAMP keyword in SQL

    // Values for UPDATE SET part (must match '?' in updateParts)
    if (updateParts.some(p => p.startsWith('last_known_floor_price'))) executionValuesForRun.push(floorPrice);
    if (updateParts.some(p => p.startsWith('last_known_offer_price'))) executionValuesForRun.push(offerPrice);
    if (updateParts.some(p => p.startsWith('last_floor_price_processed_at'))) executionValuesForRun.push(floorProcessedAt);
    if (updateParts.some(p => p.startsWith('last_offer_price_processed_at'))) executionValuesForRun.push(offerProcessedAt);
    if (updateParts.some(p => p.startsWith('data_updated_at'))) executionValuesForRun.push(dataUpdatedAtValue);
    // updated_at for UPDATE is handled by CURRENT_TIMESTAMP keyword in SQL

    try {
        // logger.debug({ sql: sql.replace(/\\s+/g, ' ').substring(0, 200) + '...', params: executionValuesForRun }, `[DB upsertMCMState] SQL`);
        // logger.debug({ executionValuesForRun }, `[DB upsertMCMState] Execution Values`);
        return db.prepare(sql).run(...executionValuesForRun);
    } catch (error) {
        logger.error({ error }, `[DB] Error upserting modularium_collection_market_state for ${normalizedCollectionAddress}`);
        logger.error("SQL:", sql);
        logger.error("Execution Values:", executionValuesForRun);
        return null;
    }
}

export default db; 

// --- Housekeeping Functions ---

/**
 * Deletes completed (success, failed, expired, error, cancelled) proof tasks older than a specified number of days.
 * Uses the 'created_at' field for age calculation.
 * @param days - The number of days to keep completed tasks.
 * @returns The number of deleted rows.
 */
export function deleteCompletedProofTasksOlderThan(days: number): number {
    if (days <= 0) {
        logger.warn('[DB Housekeeping] deleteCompletedProofTasksOlderThan called with non-positive days value. No tasks will be deleted.');
        return 0;
    }
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - days);
    const thresholdDateString = thresholdDate.toISOString();

    const completedStatuses = ['completed_success', 'completed_failed', 'expired', 'error', 'cancelled_by_user'];
    
    // Create a string of placeholders for the IN clause
    const placeholders = completedStatuses.map(() => '?').join(',');

    const sql = `
        DELETE FROM proof_tasks 
        WHERE status IN (${placeholders}) 
        AND created_at < ?
    `;

    try {
        const stmt = db.prepare(sql);
        const result = stmt.run(...completedStatuses, thresholdDateString);
        //logger.debug({ deletedCount: result.changes, cutoff: thresholdDateString }, '[DB Housekeeping] Deleted old completed proof tasks');
        return result.changes;
    } catch (error) {
        logger.error({ error }, '[DB Housekeeping] Error deleting old proof tasks');
        return 0;
    }
} 