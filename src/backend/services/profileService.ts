import * as db from '../database/db';
import { marketplaceService } from './marketplaceService';
import logger from '../../shared/utils/logger';

export interface UserProfile {
    telegramId: string;
    wallet: string;
    proofed: boolean;
    lastTerminalActivityAt: string | null;
    
    // NFT details
    nftCount: number;
    featuredNft?: {
        tokenId: string;
        collectionAddress: string;
        imageUrl: string | null;
        name: string | null;
    } | null;
}

class ProfileService {
    /**
     * Get user profile with NFT details
     */
    async getUserProfile(telegramId: string): Promise<UserProfile | null> {
        // Get wallet data
        const walletData = db.getWallet(telegramId);
        if (!walletData || !walletData.wallet) return null;

        // Get NFT count from marketplace service
        let totalNftCount = 0;
        try {
            // Fetch with pagination to get total count
            const userNfts = await marketplaceService.getUserNfts(walletData.wallet, 1, 1); 
            totalNftCount = userNfts.totalItems || 0;
            logger.debug({ wallet: walletData.wallet, count: totalNftCount }, "[ProfileService] Fetched NFT count.");
        } catch (error) {
            logger.error({ err: error, wallet: walletData.wallet }, `[ProfileService] Error getting NFT count for wallet`);
        }

        // Get featured NFT if any
        let featuredNft = null;
        if (totalNftCount > 0) {
            try {
                const nfts = await marketplaceService.getUserNfts(walletData.wallet, 1, 1);
                if (nfts.items && nfts.items.length > 0) {
                    const firstNft = nfts.items[0];
                    featuredNft = {
                        tokenId: firstNft.tokenId,
                        collectionAddress: firstNft.contractAddress,
                        imageUrl: firstNft.imageUrl,
                        name: firstNft.name
                    };
                    logger.debug({ wallet: walletData.wallet, featuredNftId: firstNft.tokenId }, "[ProfileService] Fetched featured NFT.");
                }
            } catch (error) {
                logger.error({ err: error, wallet: walletData.wallet }, `[ProfileService] Error getting featured NFT for wallet`);
            }
        }

        return {
            telegramId,
            wallet: walletData.wallet,
            proofed: walletData.proofed,
            lastTerminalActivityAt: walletData.lastTerminalActivityAt || null,
            nftCount: totalNftCount,
            featuredNft
        };
    }

    /**
     * Update last terminal activity time
     */
    public async updateLastTerminalActivity(telegramId: string): Promise<boolean> {
        return !!db.updateLastTerminalActivity(telegramId);
    }
}

export const profileService = new ProfileService(); 