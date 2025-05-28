import dotenv from 'dotenv';
dotenv.config({ override: true });

/**
 * Main Express server for Zroop NFT Agent Bot API
 */
import express, { Request, Response, Router, RequestHandler } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import logger from '../shared/utils/logger';

// Import API route handlers
import collectionsRouter from './api/v1/collections';
import nftsRouter from './api/v1/nfts';
import gasRouter from './api/v1/gas';
import usersRouter from './api/v1/users';
//import proofRouter from './api/v1/proof';

// Import services for direct API endpoints
import * as db from './database/db';
import { getActiveProofTaskByTelegramId, ProofTask } from './database/db';
import * as nftChecker from './services/nftChecker';
import { profileService } from './services/profileService';
import { alertService } from './services/alertService';
import { marketplaceService } from './services/marketplaceService';
import { ProofVerificationService } from './services/proofVerificationService';
import { HousekeepingService } from './services/housekeepingService';
import { hashTelegramId, decryptWallet } from '../shared/utils/crypto';
import { alertProcessorService } from './services/AlertProcessorService';
import { AlertType } from './services/alertService';

// Import utility helpers
import { wrapAsync } from '../shared/utils/express-helpers';

const app = express();
const legacyRouter = express.Router();
const port: number = Number(process.env.PORT) || 3000;
const CHECK_WALLET_ADDRESS = process.env.CHECK_WALLET;

// Initialize ProofVerificationService
const proofVerificationService = new ProofVerificationService();

// Initialize HousekeepingService
const housekeepingService = new HousekeepingService();

// Start AlertProcessorService
alertProcessorService.startProcessing();

// === Middleware Configuration ===

// Basic security headers and proxy trust
app.set('trust proxy', 1); // Trust first proxy - adjust if behind multiple proxies
app.use(cors()); // Enable CORS for all origins (consider restricting in production)
app.use(bodyParser.json()); // Parse JSON request bodies

// Apply the same middleware to legacyRouter
legacyRouter.use(cors());
legacyRouter.use(bodyParser.json());

// Request Logger Middleware
app.use((req, res, next) => {
  //logger.debug({ method: req.method, url: req.originalUrl, body: req.body, params: req.params, query: req.query }, `[SERVER Incoming Request]`);
  next();
});

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes'
});

// Apply rate limiting to all requests, except in development
if (process.env.NODE_ENV !== 'development') {
  app.use(limiter);
  logger.info('[SERVER] Rate limiting ENABLED.');
} else {
  logger.info('[SERVER] Rate limiting DISABLED for development environment.');
}

// === New Proof API Router ===
const proofRouter = express.Router();

proofRouter.post('/initiate', wrapAsync(async (req: Request, res: Response) => {
    const { telegramId, wallet } = req.body;
    if (!telegramId || !wallet) {
        return res.status(400).json({ success: false, error: 'Missing telegramId or wallet' });
    }
    const normalizedWallet = wallet.toString().trim().toLowerCase();
    if (!isValidEvmAddress(normalizedWallet)) {
        return res.status(400).json({ success: false, error: 'Invalid EVM wallet address' });
    }

    if (!CHECK_WALLET_ADDRESS) {
        logger.error('[API /proof/initiate] CHECK_WALLET_ADDRESS is not configured!');
        return res.status(500).json({ success: false, error: 'Server configuration error for proof verification.' });
    }

    try {
        // Delete any old, non-finalized tasks for this user to prevent duplicates
        // AND clear any existing wallet link to ensure /status reflects the current attempt accurately.
        const unlinked = db.unlinkWallet(telegramId.toString());
        logger.debug({ telegramId, unlinked }, `[API /proof/initiate] Unlink existing wallet result`);
        db.deleteNonFinalizedProofTasksByTelegramId(telegramId.toString());

        const taskUid = uuidv4();
        const afterTimestamp = Math.floor(Date.now() / 1000);
        const checkDeadlineUtc = afterTimestamp + (15 * 60); // 15 minutes deadline

        db.createProofTask(taskUid, telegramId.toString(), normalizedWallet, afterTimestamp, checkDeadlineUtc);
        logger.debug({ taskUid, telegramId, normalizedWallet }, `[API /proof/initiate] Created proof task`);
        
        res.json({ 
            success: true, 
            taskUid,
            deadlineUtc: checkDeadlineUtc,
            checkWallet: CHECK_WALLET_ADDRESS // Send the wallet to check against to the bot
        });
    } catch (error) {
        logger.error({ err: error, telegramId }, `[API /proof/initiate] Error creating proof task`);
        res.status(500).json({ success: false, error: 'Failed to initiate proof task' });
    }
}));

proofRouter.get('/status/:taskUid', wrapAsync(async (req: Request, res: Response) => {
    const { taskUid } = req.params;
    if (!taskUid) {
        return res.status(400).json({ success: false, error: 'Missing taskUid' });
    }
    try {
        const task = db.getProofTaskByUid(taskUid);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Proof task not found' });
        }

        let responsePayload: any = { status: task.status };
        if (task.status === 'completed_success') {
            const walletInfo = db.getWallet(task.telegram_id); 
            let decryptedWalletAddress: string | null = null;
            if (task.wallet_address_encrypted) {
                decryptedWalletAddress = decryptWallet(task.wallet_address_encrypted);
                if (!decryptedWalletAddress) {
                    logger.error({ taskUid: task.task_uid }, `[API /proof/status/:taskUid] Failed to decrypt wallet_address_encrypted`);
                }
            }
            responsePayload.walletAddress = decryptedWalletAddress; // Use decrypted address
            responsePayload.proofed = walletInfo ? walletInfo.proofed : false;
        } else if (task.status === 'error') {
            responsePayload.errorMessage = task.error_message;
        }
        res.json(responsePayload);
    } catch (error) {
        logger.error({ err: error, taskUid }, `[API /proof/status] Error fetching status for task`);
        res.status(500).json({ success: false, error: 'Failed to get proof task status' });
    }
}));

// New endpoint for checking active task by telegramId
proofRouter.get('/task/active/:telegramId', wrapAsync(async (req: Request, res: Response) => {
  const { telegramId } = req.params;
  if (!telegramId) {
      return res.status(400).json({ success: false, error: 'Telegram ID is required' });
  }

  logger.debug({ telegramId }, `[API /task/active] Checking active proof task`);
  try {
      const task: ProofTask | null = getActiveProofTaskByTelegramId(telegramId.toString()); 

      if (task) {
          logger.debug({ telegramId, taskUid: task.task_uid, status: task.status }, `[API /task/active] Active task found`);
          
          let decryptedWalletAddress: string | null = null;
          if (task.wallet_address_encrypted) {
              decryptedWalletAddress = decryptWallet(task.wallet_address_encrypted);
              if (!decryptedWalletAddress) {
                  // Log an error if decryption fails but there was an encrypted address
                  logger.error({ taskUid: task.task_uid }, `[API /task/active] Failed to decrypt wallet_address_encrypted`);
              }
          }

          return res.json({
              success: true,
              isActive: true,
              taskUid: task.task_uid,
              walletAddress: decryptedWalletAddress, // Return decrypted (or null if decryption failed/no address)
              status: task.status,
              createdAt: task.created_at 
          });
      } else {
          logger.info({ telegramId }, `[API /task/active] No active task found for telegramId ${telegramId}`);
          return res.json({ success: true, isActive: false });
      }
  } catch (error: any) {
      logger.error({ err: error, telegramId }, `[API /task/active] Error checking active proof task`);
      return res.status(500).json({ success: false, error: 'Internal server error while checking task status.' });
  }
}));

proofRouter.post('/task/cancel/by-telegram/:telegramId', async (req, res) => {
    const telegramId = req.params.telegramId;
    logger.debug({ telegramId }, `[API /task/cancel/by-telegram] Request to cancel tasks`);
    try {
        const result = db.deleteNonFinalizedProofTasksByTelegramId(telegramId);
        if (result.changes > 0) {
            logger.info({ changes: result.changes, telegramId }, `[API /task/cancel/by-telegram] Successfully deleted tasks`);
            res.json({ success: true, message: `Cancelled ${result.changes} active proof tasks.` });
        } else {
            logger.info({ telegramId }, `[API /task/cancel/by-telegram] No active tasks found to cancel`);
            res.json({ success: false, message: 'No active proof tasks found to cancel.' });
        }
    } catch (error) {
        logger.error({ err: error, telegramId }, `[API /task/cancel/by-telegram] Error cancelling tasks`);
        res.status(500).json({ success: false, error: 'Failed to cancel proof tasks.' });
    }
});

// === API Routes Registration ===

// V1 API Endpoints through routers
app.use('/api/v1/collections', collectionsRouter);
app.use('/api/v1/nfts', nftsRouter);
app.use('/api/v1/gas', gasRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/proof', proofRouter);

// New route for all collections
app.get('/api/v1/collections/all', wrapAsync(async (req: Request, res: Response) => {
  try {
    logger.debug({ query: req.query }, '[API /api/v1/collections/all] Request received for ALL collections.');
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20; // Default limit, same as in service
    const collections = await marketplaceService.getCollections(page, limit);
    logger.debug({ count: collections.items.length, total: collections.totalItems }, `[API /api/v1/collections/all] Sending collections`);
    res.json(collections);
  } catch (error) {
    logger.error({ err: error }, '[API /api/v1/collections/all] Error fetching all collections:');
    res.status(500).json({ message: 'Error fetching all collections' });
  }
}));

// NEW STATUS ENDPOINT
app.get('/api/v1/status/:telegramId', wrapAsync(async (req: Request, res: Response) => {
    const { telegramId } = req.params;
    if (!telegramId) {
        return res.status(400).json({ success: false, error: 'Telegram ID is required' });
    }

    logger.debug({ telegramId }, `[API /status/:telegramId] Request for telegramId: ${telegramId}`);

    try {
        const walletData = db.getWallet(telegramId.toString());

        if (!walletData || !walletData.wallet) {
            logger.info({ telegramId }, `[API /status/:telegramId] No wallet linked for telegramId: ${telegramId}`);
            return res.json({
                wallet: null,
                isLinked: false,
                proofed: false,
                balance: 0,
                hasNFT: false
            });
        }

        const { wallet, proofed } = walletData;
        logger.debug({ telegramId, wallet, proofed }, `[API /status/:telegramId] Wallet found for ${telegramId}: ${wallet}, proofed: ${proofed}`);

        let balance = 0;
        let hasNFT = false;

        if (proofed && wallet) {
            try {
                const balanceStr = await nftChecker.getNFTBalance(wallet);
                balance = parseInt(balanceStr, 10);
                if (isNaN(balance)) {
                    logger.warn({ wallet }, `[API /status/:telegramId] NFT balance for ${wallet} was not a valid number: ${balanceStr}`);
                    balance = 0;
                }
                hasNFT = balance > 0;
                logger.debug({ wallet, balance, hasNFT }, `[API /status/:telegramId] NFT check for ${wallet}: balance ${balance}, hasNFT ${hasNFT}`);
            } catch (nftError: any) {
                logger.error({ err: nftError, wallet }, `[API /status/:telegramId] Error checking NFT balance for ${wallet}:`);
                balance = 0;
                hasNFT = false;
            }
        } else {
            logger.info({ telegramId }, `[API /status/:telegramId] Wallet for ${telegramId} is not proofed or address missing. Skipping NFT check.`);
        }

        return res.json({
            wallet: wallet,
            isLinked: true,
            proofed: !!proofed,
            balance: balance,
            hasNFT: hasNFT
        });

    } catch (error: any) {
        logger.error({ err: error, telegramId }, `[API /status/:telegramId] Error processing status for ${telegramId}:`);
        return res.status(500).json({ success: false, error: 'Failed to retrieve wallet status' });
    }
}));

// === Static Files and Web App ===

// Serve static files from the project root 'public' directory
app.use(express.static('public'));

// Serve static files from frontend directory (e.g., build output)
app.use(express.static(path.join(__dirname, '../../frontend')));

// Serve the WebApp HTML
app.get('/terminal', (req, res) => {
  const htmlPath = path.join(__dirname, '../../frontend/templates/interface.html');
  if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
  } else {
      res.status(404).send('Terminal interface not found.');
  }
});

// Serve JS component files
app.get('/gas-panel.js', (req, res) => {
  const filePath = path.join(__dirname, '../../frontend/templates/gas-panel.js');
  if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
  } else {
      res.status(404).send('Component not found');
  }
});

app.get('/collections-panel.js', (req, res) => {
  const filePath = path.join(__dirname, '../../frontend/templates/collections-panel.js');
  if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
  } else {
      res.status(404).send('Component not found');
  }
});

// === Helper Functions ===

// Helper function for address validation
const isValidEvmAddress = (addr: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(addr);

// === Legacy API Endpoints ===
// These endpoints are maintained for backwards compatibility with the bot
// Future versions should migrate to the structured API

// Initial wallet linking (sets proofed = false)
legacyRouter.post('/link', wrapAsync(async (req: Request, res: Response) => {
  try {
    //console.log('[BACKEND API] /link (initial) called:', req.body);
    const { telegramId, wallet } = req.body;
    
    if (!telegramId || !wallet) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const normalizedWallet = wallet.toString().trim().toLowerCase();
    if (!isValidEvmAddress(normalizedWallet)) {
      return res.status(400).json({ success: false, error: 'Invalid EVM address' });
    }
    
    // Save with proofed = false
    const result = db.saveWalletLink(telegramId.toString(), normalizedWallet, false);
    
    if (result && result.changes > 0) {
        res.json({ success: true, message: 'Wallet linked initially. Proof pending.' });
    } else {
        // Check if already exists
        const currentLink = db.getWallet(telegramId.toString());
        if (currentLink && currentLink.wallet.toLowerCase() === normalizedWallet) {
             res.json({ success: true, message: 'Wallet already linked. Proof may be pending or completed.'});
        } else {
            logger.warn({ telegramId, normalizedWallet }, '[BACKEND API] /link: No changes made and link not verifiable');
            res.status(500).json({ success: false, error: 'Failed to initially link wallet or verify existing link.'});
        }
    }
  } catch (error) {
    logger.error({ err: error }, '[BACKEND API] Error in /link (initial):');
    res.status(500).json({ success: false, error: 'Internal server error during initial link.' });
  }
}));

// Check NFT ownership status
legacyRouter.get('/has-nft/:telegramId', wrapAsync(async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId) {
      return res.status(400).json({ hasNFT: false, error: 'Missing telegramId' });
    }
    
    // Get wallet associated with telegramId from DB
    const walletObj = db.getWallet(telegramId.toString());
    
    if (!walletObj || !walletObj.wallet) {
      return res.json({ hasNFT: false, reason: 'Wallet not linked' });
    }
    
    // Check NFT ownership
    const hasNFT = await nftChecker.checkNFTOwnership(walletObj.wallet);
    res.json({ hasNFT });
  } catch (error) {
    logger.error({ err: error, telegramId: req.params.telegramId }, `[BACKEND] Error in /has-nft for ${req.params.telegramId}:`);
    res.status(500).json({ hasNFT: false, error: 'Internal server error checking NFT ownership' });
  }
}));

// Get wallet status
legacyRouter.get('/status/:telegramId', wrapAsync(async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId) {
       return res.status(400).json({ isLinked: false, error: 'Missing telegramId' });
    }
    
    const walletObj = db.getWallet(telegramId.toString());

    if (!walletObj || !walletObj.wallet) {
      return res.json({ isLinked: false, proofed: false, balance: 0, hasNFT: false });
    }

    const { wallet, proofed } = walletObj;
    let balance: number | string = 'N/A'; // Default to N/A on error
    let hasNFT = false;
    
    try {
      // Fetch real-time balance
      const balanceStr = await nftChecker.getNFTBalance(wallet);
      balance = Number(balanceStr);
      
      if (isNaN(balance)) {
        logger.error({ wallet }, `[API /status] Invalid balance received for ${wallet}: ${balanceStr}`);
        balance = 'Error';
        hasNFT = false;
      } else {
        hasNFT = balance > 0;
      }
    } catch (nftError) {
       logger.error({ err: nftError }, `[API /status] Error getting NFT balance for ${wallet}:`);
       balance = 'Error';
       hasNFT = false;
    }

    res.json({
      isLinked: true,
      wallet,
      proofed,
      balance,
      hasNFT
    });
  } catch (error) {
    logger.error({ err: error, telegramId: req.params.telegramId }, `[API /status] Error getting status for ${req.params.telegramId}:`);
    res.status(500).json({ isLinked: false, error: 'Internal server error getting status' });
  }
}));

// Unlink wallet
legacyRouter.post('/unlink', wrapAsync(async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ success: false, error: 'Missing telegramId' });
    }
    
    // Attempt to unlink from wallets table
    const unlinkedFromWallets = db.unlinkWallet(telegramId.toString());
    
    if (unlinkedFromWallets) {
      // If wallet was successfully unlinked from wallets, proceed to delete alert subscriptions
      const telegramIdHashed = hashTelegramId(telegramId.toString());
      db.deleteAlertSubscriptionsByTelegramIdHash(telegramIdHashed);
      logger.info({ telegramId }, `[API /unlink] Wallet unlinked for telegramId: ${telegramId} and all associated alert subscriptions deleted.`);
      res.json({ success: true, message: 'Wallet unlinked successfully and alert subscriptions cleared.' });
    } else {
      // Wallet was not found in the wallets table (perhaps already unlinked or never linked)
      // No further action needed for alert subscriptions in this case via this path.
      logger.info({ telegramId }, `[API /unlink] Wallet not found or already unlinked for telegramId: ${telegramId}. No alert subscriptions action taken via unlink.`);
      res.json({ success: true, message: 'Wallet not found or already unlinked.' });
    }
  } catch (error) {
    logger.error({ err: error, telegramId: req.body.telegramId }, `[API /unlink] Error during unlink process for telegramId`);
    res.status(500).json({ success: false, error: 'Internal server error during unlink process.' });
  }
}));

// Check terminal access
legacyRouter.get('/terminal-access/:telegramId', wrapAsync(async (req: Request, res: Response) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId) {
      return res.status(400).json({ access: false, reason: 'Missing telegramId' });
    }
    
    // Get wallet status
    const walletObj = db.getWallet(telegramId.toString());
    
    if (!walletObj || !walletObj.wallet) {
      //console.log('[TERMINAL ACCESS] Wallet not linked:', telegramId);
      return res.json({ access: false, reason: 'Wallet not linked' });
    }
    
    const { wallet, proofed } = walletObj;

    // Check if proofed
    if (!proofed) {
      //console.log('[TERMINAL ACCESS] Wallet not proofed:', telegramId, wallet);
      return res.json({ access: false, reason: 'Wallet ownership not verified' });
    }

    // Check NFT ownership (real-time)
    let balance: number | string = 'N/A';
    let hasNFT = false;
    
    try {
        const balanceStr = await nftChecker.getNFTBalance(wallet);
        balance = Number(balanceStr);
        
        if(isNaN(balance)) {
            logger.error({ wallet }, `[TERMINAL ACCESS] Invalid balance for ${wallet}: ${balanceStr}`);
            balance = 'Error';
            hasNFT = false;
        } else {
            hasNFT = balance > 0;
        }
    } catch (nftError) {
        logger.error({ err: nftError }, `[TERMINAL ACCESS] Error checking NFT balance for ${wallet}:`);
        balance = 'Error';
        hasNFT = false;
    }

    // Grant access only if proofed AND has NFT
    if (!hasNFT) {
      //console.log('[TERMINAL ACCESS] No NFT:', telegramId, wallet, 'balance:', balance);
      return res.json({ access: false, reason: 'NFT ownership required' });
    }

    // All checks passed
    //console.log('[TERMINAL ACCESS] Access granted:', telegramId, wallet, 'balance:', balance);
    res.json({ access: true });
  } catch (error) {
    logger.error({ err: error, telegramId: req.params.telegramId }, `[TERMINAL ACCESS] Error checking terminal access for ${req.params.telegramId}:`);
    res.status(500).json({ access: false, error: 'Internal server error checking access' });
  }
}));

// Health check endpoint
legacyRouter.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// --- Profile API Endpoints ---

// Get User Profile
legacyRouter.get('/api/v1/users/:telegramId/profile', wrapAsync(async (req: Request, res: Response) => {
    try {
        const { telegramId } = req.params;
        if (!telegramId) {
            return res.status(400).json({ error: 'Missing telegramId' });
        }

        // Ensure the user is at least linked for a profile to be relevant
        const baseWalletData = db.getWallet(telegramId.toString());
        if (!baseWalletData || !baseWalletData.wallet) {
            // Even if profile service might return null, explicit check here provides clearer error
            return res.status(404).json({ error: 'User not found or no wallet linked.' });
        }

        const userProfile = await profileService.getUserProfile(telegramId.toString());

        if (!userProfile) {
            // This case should ideally be caught by the check above, but as a fallback:
            return res.status(404).json({ error: 'Profile not found for user.' });
        }

        res.json(userProfile);

    } catch (error) {
        logger.error({ err: error }, `[API /users/:telegramId/profile] Error:`);
        res.status(500).json({ error: 'Internal server error retrieving user profile.' });
    }
}));

// Connect all legacyRouter routes to the main application
app.use('/', legacyRouter);

// === Start Server ===
const certPath = path.join(__dirname, '../../certs');

const startup = () => {
    proofVerificationService.start();
    logger.info('[SERVER] ProofVerificationService started.');
    housekeepingService.start();
    logger.info('[SERVER] HousekeepingService started.');

    const keyPath = path.join(certPath, 'key.pem');
    const certPemPath = path.join(certPath, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPemPath)) {
        const serverOptions: https.ServerOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPemPath)
        };
        https.createServer(serverOptions, app).listen(port + 1, '0.0.0.0', () => {
            logger.info({ port: port + 1 }, `[SERVER] HTTPS server running on https://0.0.0.0:${port + 1}`);
        });
        // Also start HTTP server for local access or non-HTTPS needs, or as fallback
        http.createServer(app).listen(port, '0.0.0.0', () => {
            logger.info({ port }, `[SERVER] HTTP server running on http://0.0.0.0:${port}`);
        });
        logger.info('[SERVER] SSL certificates found. HTTPS will be enabled alongside HTTP.');
    } else {
        http.createServer(app).listen(port, '0.0.0.0', () => {
            logger.info({ port }, `[SERVER] HTTP server running on http://0.0.0.0:${port}`);
        });
        logger.warn('[SERVER] SSL certificates not found. HTTPS is disabled. HTTP only.');
    }
};

startup();

// Export Express app for testing (no need to export servers themselves anymore)
export { app }; 