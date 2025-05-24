import express, { Request, Response } from 'express';
import { asyncHandler } from '../../../shared/utils/express-helpers';
import * as db from '../../database/db';
import { marketplaceService } from '../../services/marketplaceService';
import { profileService } from '../../services/profileService';
import { hashTelegramId } from '../../../shared/utils/crypto';
import { alertService, AlertType } from '../../services/alertService';
import logger from '../../../shared/utils/logger';
import { ADMIN_IDS } from '../../../shared/utils/constants';

const router = express.Router();

/**
 * GET /api/v1/users/:telegramId/nfts
 * Retrieves a list of NFTs owned by the specified user
 */
router.get('/:telegramId/nfts', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const collectionAddress = req.query.collection as string;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'Missing telegramId' });
  }
  
  // Get wallet from database
  const walletData = db.getWallet(telegramId);
  
  if (!walletData || !walletData.wallet) {
    return res.status(404).json({ error: 'Wallet not found for this user' });
  }
  
  if (!walletData.proofed) {
    return res.status(403).json({ error: 'Wallet ownership not verified' });
  }
  
  try {
    // Get NFTs using marketplaceService
    const nfts = await marketplaceService.getUserNfts(
      walletData.wallet, 
      page,
      limit,
      collectionAddress
    );
    
    res.json(nfts);
  } catch (error) {
    logger.error({ err: error, telegramId }, `[API] Error fetching NFTs for user ${telegramId}:`);
    res.status(500).json({ error: 'Failed to fetch NFTs' });
  }
}));

/**
 * GET /api/v1/users/:telegramId/profile
 * Retrieves profile information for the user
 */
router.get('/:telegramId/profile', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'Missing telegramId' });
  }
  
  try {
    const profile = await profileService.getUserProfile(telegramId);
    
    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    
    res.json(profile);
  } catch (error) {
    logger.error({ err: error, telegramId }, `[API] Error fetching profile for user ${telegramId}:`);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
}));

/**
 * POST /api/v1/users/:telegramId/activity/terminal-visit
 * Logs a terminal visit for the user
 */
router.post('/:telegramId/activity/terminal-visit', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'Missing telegramId' });
  }
  
  try {
    const success = profileService.updateLastTerminalActivity(telegramId);
    
    if (!success) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error, telegramId }, `[API] Error updating terminal activity for user ${telegramId}:`);
    res.status(500).json({ error: 'Failed to update terminal activity' });
  }
}));

/**
 * POST /api/v1/users/:telegramId/alerts/subscriptions
 * Creates a new alert subscription for a user
 */
router.post('/:telegramId/alerts/subscriptions', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
    const { collectionAddress, type: alertType, thresholdValue } = req.body;

    //console.log(`[USER_ROUTER POST /alerts/subscriptions] Received for telegramId ${telegramId}. Body: `, req.body);
    //console.log(`[USER_ROUTER POST /alerts/subscriptions] Raw alertType from body: '${alertType}', typeof: ${typeof alertType}`); // DEBUG

  if (!telegramId) {
        return res.status(400).json({ error: 'V_ERR_MISSING_TELEGRAM_ID' });
  }
    if (!collectionAddress || typeof collectionAddress !== 'string' || collectionAddress.length === 0) {
        return res.status(400).json({ error: 'V_ERR_MISSING_COLLECTION_ADDRESS' });
    }
    
    const baseAddressPart = collectionAddress.split('/instance/')[0];
    if (!/^0x[a-fA-F0-9]{40}$/.test(baseAddressPart)) {
        return res.status(400).json({ error: 'V_ERR_INVALID_BASE_PART_FORMAT' });
    }

    if (collectionAddress.includes('/instance/')) {
        const instanceParts = collectionAddress.split('/instance/');
        if (instanceParts.length < 2 || !instanceParts[1] || instanceParts[1].length === 0) {
            return res.status(400).json({ error: 'V_ERR_MALFORMED_INSTANCE_PATH' });
        }
        const instanceId = instanceParts[1];
        if (!/^[a-zA-Z0-9_]+$/.test(instanceId)) { 
            return res.status(400).json({ error: 'V_ERR_INVALID_INSTANCE_ID_CHARS' });
        }
    }

    const validAlertTypes = Object.values(AlertType);
    //console.log(`[USER_ROUTER POST /alerts/subscriptions] Valid AlertTypes from enum:`, validAlertTypes); // DEBUG
    //console.log(`[USER_ROUTER POST /alerts/subscriptions] Checking if validAlertTypes includes '${alertType}':`, validAlertTypes.includes(alertType as AlertType)); // DEBUG

    if (!alertType || !validAlertTypes.includes(alertType as AlertType)) {
        logger.error({ alertType, telegramId }, `[USER_ROUTER POST /alerts/subscriptions] Validation FAILED for alertType: '${alertType}'`); // DEBUG
        return res.status(400).json({ error: 'V_ERR_INVALID_ALERT_TYPE' });
    }

    //console.log(`[USER_ROUTER POST /alerts/subscriptions] alertType '${alertType}' PASSED validation.`); // DEBUG

    // Ensure user and wallet are valid and proofed before allowing subscription creation
    const walletData = db.getWallet(telegramId.toString());
    if (!walletData || !walletData.wallet || !walletData.proofed) {
        return res.status(403).json({ error: 'User not found, wallet not linked, or ownership not verified.' });
  }

    // Using alertService to create subscription, which internally uses db.createAlertSubscription
    const subscription = await alertService.createSubscription(
        telegramId.toString(),
      collectionAddress,
        alertType as AlertType, // Cast to ensure type safety
        thresholdValue
    );

    if (!subscription) {
        // alertService.createSubscription now returns the full subscription object or null
        return res.status(500).json({ error: 'Failed to create alert subscription (service layer).' });
    }

    // The API plan expects a specific response structure for success
    res.status(201).json({
        message: "Subscription created successfully.",
      subscription: {
            id: subscription.id.toString(), // Ensure ID is string
            type: subscription.alert_type,
            collectionAddress: subscription.collection_address,
            thresholdValue: subscription.threshold_value
        }
    });
}));

/**
 * GET /api/v1/users/:telegramId/alerts/subscriptions
 * Retrieves all active alert subscriptions for a user
 */
router.get('/:telegramId/alerts/subscriptions', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;

  if (!telegramId) {
    return res.status(400).json({ error: 'Missing telegramId' });
  }

  // Optional: Check if user exists, though getAlertSubscriptions will just return empty if no hash match
  // const walletData = db.getWallet(telegramId);
  // if (!walletData) {
  //   return res.status(404).json({ error: 'User not found.' });
  // }

  try {
    const subscriptions = db.getAlertSubscriptions(telegramId);
    
    // The plan specifies collectionName as optional, and db.getAlertSubscriptions doesn't return it directly.
    // We will map to ensure the API response matches the documented structure closely for other fields.
    const responseSubscriptions = subscriptions.map(sub => ({
      id: sub.id.toString(), // Ensure ID is string
      type: sub.alert_type,
      collectionAddress: sub.collection_address,
      collectionName: null, // Placeholder for optional enrichment
      thresholdValue: sub.threshold_value,
      createdAt: sub.created_at
    }));

    res.status(200).json({ subscriptions: responseSubscriptions });
  } catch (error) {
    logger.error({ err: error, telegramId }, `[API] Error retrieving alert subscriptions for user ${telegramId}:`);
    res.status(500).json({ error: 'Failed to retrieve alert subscriptions.' });
  }
}));

/**
 * DELETE /api/v1/users/:telegramId/alerts/subscriptions/all
 * Deletes ALL alert subscriptions for a user.
 */
router.delete('/:telegramId/alerts/subscriptions/all', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  logger.debug({ params: req.params, telegramId }, `[API DELETE /users/.../alerts/subscriptions/all] Received request.`); // DEBUG

  if (!telegramId) {
    logger.warn('[API DELETE ALL] Validation failed: Missing telegramId in params.'); // DEBUG
    return res.status(400).json({ error: 'Missing telegramId', success: false });
  }

  try {
    const telegramIdHashed = hashTelegramId(telegramId.toString());
    const dbSuccess = db.deleteAlertSubscriptionsByTelegramIdHash(telegramIdHashed);

    if (dbSuccess) {
      // Even if no rows were deleted (user had no subscriptions), the operation is considered successful.
      res.status(200).json({ message: 'All alert subscriptions deleted successfully (or none existed).', success: true });
    } else {
      // This implies a database error occurred during the delete operation.
      res.status(500).json({ error: 'Failed to delete all alert subscriptions due to a database error.', success: false });
    }
  } catch (error) {
    // This catch block might be redundant if deleteAllAlertSubscriptionsForUser handles its own errors and returns false,
    // but it's good for unexpected issues.
    logger.error({ err: error, telegramId }, `[API DELETE ALL] Error during deletion of all subscriptions for TG_ID ${telegramId}:`);
    res.status(500).json({ error: 'An unexpected error occurred while deleting all alert subscriptions.', success: false });
  }
}));

/**
 * DELETE /api/v1/users/:telegramId/alerts/subscriptions/:subscriptionId
 * Deletes a specific alert subscription
 */
router.delete('/:telegramId/alerts/subscriptions/:subscriptionId', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId, subscriptionId: subIdString } = req.params;

  if (!telegramId || !subIdString) {
    return res.status(400).json({ error: 'Missing telegramId or subscriptionId', success: false });
  }

  const subscriptionId = parseInt(subIdString, 10);
  if (isNaN(subscriptionId)) {
    return res.status(400).json({ error: 'Invalid subscriptionId format. Must be a number.', success: false });
  }

  try {
    const success = db.deleteAlertSubscription(telegramId, subscriptionId);

    if (success) {
      res.status(200).json({ message: 'Subscription deleted successfully.', success: true });
    } else {
      res.status(404).json({ error: 'Subscription not found or not owned by user.', success: false });
    }
  } catch (error) {
    logger.error({ err: error, telegramId, subscriptionId }, `[API DELETE] Error during subscription deletion process for TG_ID ${telegramId}, Sub_ID ${subscriptionId}:`);
    res.status(500).json({ error: 'Failed to delete alert subscription.', success: false });
  }
}));

// Route to check if a telegramId is an admin (for dev mode access)
router.get('/dev/is-admin/:telegramId', asyncHandler(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  // Ensure ADMIN_IDS is treated as a string and split correctly
  const adminTelegramIds = (ADMIN_IDS || '').split(',').map(id => id.trim()).filter(id => id !== '');
  
  if (!telegramId) {
    return res.status(400).json({ success: false, error: 'telegramId is required' });
  }

  const isAdmin = adminTelegramIds.includes(telegramId.toString());
  
  logger.debug({ telegramId: telegramId, adminTelegramIds, isAdmin }, '[API /dev/is-admin] Checked admin status');
  return res.json({ success: true, isAdmin });
}));

export default router; 