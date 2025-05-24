/**
 * API routes for NFTs
 */
import express, { Request, Response, Router } from 'express';
import { asyncHandler } from '../../../shared/utils/express-helpers';
import { marketplaceService } from '../../services/marketplaceService';
import { UserNftService } from '../../services/UserNftService';
import { NftMetadataService } from '../../services/NftMetadataService';
import db from '../../database/db';
import { decryptWallet } from '../../../shared/utils/crypto';
import { ethers } from 'ethers';
import { JsonRpcProvider } from 'ethers';
import { hashTelegramId } from '../../../shared/utils/crypto';
import logger from '../../../shared/utils/logger';

const router: Router = express.Router();

const FORMA_RPC = process.env.FORMA_RPC;
const FORMA_EXPLORER_GRAPHQL_URL = process.env.FORMA_EXPLORER_GRAPHQL_URL;
const MODULARIUM_API_KEY = process.env.MODULARIUM_API_KEY;
const SALT = process.env.SALT;

if (!FORMA_RPC) {
    logger.error('[API nfts.ts] FORMA_RPC is not defined in .env. Service will fail.');
    throw new Error('Server configuration error: FORMA_RPC is missing.');
}
if (!FORMA_EXPLORER_GRAPHQL_URL) {
    logger.error('[API nfts.ts] FORMA_EXPLORER_GRAPHQL_URL is not defined in .env. Service will fail.');
    throw new Error('Server configuration error: FORMA_EXPLORER_GRAPHQL_URL is missing.');
}
// MODULARIUM_API_KEY is often optional, so we might just warn or use a fallback if appropriate.
// For now, let's assume it could be optional or handled by the service if undefined.
// If it were critical, we would add: 
// if (!MODULARIUM_API_KEY) {
//     logger.warn('[API nfts.ts] MODULARIUM_API_KEY is not defined in .env. Service may fail if new collections are fetched.');
//     // throw new Error('Server configuration error: MODULARIUM_API_KEY is missing.');
// }

if (!SALT) {
    logger.error('[API nfts.ts] SALT is not defined in .env. Service will fail.');
    throw new Error('Server configuration error: SALT is missing.');
}

// Initialize services FIRST, so they are available to all routes below
// Ensure FORMA_RPC is valid before passing.
const formaProvider = new JsonRpcProvider(FORMA_RPC); 
const nftMetadataService = new NftMetadataService(formaProvider, FORMA_EXPLORER_GRAPHQL_URL, MODULARIUM_API_KEY || '', FORMA_RPC);
const userNftService = new UserNftService(nftMetadataService, formaProvider, marketplaceService);

// Specific routes should come BEFORE more generic routes

// Route for /owned-by-user/:telegramId
router.get('/owned-by-user/:telegramId', async (req: Request, res: Response) => {
    const { telegramId } = req.params;
    const network = (req.query.network as string) || 'forma';
    const modulariumOnly = req.query.modulariumOnly === 'true'; // Parse boolean from query string

    //console.log(`[API /owned-by-user] Received request for telegramId: ${telegramId}, network: ${network}, modulariumOnly: ${modulariumOnly}`);

    if (!telegramId) {
        logger.warn('[API /owned-by-user] Missing telegramId');
        return res.status(400).json({ success: false, error: 'Telegram ID is required.' });
    }
    if (!SALT) { 
        logger.error('[API /owned-by-user] SALT is not available. This should have been caught at startup.');
        return res.status(500).json({ success: false, error: 'Server configuration error.' });
    }

    try {
        //console.log(`[API /owned-by-user] Original telegramId: ${telegramId}`);
        // Use the project's standard hashing function for consistency
        const hashedTelegramId = hashTelegramId(telegramId); 
        //console.log(`[API /owned-by-user] Looking up wallet for hashedTelegramId (using hashTelegramId): ${hashedTelegramId}`);
        const walletRecord = db.prepare('SELECT wallet_encrypted, proofed FROM wallets WHERE telegram_id_hash = ?').get(hashedTelegramId) as { wallet_encrypted: string; proofed: number } | undefined;

        if (!walletRecord) {
            logger.warn({ telegramId, hashedTelegramId }, `[API /owned-by-user] No walletRecord found for telegramId ${telegramId} (hashed: ${hashedTelegramId})`);
            return res.status(404).json({ success: false, error: 'User not found or wallet not linked.' });
        }
        //console.log(`[API /owned-by-user] Found walletRecord for telegramId ${telegramId}:`, walletRecord);

        if (walletRecord.proofed !== 1) {
            logger.warn({ telegramId, proofedStatus: walletRecord.proofed }, `[API /owned-by-user] Wallet not proofed for telegramId ${telegramId}. Proofed status: ${walletRecord.proofed}`);
            return res.status(403).json({ success: false, error: 'Wallet not proofed.', nfts: [] });
        }
        //console.log(`[API /owned-by-user] Wallet is proofed for telegramId ${telegramId}. Decrypting wallet...`);

        const walletAddress = decryptWallet(walletRecord.wallet_encrypted); 
        //console.log(`[API /owned-by-user] Decrypted walletAddress for telegramId ${telegramId}: ${walletAddress}`);

        if (!ethers.isAddress(walletAddress)) {
            logger.error({ walletAddress, telegramId }, `[API /owned-by-user] Decrypted address '${walletAddress}' is invalid for telegramId ${telegramId}`);
            return res.status(500).json({ success: false, error: 'Failed to retrieve valid wallet address.'});
        }
        //console.log(`[API /owned-by-user] Wallet address ${walletAddress} is valid. Fetching NFTs from UserNftService...`);

        const nfts = await userNftService.getNftsForWallet(walletAddress, network, 1, 200, modulariumOnly); // Defaulting to page 1, limit 200 for now
        //console.log(`[API /owned-by-user] NFTs received from UserNftService for wallet ${walletAddress} (telegramId ${telegramId}):`, nfts);
        
        return res.json({ success: true, nfts });

    } catch (error) {
        logger.error({ err: error, telegramId }, `[API /owned-by-user] Full error object for telegramId ${telegramId}:`);
        let errorMessage = 'Internal server error while fetching NFTs.';
        if (error instanceof Error) {
            errorMessage = error.message; 
        }
        logger.error({ telegramId, errorMessage, fullError: error instanceof Error ? error.stack : JSON.stringify(error) }, `[API /owned-by-user] Catch block: Error message for telegramId ${telegramId}: ${errorMessage}`);
        return res.status(500).json({ success: false, error: errorMessage, fullError: error instanceof Error ? error.stack : JSON.stringify(error) });
    }
});

/**
 * @route GET /api/v1/nfts/user/:walletAddress
 * @description Get all NFTs owned by a wallet address
 * @access Public
 */
router.get('/user/:walletAddress', asyncHandler(async (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const collectionAddress = req.query.collection as string;
  
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  
  try {
    const nfts = await marketplaceService.getUserNfts(
      walletAddress, 
      page,
      limit,
      collectionAddress
    );
    
    res.json(nfts);
  } catch (error) {
    logger.error({ err: error, walletAddress }, `[API] Error fetching NFTs for wallet ${walletAddress}:`);
    res.status(500).json({ error: 'Failed to fetch NFTs' });
  }
}));

/**
 * @route GET /api/v1/nfts/:collectionAddress/:tokenId
 * @description Get details for a specific NFT
 * @access Public
 */
router.get('/:collectionAddress/:tokenId', asyncHandler(async (req: Request, res: Response) => {
  const { collectionAddress, tokenId } = req.params;
  
  if (!collectionAddress || !/^0x[a-fA-F0-9]{40}$/.test(collectionAddress)) {
    return res.status(400).json({ error: 'Invalid collection address' });
  }
  
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'Invalid token ID' });
  }
  
  try {
    res.status(501).json({ 
      message: 'NFT details endpoint will be implemented in future phases', 
      collectionAddress, 
      tokenId 
    });
    
  } catch (error) {
    logger.error({ err: error, collectionAddress, tokenId }, `[API] Error fetching NFT details for ${collectionAddress}/${tokenId}:`);
    res.status(500).json({ error: 'Failed to fetch NFT details' });
  }
}));

export default router; 