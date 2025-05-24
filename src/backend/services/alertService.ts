import * as db from '../database/db'; // Updated path to database module
import { hashTelegramId } from '../../shared/utils/crypto'; // Import hashTelegramId directly
import axios from 'axios'; // Add axios for HTTP requests
import dotenv from 'dotenv'; // To access BOT_TOKEN
import logger from '../../shared/utils/logger'; // Import logger

dotenv.config(); // Ensure .env variables are loaded

// Alert Type enum (or we could move this to a shared types)
export enum AlertType {
  FLOOR_CHANGE = 'floor_change',
  OFFER_CHANGE = 'offer_change',
  NEW_MINT = 'new_mint',
  VOLUME_SPIKE = 'volume_spike'
}

// Alert Subscription interface - aligning more with db.ts for fields used by AlertProcessorService
export interface AlertSubscription {
  id: number;
  telegram_id_hash: string; // As stored in DB and used for linking
  raw_telegram_id: string; // Needed by AlertProcessorService for notifications
  collection_address: string;
  alert_type: AlertType;
  threshold_value?: number | null; // DB stores REAL, so can be null
  is_active: number; // 0 or 1
  last_floor_notified_at?: string | null; // ISO string
  last_offer_notified_at?: string | null; // ISO string
  created_at: string; // ISO string
  updated_at: string; // ISO string
}

// This is a more detailed type for what we might get from the DB, including collection name
// This can be used when returning data to API consumers if enrichment is done.
// For now, AlertProcessorService will likely work with the base AlertSubscription.
export interface AlertSubscriptionDetails extends AlertSubscription {
    collectionName?: string; // To be enriched by marketplaceService if needed
    // We might also want to return the non-hashed telegramId to API consumers
    telegramId?: string; 
}

class AlertService {
  constructor() {
    logger.info("[AlertService] Initialized."); // INFO: Service initialized
  }

  /**
   * Create a new alert subscription
   */
  async createSubscription(
    telegramId: string, // Raw telegram ID from the user
    collectionAddress: string,
    alertType: string,
    thresholdValue?: number
  ): Promise<AlertSubscription | null> { // Returning the DB-like structure for now
    try {
      // Validate alertType
      if (!Object.values(AlertType).includes(alertType as AlertType)) {
        logger.warn({ alertType, telegramId, collectionAddress }, `[AlertService] Invalid alert type for creation: ${alertType}`); // WARN: Invalid input
        return null;
      }

      // Create subscription in DB. db.createAlertSubscription handles hashing telegramId.
      // It expects raw telegramId.
      const subscriptionId = db.createAlertSubscription(
        telegramId,
        collectionAddress.toLowerCase(),
        alertType,
        thresholdValue
      );

      if (subscriptionId) {
        // To return the full AlertSubscription object, we'd ideally fetch it back from the DB
        // For now, let's assume createAlertSubscription was successful and try to get the created one
        // Or, construct a partial representation.
        // For consistency, it's better to fetch it or have db.createAlertSubscription return the created object.
        // Let's try fetching it for now.
        const createdSub = await this.getSubscriptionById(subscriptionId, telegramId);
        if (createdSub) return createdSub;

        // Fallback if getSubscriptionById isn't implemented or fails, construct manually (less ideal)
        logger.warn({ subscriptionId, telegramId, collectionAddress }, `[AlertService] Could not fetch subscription ${subscriptionId} after creation. Returning constructed object.`);
        // This manual construction will lack telegram_id_hash, raw_telegram_id directly unless passed through
        // and other DB-generated fields like timestamps correctly.
        // The db.createAlertSubscription now returns an ID, so we should use that to fetch the full record.
        // The current db.AlertSubscription interface includes fields like telegram_id_hash, raw_telegram_id.
        // The current `db.createAlertSubscription` returns ID. We'd need a `getSubscriptionById` in db.ts.
        // For now, this part of the code may not return a complete AlertSubscription object as defined.
        // Let's adjust the return or the logic.
        // Given the plan, AlertProcessorService will use functions that return full AlertSubscription objects from db.ts.
        // So, this createSubscription might be mostly for API endpoint, which might want a simpler response.
        // Let's stick to what we have and refine if API needs more/less.
        // The current signature returns AlertSubscription | null
        // The db.createAlertSubscription in db.ts takes rawTelegramId, so that's fine.
        
        // Fetching the subscription after creation is a good practice.
        // We'll need a db.getSubscriptionById(id: number) function.
        // Let's assume it exists for now or add it later.
        // For now, to avoid breaking changes with db.ts, let's return a simplified object
        // or rely on `getUserSubscriptions` if we want the full object.
        // The `AlertSubscription` interface here is now more aligned with DB.
        // The `db.createAlertSubscription` returns an ID.
        // We should have a method in db.ts: `getAlertSubscriptionById(id: number): db.AlertSubscription | null`

        const newSub = await db.getAlertSubscriptionById(subscriptionId);
        if (newSub) {
        return {
                ...newSub, // spread the properties from the DB record
                alert_type: newSub.alert_type as AlertType, // Cast alert_type
            };
        }
        logger.error({ subscriptionId, telegramId, collectionAddress }, `[AlertService] Failed to retrieve subscription by ID after creation.`);
        return null;
      }
      logger.warn({ telegramId, collectionAddress, alertType }, "[AlertService] Subscription creation did not return an ID."); // WARN: DB operation issue
      return null;
    } catch (error) {
      logger.error({ err: error, telegramId, collectionAddress, alertType }, `[AlertService] Error creating subscription:`);
      return null;
    }
  }

  /**
   * Get all alert subscriptions for a user.
   * Returns array of AlertSubscription (DB-like structure).
   */
  async getUserSubscriptions(telegramId: string): Promise<AlertSubscription[]> {
    try {
      const subscriptionsFromDb = db.getAlertSubscriptions(telegramId);
      return subscriptionsFromDb.map(sub => ({
        ...sub,
        alert_type: sub.alert_type as AlertType, // Just ensure enum type consistency
      }));
    } catch (error) {
      logger.error({ err: error, telegramId }, `[AlertService] Error getting user subscriptions:`);
      return [];
    }
  }

  /**
   * Get a single subscription by its ID and optionally verify ownership by telegramId.
   * (Helper method, might require adding getAlertSubscriptionById to db.ts)
   */
  async getSubscriptionById(subscriptionId: number, telegramId?: string): Promise<AlertSubscription | null> {
    try {
        const subFromDb = db.getAlertSubscriptionById(subscriptionId); // Assumes db.getAlertSubscriptionById exists
        if (subFromDb) {
            if (telegramId) { // If telegramId is provided, verify ownership
                const expectedHash = hashTelegramId(telegramId); // Use imported hashTelegramId
                if (subFromDb.telegram_id_hash !== expectedHash) {
                    logger.warn({ subscriptionId, telegramIdAttempted: telegramId }, `[AlertService] Attempt to access subscription by unauthorized user.`); // WARN: Security attempt
                    return null;
                }
            }
            return {
                ...subFromDb,
                alert_type: subFromDb.alert_type as AlertType,
            };
        }
        return null;
    } catch (error) {
        logger.error({ err: error, subscriptionId, telegramId }, `[AlertService] Error getting subscription by ID:`);
        return null;
    }
  }

  /**
   * Delete an alert subscription
   */
  async deleteSubscription(telegramId: string, subscriptionId: number): Promise<boolean> {
    try {
      return db.deleteAlertSubscription(telegramId, subscriptionId);
    } catch (error) {
      logger.error({ err: error, telegramId, subscriptionId }, `[AlertService] Error deleting subscription:`);
      return false;
    }
  }
  
  /**
   * Sends a notification message to a user via Telegram using direct API call.
   * @param rawTelegramId - The raw Telegram ID of the user.
   * @param message - The message string to send.
   * @param options - Optional parameters like parse_mode.
   */
  async sendNotification(rawTelegramId: string, message: string, options?: { parse_mode?: string }): Promise<boolean> {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      logger.error('[AlertService] BOT_TOKEN is not defined. Cannot send notification.');
      return false;
    }

    const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const payload: any = {
      chat_id: rawTelegramId,
      text: message,
    };

    if (options?.parse_mode) {
      payload.parse_mode = options.parse_mode;
    }

    // logger.debug({ rawTelegramId, text: message.substring(0, 50) + '...' }, `[AlertService] Attempting to send notification via direct API call.`);

    try {
      const response = await axios.post(apiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000 // 10 seconds timeout
      });
    
      if (response.data.ok) {
        // logger.info({ rawTelegramId, text: message.substring(0, 50) + '...' }, `[AlertService] Notification successfully sent via direct API.`); // Optional INFO
        return true;
    } else {
        logger.warn({ rawTelegramId, responseData: response.data, text: message.substring(0, 50) + '...' }, `[AlertService] Telegram API returned error while sending notification`);
        if (response.data.error_code === 403) { // Forbidden: bot was blocked by the user
            logger.warn({ rawTelegramId }, `[AlertService] Bot may be blocked by user (Error 403).`);
        }
        return false;
      }
    } catch (error: any) {
      logger.error({ err: error, rawTelegramId, isAxiosError: error.isAxiosError, responseData: error.response?.data, responseStatus: error.response?.status, text: message.substring(0, 50) + '...' }, `[AlertService] Error sending message via direct API`);
      return false;
    }
  }
}

export const alertService = new AlertService(); 