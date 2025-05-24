import * as db from '../database/db';
import { alertService, AlertSubscription, AlertType } from './alertService';
import { marketplaceService } from './marketplaceService'; // Assuming it exists and has a method to get collection market data
import { ModulariumCollectionMarketState } from '../database/db'; // Import the interface
import { checkNFTOwnership } from './nftChecker'; // Added for NFT ownership check
import { ALERT_PROCESSOR_POLLING_INTERVAL_MS, ALERT_PROCESSOR_NOTIFICATION_COOLDOWN_MS } from '../../shared/utils/constants';
import logger from '../../shared/utils/logger'; // Import logger

const POLLING_INTERVAL_MS = ALERT_PROCESSOR_POLLING_INTERVAL_MS;
const NOTIFICATION_COOLDOWN_MS = ALERT_PROCESSOR_NOTIFICATION_COOLDOWN_MS;

class AlertProcessorService {
    private isProcessing: boolean = false;
    private intervalId?: NodeJS.Timeout;

    constructor() {
        logger.info("[AlertProcessorService] Initialized."); // INFO: Service initialized
    }

    public startProcessing(): void {
        if (this.isProcessing) {
            logger.info("[AlertProcessorService] Processing is already running.");
            return;
        }
        logger.info("[AlertProcessorService] Starting alert processing cycle."); // INFO: Cycle started
        this.isProcessing = true;
        this.processAlerts().catch(err => logger.error({ err }, "[AlertProcessorService] Error during initial processAlerts run:"));
        this.intervalId = setInterval(() => {
            this.processAlerts().catch(err => logger.error({ err }, "[AlertProcessorService] Error during scheduled processAlerts run:"));
        }, POLLING_INTERVAL_MS);
    }

    public stopProcessing(): void {
        if (!this.isProcessing) {
            logger.info("[AlertProcessorService] Processing is not running.");
            return;
        }
        logger.info("[AlertProcessorService] Stopping alert processing cycle."); // INFO: Cycle stopped
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        this.isProcessing = false;
    }

    private async processAlerts(): Promise<void> {
        logger.debug("[AlertProcessorService] Starting a new alert processing iteration.");
        const activeSubscriptions = db.getAllActiveAlertSubscriptions();
        if (!activeSubscriptions || activeSubscriptions.length === 0) {
            logger.debug("[AlertProcessorService] No active alert subscriptions to process.");
            return;
        }

        // Group subscriptions by collection_address
        const subsByCollection: Record<string, AlertSubscription[]> = {};
        for (const sub of activeSubscriptions) {
            // Ensure the alert_type from DB (string) is cast to our AlertType enum
            const typedSub = { ...sub, alert_type: sub.alert_type as AlertType };
            if (!subsByCollection[typedSub.collection_address]) {
                subsByCollection[typedSub.collection_address] = [];
            }
            subsByCollection[typedSub.collection_address].push(typedSub);
        }

        // New log for checking grouped keys
        const groupedKeys = Object.keys(subsByCollection);
        logger.debug({ collectionCount: groupedKeys.length, collections: groupedKeys }, `[AlertProcessorService] Grouped subscription keys.`);

        for (const collectionAddress in subsByCollection) {
            logger.debug({ collectionAddress }, `[AlertProcessorService] ----- Processing collection address -----`);
            const collectionSubscriptions = subsByCollection[collectionAddress];

            try {
                // 1. Fetch current market data for the collection
                logger.debug({ collectionAddress }, `[AlertProcessorService] Calling marketplaceService.getCollectionDetails`);
                const collectionDetails = await marketplaceService.getCollectionDetails(collectionAddress);
                
                // Enhanced logging for collectionDetails
                if (collectionDetails) {
                    logger.debug({ collectionAddress, details: collectionDetails }, `[AlertProcessorService] Received collectionDetails`);
                } else {
                    logger.warn({ collectionAddress }, `[AlertProcessorService] Received NULL collectionDetails from marketplaceService.`); // WARN: Potentially an issue with marketplace data
                }

                if (!collectionDetails || typeof collectionDetails.floorPrice !== 'number') { 
                    logger.warn({ collectionAddress, details: collectionDetails, floorPrice: collectionDetails?.floorPrice }, `[AlertProcessorService] SKIPPING collection due to invalid/missing collectionDetails or non-numeric floorPrice.`);
                    continue;
                }
                const currentFloorPrice = collectionDetails.floorPrice;
                const currentBestOffer = collectionDetails.bestOffer; // This can be null or a number
                const collectionName = collectionDetails.name; // Get collection name for notifications
                
                // 2. Get or create market state for this collection from DB
                let collectionState = db.getModulariumCollectionMarketStateByAddress(collectionAddress);
                const nowISO = new Date().toISOString();

                if (!collectionState) {
                    db.upsertModulariumCollectionMarketState({
                        collection_address: collectionAddress,
                        last_known_floor_price: currentFloorPrice,
                        last_known_offer_price: typeof currentBestOffer === 'number' ? currentBestOffer : null,
                        data_updated_at: nowISO,
                        last_floor_price_processed_at: null, // Not processed yet for notifications
                        last_offer_price_processed_at: null,
                    });
                    // Re-fetch after creation for consistency, though upsert might return it or handle this.
                    collectionState = db.getModulariumCollectionMarketStateByAddress(collectionAddress);
                    if (!collectionState) {
                        logger.error({ collectionAddress }, `[AlertProcessorService] Failed to create/fetch market state after upsert`);
                        continue;
                    }
                    logger.info({ collectionAddress, currentFloorPrice, currentBestOffer }, `[AlertProcessorService] Initial market state created`); // INFO: New collection tracked
                } else {
                    // Update existing state with latest prices from marketplace
                    db.upsertModulariumCollectionMarketState({
                        collection_address: collectionAddress,
                        last_known_floor_price: currentFloorPrice,
                        last_known_offer_price: typeof currentBestOffer === 'number' ? currentBestOffer : null,
                        data_updated_at: nowISO,
                        // Do not update *_processed_at timestamps here, only when notifications are processed
                    });
                    logger.debug({ collectionAddress, newFloor: currentFloorPrice, oldFloor: collectionState.last_known_floor_price, newBestOffer: currentBestOffer }, `[AlertProcessorService] Market state updated with latest prices`);
                }

                // 3. Process Floor Price Change Alerts
                const lastProcessedFloorAt = collectionState.last_floor_price_processed_at ? new Date(collectionState.last_floor_price_processed_at).getTime() : 0;
                const lastKnownFloorPrice = collectionState.last_known_floor_price;

                if (currentFloorPrice !== lastKnownFloorPrice || !collectionState.last_floor_price_processed_at) { // Price changed OR never processed
                    logger.debug({ collectionAddress, currentFloorPrice, lastKnownFloorPrice, neverProcessed: !collectionState.last_floor_price_processed_at }, `[AlertProcessorService] Potential floor price change detected.`); // DEBUG: Detailed check
                    let notifiedAnyUserForThisFloorChange = false;
                    for (const sub of collectionSubscriptions) {
                        if (sub.alert_type === AlertType.FLOOR_CHANGE) {
                            // NFT Ownership Check STARTS
                            const walletData = db.getWallet(sub.raw_telegram_id);
                            if (!walletData || !walletData.wallet) {
                                logger.warn({ rawTelegramId: sub.raw_telegram_id, subscriptionId: sub.id, alertType: 'floor_change' }, `[AlertProcessorService] No wallet found for subscription. Skipping alert.`);
                                continue; 
                            }

                            const usersWalletAddress = walletData.wallet;
                            
                            const hasRequiredNft = await checkNFTOwnership(usersWalletAddress);
                            if (!hasRequiredNft) {
                                logger.info({ rawTelegramId: sub.raw_telegram_id, walletAddress: usersWalletAddress, subscriptionId: sub.id, alertType: 'floor_change' }, `[AlertProcessorService] User no longer owns required NFT. Deactivating subscription.`); // INFO: Subscription deactivated
                                db.updateAlertSubscriptionActiveStatus(sub.id, false); // Ensure this function exists in db.ts
                                continue; 
                            }
                            // NFT Ownership Check ENDS

                            const userLastNotifiedFloorAt = sub.last_floor_notified_at ? new Date(sub.last_floor_notified_at).getTime() : 0;
                            if (Date.now() - userLastNotifiedFloorAt > NOTIFICATION_COOLDOWN_MS) {
                                // Check threshold if implemented for this alert type and sub
                                // For now, any change triggers notification if cooldown passed.
                                let priceChangeIndicator = "";
                                if (typeof lastKnownFloorPrice === 'number') { // Check if lastKnownFloorPrice is a number
                                    if (currentFloorPrice > lastKnownFloorPrice) {
                                        priceChangeIndicator = "⬆️ "; 
                                    } else if (currentFloorPrice < lastKnownFloorPrice) {
                                        priceChangeIndicator = "⬇️ ";
                                    }
                                } else if (typeof currentFloorPrice === 'number' && lastKnownFloorPrice === null) {
                                    // Floor price appeared (was null, now has a value) - consider this as up
                                    priceChangeIndicator = "⬆️ ";
                                }

                                const message = `🔔 ${priceChangeIndicator}Floor Price Alert! 🔔\nCollection: ${collectionName || collectionAddress}\nNew Floor Price: ${currentFloorPrice} TIA`;
                                await alertService.sendNotification(sub.raw_telegram_id, message, { parse_mode: 'Markdown' });
                                db.updateUserSubscriptionLastNotifiedAt(sub.id, AlertType.FLOOR_CHANGE, nowISO);
                                notifiedAnyUserForThisFloorChange = true;
                                logger.info({ rawTelegramId: sub.raw_telegram_id, collectionAddress, alertType: 'floor_change' }, `[AlertProcessorService] Sent alert`);
                            } else {
                                logger.debug({ rawTelegramId: sub.raw_telegram_id, collectionAddress, alertType: 'floor_change' }, `[AlertProcessorService] Floor_change alert skipped due to user cooldown.`);
                            }
                        }
                    }
                    // If at least one user was (or could have been) notified for this specific floor price occurrence,
                    // update the collection's last_floor_price_processed_at timestamp.
                    if (notifiedAnyUserForThisFloorChange || !collectionState.last_floor_price_processed_at) { // also update if it was never processed
                        db.upsertModulariumCollectionMarketState({
                            collection_address: collectionAddress,
                            last_floor_price_processed_at: nowISO
                        });
                        logger.debug({ collectionAddress, processedAt: nowISO }, `[AlertProcessorService] Updated last_floor_price_processed_at`);
                    }
                } else {
                     logger.debug({ collectionAddress, currentFloorPrice }, `[AlertProcessorService] No floor price change or already processed.`);
                }

                // Process Offer Price Change Alerts
                const lastKnownOfferPrice = collectionState.last_known_offer_price;
                // Ensure currentBestOffer is a number to compare, or if it just became a number from null
                const isValidCurrentBestOffer = typeof currentBestOffer === 'number';

                if (isValidCurrentBestOffer && (currentBestOffer !== lastKnownOfferPrice || !collectionState.last_offer_price_processed_at)) {
                    logger.debug({ collectionAddress, currentBestOffer, lastKnownOfferPrice, neverProcessed: !collectionState.last_offer_price_processed_at }, `[AlertProcessorService] Potential offer price change detected.`); // DEBUG: Detailed check
                    let notifiedAnyUserForThisOfferChange = false;
                    for (const sub of collectionSubscriptions) {
                        if (sub.alert_type === AlertType.OFFER_CHANGE) {
                            // NFT Ownership Check STARTS
                            const walletDataOffer = db.getWallet(sub.raw_telegram_id);
                            if (!walletDataOffer || !walletDataOffer.wallet) {
                                logger.warn({ rawTelegramId: sub.raw_telegram_id, subscriptionId: sub.id, alertType: 'offer_change' }, `[AlertProcessorService] No wallet found for subscription. Skipping alert.`);
                                continue;
                            }

                            const usersWalletAddressOffer = walletDataOffer.wallet;

                            const hasRequiredNftOffer = await checkNFTOwnership(usersWalletAddressOffer);
                            if (!hasRequiredNftOffer) {
                                logger.info({ rawTelegramId: sub.raw_telegram_id, walletAddress: usersWalletAddressOffer, subscriptionId: sub.id, alertType: 'offer_change' }, `[AlertProcessorService] User no longer owns required NFT. Deactivating subscription.`); // INFO: Subscription deactivated
                                db.updateAlertSubscriptionActiveStatus(sub.id, false); // Ensure this function exists in db.ts
                                continue;
                            }
                            // NFT Ownership Check ENDS
                            
                            const userLastNotifiedOfferAt = sub.last_offer_notified_at ? new Date(sub.last_offer_notified_at).getTime() : 0;
                            if (Date.now() - userLastNotifiedOfferAt > NOTIFICATION_COOLDOWN_MS) {
                                let offerChangeIndicator = "";
                                if (typeof currentBestOffer === 'number' && typeof lastKnownOfferPrice === 'number') {
                                    if (currentBestOffer > lastKnownOfferPrice) {
                                        offerChangeIndicator = "⬆️ ";
                                    } else if (currentBestOffer < lastKnownOfferPrice) {
                                        offerChangeIndicator = "⬇️ ";
                                    }
                                } else if (typeof currentBestOffer === 'number' && lastKnownOfferPrice === null) {
                                    // Offer appeared (was null, now has a value)
                                    offerChangeIndicator = "⬆️ "; // Or some other indicator for new offer
                                }
                                // If currentBestOffer is null and lastKnownOfferPrice was a number, it means offer disappeared.
                                // Could add a ⬇️ or specific message, but current logic only triggers if isValidCurrentBestOffer is true.

                                const message = `📈 ${offerChangeIndicator}Offer Price Alert! 📈\nCollection: ${collectionName || collectionAddress}\nNew Best Offer: ${currentBestOffer} TIA`;
                                await alertService.sendNotification(sub.raw_telegram_id, message, { parse_mode: 'Markdown' });
                                db.updateUserSubscriptionLastNotifiedAt(sub.id, AlertType.OFFER_CHANGE, nowISO);
                                notifiedAnyUserForThisOfferChange = true;
                                logger.info({ rawTelegramId: sub.raw_telegram_id, collectionAddress, alertType: 'offer_change' }, `[AlertProcessorService] Sent alert`);
                            } else {
                                logger.debug({ rawTelegramId: sub.raw_telegram_id, collectionAddress, alertType: 'offer_change' }, `[AlertProcessorService] Offer_change alert skipped due to user cooldown.`);
                            }
                        }
                    }
                    if (notifiedAnyUserForThisOfferChange || !collectionState.last_offer_price_processed_at) {
                        db.upsertModulariumCollectionMarketState({
                            collection_address: collectionAddress,
                            last_offer_price_processed_at: nowISO
                        });
                        logger.debug({ collectionAddress, processedAt: nowISO }, `[AlertProcessorService] Updated last_offer_price_processed_at`);
                    }
                } else if (isValidCurrentBestOffer) {
                    logger.debug({ collectionAddress, currentBestOffer }, `[AlertProcessorService] No offer price change or already processed.`);
                }

            } catch (error) {
                logger.error({ err: error, collectionAddress }, `[AlertProcessorService] Error processing collection`);
            }
        }
        logger.debug("[AlertProcessorService] Finished alert processing iteration.");
    }
}

export const alertProcessorService = new AlertProcessorService();

// To start the service (e.g., in your main application file):
// alertProcessorService.startProcessing();
 