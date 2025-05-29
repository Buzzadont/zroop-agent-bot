import { Telegraf, Markup, Context } from 'telegraf';
import logger from '../shared/utils/logger';
import axios, { AxiosInstance } from 'axios';
import https from 'https';
// @ts-ignore
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
// @ts-ignore
// import { findTransaction as checkZeroTxProof } from '../backend/services/proofChecker'; // Commented out
import { createRateLimiter, createBotBlocker, createCommandLimiter } from './anti-abuse';
import { PROOF_TASK_DEADLINE_MINUTES } from '../shared/utils/constants'; // Added import

const axiosInstance: AxiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    }),
    timeout: 15000
});

const API_URL = process.env.API_URL;
const CHECK_ADDRESS = process.env.CHECK_WALLET;
const NFT_MARKETPLACE_NAME = process.env.NFT_MARKETPLACE_NAME || "the NFT marketplace";
const NFT_MARKETPLACE_URL = process.env.NFT_MARKETPLACE_URL || "";

// logger.debug('API_URL:', API_URL);
// logger.debug('CHECK_WALLET:', CHECK_ADDRESS);
// logger.debug('BOT_TOKEN:', process.env.BOT_TOKEN ? '***' : 'NOT SET');

const bot = new Telegraf(process.env.BOT_TOKEN!);

// Apply anti-abuse protection
// 1. Block bots
bot.use(createBotBlocker('Bot accounts are not allowed to use this bot.'));

// 2. General request rate limiting
// Whitelist/Blacklist are now read from .env automatically by createRateLimiter.
// This call will use defaults from DEFAULT_RATE_LIMIT_CONFIG and merge with .env lists.
const { middleware: rateLimiterMiddleware, destroy: destroyRateLimiter } = createRateLimiter({
  // Example of overriding a specific default if needed, otherwise remove to use all defaults:
  // blockMessage: 'Custom block message for the main bot instance',
});
bot.use(rateLimiterMiddleware);

// TODO: Ensure destroyRateLimiter is called on graceful shutdown
// e.g. process.on('SIGINT', () => { destroyRateLimiter(); bot.stop('SIGINT'); });

// 3. Special restrictions for certain commands
bot.use(createCommandLimiter(
  ['link', 'unlink'], // Commands with increased restrictions
  3,  // 3 uses
  60 * 60 * 1000, // within 1 hour
  '⚠️ You are using this command too frequently. Please try again later.'
));

const userStates: Record<string, { state: string; wallet?: string; taskUid?: string; messageId?: number }> = {};

// Store active polling timeouts
const activePollingTimeouts: Record<string, NodeJS.Timeout> = {};
// Store active stop signals for polling
const activePollingStopSignals: Record<string, () => void> = {};

function stopPolling(telegramId: string) {
    if (activePollingStopSignals[telegramId]) {
        activePollingStopSignals[telegramId](); // Signal the poll to stop
        delete activePollingStopSignals[telegramId];
    }
    if (activePollingTimeouts[telegramId]) {
        clearTimeout(activePollingTimeouts[telegramId]);
        delete activePollingTimeouts[telegramId];
    }
    // logger.info(`[BOT] Polling stopped for ${telegramId}`);
}

const MESSAGES = {
    WELCOME: (firstName: string) => `👋 Welcome, ${firstName}!\nThis bot helps you link your Telegram account to an EVM wallet and access exclusive NFT features.`,
    ALREADY_PROCESSING: "⏳ Your previous request is still processing. Please wait.",
    WALLET_PROMPT: "🔗 Please send me your EVM wallet address (e.g., 0x...).",
    WALLET_INVALID: "⚠️ Invalid wallet address. Please try again.",
    WALLET_ACCEPTED_CHECKING_PROOF: (wallet: string) => `✅ Wallet address ${wallet} received.\nChecking for proof transaction... This might take a few minutes.`, // Should be immediately followed by CHECK_INSTRUCTIONS
    CHECK_INSTRUCTIONS: (checkWallet: string, wallet: string, deadlineMinutes: number) =>
        `❗ To confirm ownership of ${wallet}, please send a 0 TIA (or any small amount) transaction **on the Forma network** to the following address:\n\n\`${checkWallet}\`\n\n⏳ You must send this transaction within the next ${deadlineMinutes} minutes. I'll keep checking. ` +
        `I will notify you once the transaction is confirmed. `,
    PROOF_INITIATED: (wallet: string, taskUid: string) => `⏳ Proof verification initiated for ${wallet}. Task ID: ${taskUid}. I will update you on the status.`,
    PROOF_PENDING: (wallet: string) => `⏳ Proof verification for ${wallet} is pending and will be processed soon.`,
    PROOF_STILL_PROCESSING_POLL: (wallet: string) => `⏳ Proof verification for ${wallet} is still in progress. Please wait.`,
    PROOF_SUCCESS: (wallet: string) => `✅ Wallet ${wallet} successfully linked and ownership confirmed!`,
    PROOF_FAILED_NO_TX: (wallet: string) => `❌ Proof transaction not found for ${wallet} within the allowed time. Please try linking again with /link.`,
    PROOF_EXPIRED_TASK: (wallet: string) => `⌛ The proof verification task for ${wallet} has expired. Please try linking again with /link.`,
    PROOF_ERROR: (wallet: string, error?: string) => `🚫 An error occurred during proof verification for ${wallet}${error ? ': ' + error : ''}. Please try again or contact support.`,
    PROOF_TASK_NOT_FOUND_POLL: "❓ Verification task not found. It might have been completed or cancelled. Use /status to check.",

    POLLING_STOPPED_MAX_ATTEMPTS: "Polling stopped after maximum attempts. Use /status to check the final outcome.",
    POLLING_MESSAGE_EDIT_UNAVAILABLE: "(Previous status message was too old to update directly.)",

    STATUS_LINKED_PROOFED_NFT_YES: (wallet: string, balance: number) => `✅ Wallet: ${wallet}\n🔗 Linked: Yes\n🛡️ Ownership Proofed: Yes\n🖼️ NFT Balance: ${balance} (Access Granted)`,
    STATUS_LINKED_PROOFED_NFT_NO: (wallet: string) => `⚠️ Wallet: ${wallet}\n🔗 Linked: Yes\n🛡️ Ownership Proofed: Yes\n🖼️ NFT Balance: 0\nAccess to terminal denied. You need to hold a Zrooper. Get one here: [${NFT_MARKETPLACE_NAME}](${NFT_MARKETPLACE_URL})`,
    STATUS_LINKED_NOT_PROOFED: (wallet: string) => `⏳ Wallet: ${wallet}\n🔗 Linked: Yes\n🛡️ Ownership Proofed: No\nPlease complete the proof-of-ownership transaction. If you've sent it, please wait a few minutes.`,
    STATUS_NOT_LINKED: "🚫 Wallet not linked. Use /link to link your wallet.",
    STATUS_CHECKING_FROM_RESTART: (wallet: string) => `⏳ Checking your wallet ${wallet} is still in progress (possibly due to bot restart). Please wait. You can also use /restart to cancel the current attempt and start over.`,
    STATUS_ERROR: "🚫 Error retrieving status. Please try again later.",

    UNLINK_SUCCESS: "🗑️ Your wallet has been unlinked.",
    UNLINK_NOT_LINKED: "🚫 No wallet is currently linked.",
    UNLINK_ERROR: "🚫 Error unlinking wallet. Please try again.",

    RESTART_PROMPT: "🔄 Are you sure you want to restart? This will cancel any ongoing wallet linking process. Type /restart again to confirm, or /cancel to keep the current operation.",
    BOT_RESTARTED_MESSAGE: "🔄 Bot restarted. Any active operations have been cancelled.", // Generic bot restart message
    RESTART_CONFIRMED_NO_ACTIVE_OP: "✅ Bot state cleared. No active operations were in progress.",
    RESTART_CONFIRMED_OP_CANCELLED: "✅ Current proof verification cancelled. You can start a new one with /link.",
    RESTART_CANCEL_API_FAILED: "⚠️ Could not cancel the task on the backend, but local state cleared. Please use /status to check or try /restart again.",
    RESTART_CANCEL_NO_TASK: "✅ Local state cleared. No active task was found on the backend to cancel.",

    TERMINAL_NO_ACCESS_NO_NFT: (marketplaceName: string, marketplaceUrl: string) => `🚫 Access Denied: You need to own a Zrooper. Visit [${marketplaceName}](${marketplaceUrl}) to get one.`,
    TERMINAL_NO_ACCESS_NOT_PROOFED: "🚫 Access Denied: Your wallet ownership is not yet proofed. Please complete the proof process.",
    TERMINAL_NO_ACCESS_NOT_LINKED: "🚫 Access Denied: No wallet linked. Please use /link first.",
    TERMINAL_ERROR: "🚫 Error granting terminal access. Please try again later.",
    TERMINAL_ACCESS_GRANTED: "🚀 Access Granted! Click the button below to open the terminal:",

    HELP_MESSAGE: "Available commands:\n" +
    "/link - Link your EVM wallet\n" +
    "/unlink - Unlink your wallet\n" +
    "/restart - Restart or cancel current operation\n" +
    "/terminal - Open NFT terminal interface\n" +
    "/status - Check wallet and NFT status\n" +
    "/help - Show this help message" +
    "\n\n" +
    "*Take control of your NFT experience on the Forma network!*\n\n" +
    "This bot allows you to:\n" +
    "1.  *Link Your Wallet:* Securely connect your EVM wallet.\n" +
    "2.  *Explore NFTs:* Use the `/terminal` command to open a web interface where you can see your NFTs and browse Modularium collections.\n" +
    "3.  *Stay Informed:* Set up alerts for floor price changes and best offers on collections you\'re interested in.\n\n" +
    "We\'re constantly working to add more features and support for other blockchains. Your data is handled with care, using hashing and encryption for your security.",
    PRIVACY_NOTICE: "🔒 *Privacy Notice*:\nYour Telegram ID and wallet address are stored only as encrypted hashes in our secure database. Nobody (including the bot owner) can see or recover your actual Telegram ID or wallet address from the database. Your privacy and security are our top priority.",
    COMMAND_UNKNOWN: "❓ Unknown command. Type /help for a list of available commands.",
    GENERAL_ERROR: "⚙️ An unexpected error occurred. Please try again later or contact support.",
    NO_NFT: (marketplaceName: string, marketplaceUrl: string) => `You don\'t have a Zrooper. Please visit [${marketplaceName}](${marketplaceUrl}) to get one.`,
    LINK_WALLET_PROMPT_REPLY: "🔗 Please enter your EVM wallet address (starts with 0x...).", // Duplicate of WALLET_PROMPT essentially for replies
    LINK_REPLACE_CONFIRM: (wallet: string) =>
        `You already have a linked wallet: ${wallet}\n\n` +
        `⚠️ WARNING: If you link a new wallet, your previous wallet link will be deleted.\n\n` +
        `All verification status and access rights for the current wallet will be removed, and you\'ll need to complete the proof process again with the new wallet.\n\n` +
        `Do you want to proceed? (yes/no)`,
    LINK_CANCELLED: "Wallet linking process cancelled.",
    WALLET_REPLACEMENT_CANCELLED: "Wallet replacement cancelled.",
    WALLET_UNLINK_CANCELLED: "Wallet unlinking cancelled.",
    PROOF_INITIATION_FAILED: "❌ Failed to initiate proof verification. Please try /link again or contact support.",
    PROOF_STATUS_NOT_FOUND: "❓ Could not find an active proof verification task for your account. Please use /link to start.",
    PROOF_ALREADY_IN_PROGRESS: "⏳ A proof verification is already in progress for your account. Please wait for it to complete or use /restart to cancel and start over.",
    INVALID_ADDRESS: "❗ Invalid address format. Please enter a valid EVM address (starts with 0x, 42 chars, hex, no spaces).",
    SERVICE_UNAVAILABLE: "Service unavailable. Try again later.",
    CONFIG_ERROR: "Configuration error. Please contact support.",
    UNLINK_CONFIRM: "⚠️ Unlink your wallet?\n\nThis will remove the connection between your Telegram account and wallet.\n\nPlease respond with \"yes\ / y\" or \"no\ / n\".",
    UNLINK_FAILED: "Failed to unlink wallet or no wallet was linked.",
    WAIT_FOR_PROOF_CHECK: "⏳ Please wait for the current proof verification to complete before sending new commands or wallet addresses.",
    YES_NO_PROMPT: "I did not understand your response. Please answer with \"yes\ / y\" or \"no\ / n\".",
};

/**
 * Sends a message to a specified Telegram user.
 * @param telegramId The ID of the Telegram user.
 * @param message The message text to send.
 * @param options Optional Telegraf message sending options (e.g., parse_mode).
 * @returns True if the message was sent successfully, false otherwise.
 */
export const sendTelegramMessage = async (telegramId: string, message: string, options?: Partial<Parameters<Telegraf["telegram"]["sendMessage"]>[2]>): Promise<boolean> => {
    if (bot && bot.telegram) {
        try {
            await bot.telegram.sendMessage(telegramId, message, options);
            //logger.debug(`[BotUtil] Message sent to ${telegramId}`);
            return true;
        } catch (error: any) {
            logger.error({ err: error, telegramId, message: error.message }, `[BotUtil] Error sending message to ${telegramId}`);
            // Check for common bot-related errors
            if (error.response && error.response.description) {
                logger.error({ telegramId, errorCode: error.response.error_code, description: error.response.description }, `[BotUtil] Telegram API Error`);
                // Specific error handling can be added here, e.g., for blocked users
                if (error.response.error_code === 403) { // Forbidden: bot was blocked by the user
                    logger.warn({ telegramId }, `[BotUtil] Bot may be blocked by user ${telegramId}.`);
                    // Here you might want to mark the user as inactive for notifications in your DB
                }
            }
            return false;
        }
    }
    logger.error("[BotUtil] Bot instance not available for sending message.");
    return false;
};

function normalizeAddress(addr: string): string {
    return addr.trim().replace(/\s+/g, '').toLowerCase();
}

function isValidEvmAddress(addr: string): boolean {
    return /^0x[a-f0-9]{40}$/.test(addr);
}

const mainKeyboard = Markup.keyboard([
    ['🔗 /link', '🖥️ /terminal'],
    ['📊 /status', '❓ /help'],
    ['❌ /unlink', '🔄 /restart']
]).resize();

const checkNFTOwnership = async (ctx: any, next: any) => {
    const telegramId = ctx.from.id.toString();
    try {
        const response = await axiosInstance.get(`${API_URL}/has-nft/${telegramId}`);
        if (response.data.hasNFT) return next();
        return ctx.reply(MESSAGES.NO_NFT(NFT_MARKETPLACE_NAME, NFT_MARKETPLACE_URL), { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (error) {
        return ctx.reply('Service unavailable. Try again later.');
    }
};

const handleLink = (ctx: any) => {
    //logger.debug({from: ctx.from},'[BOT] handleLink called');
    const telegramId = ctx.from.id.toString();
    
    // New: Check if a proof task is already active for this user via API or local state if we introduce one
    // For now, we'll manage this primarily via userStates after initiating
    if (userStates[telegramId]?.state === 'awaiting_proof_completion') {
        ctx.reply(MESSAGES.PROOF_ALREADY_IN_PROGRESS);
        return;
    }
    
    axiosInstance.get(`${API_URL}/status/${telegramId}`).then(async (response) => {
        const data = response.data;
        //logger.debug({ data },'[BOT] /status response for link:');
        if (data.isLinked && data.wallet) {
            userStates[telegramId] = { state: 'awaiting_replace_confirm', wallet: data.wallet };
            ctx.reply(MESSAGES.LINK_REPLACE_CONFIRM(data.wallet));
        } else {
            userStates[telegramId] = { state: 'awaiting_wallet' };
            ctx.reply(MESSAGES.LINK_WALLET_PROMPT_REPLY);
        }
    }).catch((err: any) => {
        logger.error(
            { 
                message: err.message, 
                method: err.config?.method, 
                url: err.config?.url, 
                status: err.response?.status, 
                responseData: err.response?.data, 
                stack: err.stack 
            },
            '[BOT] /status error during link:'
        );
        // Fallback to allowing linking if status fails
        userStates[telegramId] = { state: 'awaiting_wallet' };
        ctx.reply(MESSAGES.LINK_WALLET_PROMPT_REPLY);
    });
};

bot.command('link', handleLink);
bot.hears('/link', handleLink);
bot.hears('🔗 /link', handleLink);
bot.hears(/\/link/, handleLink);

// Add a helper function to check if a message is a bot command
function isCommand(text: string): boolean {
    return text.startsWith('/') || text.includes(' /');
}

bot.on('text', async (ctx: any, next: any) => {
    //logger.debug({text: ctx.message.text, state: userStates[ctx.from.id.toString()]}, '[BOT] Received text');
    const telegramId = ctx.from.id.toString();
    const messageText = ctx.message.text.trim();

    // Skip command-like messages from being processed as text responses
    if (isCommand(messageText)) {
        //logger.debug(`[BOT] Message "${messageText}" looks like a command, letting command handlers process it.`);
        return next();
    }

    const currentUserState = userStates[telegramId];

    if (currentUserState?.state === 'awaiting_proof_completion') {
        //logger.debug(`[BOT] Proof check is currently active for ${telegramId} (task: ${currentUserState.taskUid}). Ignoring text messages.`);
        await ctx.reply(MESSAGES.WAIT_FOR_PROOF_CHECK);
             return;
    }

    if (currentUserState?.state === 'awaiting_replace_confirm') {
        const answer = messageText.toLowerCase();
        //logger.debug('[BOT] awaiting_replace_confirm answer:', answer);
        
        if (answer === 'yes' || answer === 'y') {
            userStates[telegramId] = { state: 'awaiting_wallet' };
            ctx.reply(MESSAGES.LINK_WALLET_PROMPT_REPLY);
        } else if (answer === 'no' || answer === 'n') {
            delete userStates[telegramId];
            ctx.reply(MESSAGES.WALLET_REPLACEMENT_CANCELLED);
        } else {
            ctx.reply(MESSAGES.YES_NO_PROMPT + '\n\nDo you want to proceed with replacing your current wallet?');
        }
        return;
    }
    
    if (currentUserState?.state === 'awaiting_unlink_confirm') {
        const answer = messageText.toLowerCase();
        //logger.debug('[BOT] awaiting_unlink_confirm answer:', answer);
        
        if (answer === 'yes' || answer === 'y') {
            delete userStates[telegramId];
            // Actual unlink logic will be here or reuse handleUnlink parts
            try {
                const apiUrl = process.env.API_URL?.trim();
                if (!apiUrl) {
                    logger.error('[BOT] API_URL is not defined for text-based unlink');
                    ctx.reply(MESSAGES.CONFIG_ERROR);
                    return;
                }
                //logger.debug(`[BOT] Calling API (${apiUrl}/unlink) to unlink wallet for ${telegramId} via text confirmation`);
                const response = await axiosInstance.post(`${apiUrl}/unlink`, { telegramId });
                if (response.data.success) {
                    //logger.debug(`[BOT] Backend reported success for unlink of ${telegramId}`);
                    ctx.reply(response.data.message || MESSAGES.UNLINK_SUCCESS);    
                } else {
                    logger.warn({ responseData: response.data.error }, '[BOT] Backend reported failure for unlink of ' + telegramId + ':');
                    ctx.reply(response.data.error || MESSAGES.UNLINK_FAILED);    
                }
            } catch (e: any) {
                logger.error(
                    { 
                        message: e.message, 
                        method: e.config?.method, 
                        url: e.config?.url, 
                        status: e.response?.status, 
                        responseData: e.response?.data, 
                        stack: e.stack 
                    },
                    '[BOT] API error in text-based unlink:'
                );
                ctx.reply(MESSAGES.SERVICE_UNAVAILABLE);
            }
        } else if (answer === 'no' || answer === 'n') {
            delete userStates[telegramId];
            ctx.reply(MESSAGES.WALLET_UNLINK_CANCELLED);
        } else {
            ctx.reply(MESSAGES.YES_NO_PROMPT + '\n\nDo you want to proceed with unlinking your wallet?');
        }
        return;
    }
    
    if (currentUserState?.state === 'awaiting_wallet') {
        let wallet = normalizeAddress(messageText);
        //logger.debug('[BOT] awaiting_wallet, input:', messageText, 'normalized:', wallet);
        if (!isValidEvmAddress(wallet)) {
            ctx.reply(MESSAGES.INVALID_ADDRESS);
            return;
        }
        // Store wallet in state for the next step (API call)
        userStates[telegramId] = { state: 'initiating_proof', wallet: wallet };
        
        // Immediately call the new function to initiate proof with backend
        await initiateProofWithBackend(ctx, telegramId, wallet);
        return;
    }
    return next();
});

const PRIVACY_NOTICE = `🔒 Privacy Notice\n\nYour Telegram ID and wallet address are stored only as encrypted hashes in our secure database.\n\nNobody (including the bot owner) can see or recover your actual Telegram ID or wallet address from the database.\n\nYour privacy and security are our top priority.`;

bot.start((ctx: any) => {
    //logger.info('Received /start');
    ctx.reply(MESSAGES.WELCOME(ctx.from.first_name), mainKeyboard);
    ctx.reply(PRIVACY_NOTICE);
    //ctx.reply(MESSAGES.HELP_MESSAGE);
});

const handleRestart = async (ctx: any) => {
    const telegramId = ctx.from.id.toString();
    if (!telegramId) {
        logger.error('[BOT] handleRestart: telegramId is undefined');
        return ctx.reply(MESSAGES.GENERAL_ERROR);
    }

    logger.info(`[BOT] handleRestart called by ${telegramId}`);

    // Stop any local polling for this user
    stopPolling(telegramId);

    // Attempt to cancel the task on the backend
    let backendCancellationMessageKey: keyof typeof MESSAGES = 'RESTART_CONFIRMED_NO_ACTIVE_OP';

    try {
        const response = await axiosInstance.post(`${API_URL}/api/v1/proof/task/cancel/by-telegram/${telegramId}`);
        if (response.data.success) {
            logger.info(`[BOT] handleRestart: Successfully cancelled task on backend for ${telegramId}. Message: ${response.data.message}`);
            backendCancellationMessageKey = 'RESTART_CONFIRMED_OP_CANCELLED';
        } else {
            if (response.data.message && response.data.message.toLowerCase().includes("no active proof tasks found")) {
                logger.info(`[BOT] handleRestart: No active task found on backend to cancel for ${telegramId}`);
                backendCancellationMessageKey = 'RESTART_CANCEL_NO_TASK';
            } else {
                logger.warn({ responseData: response.data.message }, '[BOT] handleRestart: Backend responded with non-success for task cancellation for ' + telegramId + ':');
                backendCancellationMessageKey = 'RESTART_CANCEL_API_FAILED'; 
            }
        }
    } catch (error: any) {
        logger.error(
            { 
                message: error.message, 
                method: error.config?.method, 
                url: error.config?.url, 
                status: error.response?.status, 
                responseData: error.response?.data, 
                stack: error.stack, 
                telegramId 
            },
            '[BOT] handleRestart: Error calling backend to cancel task'
        );
        backendCancellationMessageKey = 'RESTART_CANCEL_API_FAILED';
        }
        
    if (userStates[telegramId]) {
        delete userStates[telegramId];
        logger.info(`[BOT] handleRestart: Cleared local user state for ${telegramId}`);
    }
    
    // @ts-ignore
    await ctx.reply(MESSAGES[backendCancellationMessageKey]); 

    await ctx.reply(MESSAGES.BOT_RESTARTED_MESSAGE); // Generic bot restart message
    await ctx.reply(MESSAGES[backendCancellationMessageKey]); 

    if (ctx.from) {
        // @ts-ignore
        await ctx.reply(MESSAGES.WELCOME(ctx.from.first_name));
    }
};

const handleUnlink = async (ctx: any) => {
    //logger.debug('handleUnlink called');
    const telegramId = ctx.from.id.toString();
    const currentUserState = userStates[telegramId];

    if (currentUserState?.state === 'awaiting_unlink_confirm') {
        // This case might be less common now if text 'yes' handles it, but good as a fallback
        delete userStates[telegramId];
        try {
            const apiUrl = process.env.API_URL?.trim();
            if (!apiUrl) {
                logger.error('[BOT] API_URL is not defined for handleUnlink');
                ctx.reply(MESSAGES.CONFIG_ERROR);
                return;
            }
            //logger.debug(`[BOT] Calling API (${apiUrl}/unlink) to unlink wallet for ${telegramId}`);
            const response = await axiosInstance.post(`${apiUrl}/unlink`, { telegramId });
            if (response.data.success) {
                //logger.debug(`[BOT] Backend reported success for unlink of ${telegramId}`);
                ctx.reply(response.data.message || MESSAGES.UNLINK_SUCCESS);    
            } else {
                logger.warn({ responseData: response.data.error }, '[BOT] Backend reported failure for unlink of ' + telegramId + ':');
                ctx.reply(response.data.error || MESSAGES.UNLINK_FAILED);    
            }
        } catch (e: any) {
            logger.error(
                { 
                    message: e.message, 
                    method: e.config?.method, 
                    url: e.config?.url, 
                    status: e.response?.status, 
                    responseData: e.response?.data, 
                    stack: e.stack 
                },
                '[BOT] API error in handleUnlink:'
            );
            ctx.reply(MESSAGES.SERVICE_UNAVAILABLE);
        }
    } else {
        userStates[telegramId] = { state: 'awaiting_unlink_confirm' };
        ctx.reply(MESSAGES.UNLINK_CONFIRM);
    }
};

const handleStatus = async (ctx: any) => {
    //logger.debug('[BOT] handleStatus called');
    const telegramId = ctx.from.id.toString();
    //logger.debug({ telegramId }, `[BOT] handleStatus invoked. Current local state for ${telegramId}:`);

    if (!API_URL) { 
        logger.error('[BOT] API_URL is not defined in environment for handleStatus');
        await ctx.reply(MESSAGES.CONFIG_ERROR);
        return;
    }

    // --- Block 1: Check Local Active Task First ---
    const localTaskState = userStates[telegramId];
    if (localTaskState?.state === 'awaiting_proof_completion' && localTaskState.taskUid && localTaskState.wallet) {
        //logger.debug({ telegramId, taskUid: localTaskState.taskUid }, `[BOT] Status (LTS): Found local active task ${localTaskState.taskUid} for wallet ${localTaskState.wallet}. Checking its status.`);
        try {
            const taskResponse = await axiosInstance.get(`${API_URL}/api/v1/proof/status/${localTaskState.taskUid}`);
            const taskApiData = taskResponse.data;
            //logger.debug({ telegramId, taskUid: localTaskState.taskUid, data: taskApiData }, `[BOT] Status (LTS): API response for task ${localTaskState.taskUid}:`);

            const taskStatus = taskApiData.status?.toUpperCase();
            const walletForMessage = localTaskState.wallet; // Use wallet from local state as it's tied to this task

            if (taskStatus === 'PENDING' || taskStatus === 'PROCESSING') {
                await ctx.reply(taskStatus === 'PENDING' ? MESSAGES.PROOF_PENDING(walletForMessage) : MESSAGES.PROOF_STILL_PROCESSING_POLL(walletForMessage));
                return; // Exit early, polling will handle the final result
            } else {
                // Task is completed (SUCCESS, FAILED, EXPIRED, ERROR) or NOT_FOUND
                //logger.debug({ telegramId, taskUid: localTaskState.taskUid }, `[BOT] Status (LTS): Task ${localTaskState.taskUid} is in a final state (${taskStatus}) or not found. Clearing local state and proceeding to main status check.`);
                stopPolling(telegramId); // Stop any active polling for this user
                delete userStates[telegramId];
                // Fall through to main status check below
            }
        } catch (e: any) {
            logger.error(
                { 
                    message: e.message, 
                    method: e.config?.method, 
                    url: e.config?.url, 
                    status: e.response?.status, 
                    responseData: e.response?.data, 
                    stack: e.stack, 
                    telegramId, 
                    taskUid: localTaskState?.taskUid 
                },
                '[BOT] Status (LTS): Error checking local task API:'
            );
            // If API fails for local task, still proceed to main status check
            stopPolling(telegramId); 
            delete userStates[telegramId];
        }
    }

    // --- Block 2: Main Status Check via /api/v1/status/:telegramId ---
    //logger.debug({ telegramId }, `[BOT] Status (MSR): Calling main /status API for ${telegramId}`);
    try {
        const mainStatusResponse = await axiosInstance.get(`${API_URL}/api/v1/status/${telegramId}`); 
        const statusData = mainStatusResponse.data;
        //logger.debug({ telegramId, data: statusData }, `[BOT] Status (MSR): Main API response for ${telegramId}:`);
        const { wallet: apiWallet, isLinked, proofed, balance, hasNFT } = statusData;

        // --- Block 3: Check for Active Backend Task if Discrepancies or Not Fully Proofed ---
        if (!isLinked || (isLinked && !proofed)) {
            //logger.debug({ telegramId }, `[BOT] Status (ABT): Main status is !isLinked OR (isLinked && !proofed). Wallet: ${apiWallet}. Checking backend for active task.`);
            try {
                const activeTaskResponse = await axiosInstance.get(`${API_URL}/api/v1/proof/task/active/${telegramId}`);
                if (activeTaskResponse.data && activeTaskResponse.data.isActive) {
                    const backendTask = activeTaskResponse.data;
                    const backendTaskWallet = backendTask.walletAddress?.toLowerCase();
                    //logger.debug({ telegramId, taskUid: backendTask.taskUid, wallet: backendTaskWallet }, `[BOT] Status (ABT): Active task ${backendTask.taskUid} (wallet: ${backendTaskWallet}, status: ${backendTask.status}) found on backend.`);
                    
                    // If main API says linked but not proofed, AND active task is for the SAME wallet:
                    if (isLinked && !proofed && apiWallet && backendTaskWallet === apiWallet.toLowerCase()) {
                        await ctx.reply(MESSAGES.STATUS_LINKED_NOT_PROOFED(apiWallet) + ` (Verification ID: ${backendTask.taskUid})`);
                        return;
                    }
                    // Otherwise (not linked by main API, OR active task for a DIFFERENT wallet than main API reports)
                    await ctx.reply(MESSAGES.STATUS_CHECKING_FROM_RESTART(backendTaskWallet || 'your wallet'));
                    return;
                }
                 // If !isLinked by main API AND no active backend task, then it's truly not linked.
                if (!isLinked) {
                    //logger.debug({ telegramId }, `[BOT] Status (ABT): Main API !isLinked AND no active task on backend. Replying STATUS_NOT_LINKED.`);
                    await ctx.reply(MESSAGES.STATUS_NOT_LINKED);
            return;
        }
            } catch (e: any) {
                logger.error(
                    { 
                        message: e.message, 
                        method: e.config?.method, 
                        url: e.config?.url, 
                        status: e.response?.status, 
                        responseData: e.response?.data, 
                        stack: e.stack, 
                        telegramId 
                    },
                    '[BOT] Status (ABT): Error checking for active backend task:'
                );
                // Fall through to standard display using main API data if this check fails
            }
        }

        // --- Block 4: Standard Status Display Logic (using data from main API) ---
        //logger.debug({ telegramId }, `[BOT] Status (SSD): Preparing to display status for ${telegramId} using main API data.`);
        
        if (!isLinked) { // Should have been caught by ABT if no active task
            await ctx.reply(MESSAGES.STATUS_NOT_LINKED);
            return;
        }

        let statusMsg;
        let replyOptions: any = { parse_mode: 'Markdown' };

        if (proofed && hasNFT) {
            statusMsg = MESSAGES.STATUS_LINKED_PROOFED_NFT_YES(apiWallet || 'Error: Wallet N/A', balance);
        } else if (proofed && !hasNFT) {
            statusMsg = MESSAGES.STATUS_LINKED_PROOFED_NFT_NO(apiWallet || 'Error: Wallet N/A');
            replyOptions.disable_web_page_preview = true;
        } else if (!proofed) { // isLinked is true here
            statusMsg = MESSAGES.STATUS_LINKED_NOT_PROOFED(apiWallet || 'Error: Wallet N/A');
        } else {
            // Fallback, should ideally not be reached if logic above is correct
            statusMsg = MESSAGES.STATUS_NOT_LINKED;
            logger.warn({ telegramId }, `[BOT] Status (SSD): Reached unexpected fallback for ${telegramId}. Data: ${JSON.stringify(statusData)}`);
        }
        
        //logger.debug({ telegramId }, `[BOT] Status (SSD): Replying with final status for ${telegramId}:`);
        await ctx.reply(statusMsg, replyOptions);

    } catch (e: any) {
        logger.error(
            { 
                message: e.message, 
                method: e.config?.method, 
                url: e.config?.url, 
                status: e.response?.status, 
                responseData: e.response?.data, 
                stack: e.stack, 
                telegramId 
            },
            `[BOT] Status (MSR CATCH): Error in main /status handling for ${telegramId}:`
        );
        await ctx.reply(MESSAGES.SERVICE_UNAVAILABLE);
    }
};

const handleHelp = (ctx: any) => {
    //logger.debug('Received /help');
    ctx.reply(MESSAGES.HELP_MESSAGE, { parse_mode: 'Markdown' });
};

const handleTerminal = async (ctx: any) => {
    //logger.debug('handleTerminal called');
    const telegramId = ctx.from.id.toString();
    try {
        const apiUrl = process.env.API_URL?.trim();
        if (!apiUrl) {
            logger.error('[BOT] API_URL is not defined for handleTerminal');
            ctx.reply('Configuration error. Please contact support.');
            return;
        }
        const response = await axiosInstance.get(`${apiUrl}/status/${telegramId}`);
        //logger.debug('Status response for terminal access:', response.data);
        const data = response.data;

        if (data.isLinked && data.proofed && data.hasNFT) {
            const webAppUrl = `${API_URL}/terminal?telegramId=${telegramId}`; // This URL should point to where your WebApp is served
            //logger.debug('Opening terminal WebApp URL:', webAppUrl);
            await ctx.reply(
                MESSAGES.TERMINAL_ACCESS_GRANTED,
                Markup.inlineKeyboard([
                    Markup.button.webApp('📲 Open Terminal', webAppUrl)
                ])
            );
        } else if (!data.isLinked) {
            await ctx.reply(MESSAGES.TERMINAL_NO_ACCESS_NOT_LINKED);
        } else if (!data.proofed) {
            // Check if a proof is pending locally
            const currentUserState = userStates[telegramId];
            if (currentUserState?.state === 'awaiting_proof_completion' && currentUserState.wallet) {
                 await ctx.reply(MESSAGES.PROOF_PENDING(currentUserState.wallet) + " Access to terminal will be granted once verified.");
            } else {
                 await ctx.reply(MESSAGES.TERMINAL_NO_ACCESS_NOT_PROOFED);
            }
        } else if (!data.hasNFT) {
            await ctx.reply(MESSAGES.TERMINAL_NO_ACCESS_NO_NFT(NFT_MARKETPLACE_NAME, NFT_MARKETPLACE_URL), { parse_mode: 'Markdown', disable_web_page_preview: true });
        } else {
            await ctx.reply('Cannot grant terminal access at this time. Please check your /status.');
        }
    } catch (e: any) {
        logger.error(
            { 
                message: e.message, 
                method: e.config?.method, 
                url: e.config?.url, 
                status: e.response?.status, 
                responseData: e.response?.data, 
                stack: e.stack, 
                telegramId 
            },
            '[BOT] Terminal access error:'
        );
        await ctx.reply('Service unavailable while trying to open terminal. Try again later.');
    }
};

bot.command('restart', handleRestart);
bot.hears('/restart', handleRestart);
bot.command('unlink', handleUnlink);
bot.hears('/unlink', handleUnlink);
bot.command('status', handleStatus);
bot.hears('/status', handleStatus);
bot.command('help', handleHelp);
bot.hears('/help', handleHelp);
bot.command('terminal', checkNFTOwnership, handleTerminal);
bot.hears('/terminal', checkNFTOwnership, handleTerminal);
bot.hears('🖥️ /terminal', checkNFTOwnership, handleTerminal);
bot.hears(/\/terminal/, checkNFTOwnership, handleTerminal);
bot.hears('📊 /status', handleStatus);
bot.hears('❓ /help', handleHelp);
bot.hears('❌ /unlink', handleUnlink);
bot.hears('🔄 /restart', handleRestart);

process.on('uncaughtException', (error: any) => {
    logger.error('[BOT] Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason: any, promise: any) => {
    logger.error('[BOT] Unhandled Rejection at:', promise, 'reason:', reason);
});

bot.launch().then(() => {
    //logger.info('[BOT] Telegram bot launched successfully.');
}).catch(err => {
    logger.error('[BOT] Error launching Telegram bot:', err);
});

async function initiateProofWithBackend(ctx: any, telegramId: string, wallet: string) {
    //logger.debug(`[BOT] Initiating proof with backend for ${telegramId}, wallet ${wallet}`);
    const afterTimestamp = Math.floor(Date.now() / 1000);
    // It's good practice to also store the messageId of the instructions, so we can edit it later if needed (e.g., to show timeout)
    let instructionMessage;

    try {
        const apiUrl = process.env.API_URL?.trim();
        if (!apiUrl || !CHECK_ADDRESS) {
            logger.error('[BOT] API_URL or CHECK_ADDRESS is not defined for initiateProofWithBackend');
            await ctx.reply(MESSAGES.CONFIG_ERROR);
            // Reset state to allow user to try again or contact support
            userStates[telegramId] = { state: 'awaiting_wallet' }; 
            return;
        }

        //logger.debug(`[BOT] Calling API (${apiUrl}/api/v1/proof/initiate) for ${telegramId}, wallet: ${wallet}, after: ${afterTimestamp}`);
        const response = await axiosInstance.post(`${apiUrl}/api/v1/proof/initiate`, {
            telegramId: telegramId.toString(),
            wallet: wallet,
            afterTimestamp: afterTimestamp
        });

        if (response.data && response.data.taskUid) {
            const taskUid = response.data.taskUid;
            const deadlineMinutes = response.data.deadlineMinutes || PROOF_TASK_DEADLINE_MINUTES; // Use constant

            //logger.debug(`[BOT] Proof initiated successfully. Task UID: ${taskUid} for wallet ${wallet}. Deadline: ${deadlineMinutes} mins.`);
            
            instructionMessage = await ctx.reply(
                MESSAGES.CHECK_INSTRUCTIONS(CHECK_ADDRESS, wallet, deadlineMinutes),
                { parse_mode: 'Markdown' }
            );
            
            await ctx.reply(
                MESSAGES.PROOF_INITIATED(wallet, taskUid),
                { parse_mode: 'Markdown' }
            );

            userStates[telegramId] = { 
                state: 'awaiting_proof_completion', 
                wallet: wallet, 
                taskUid: taskUid,
                messageId: instructionMessage ? instructionMessage.message_id : undefined
            };            

            // Start polling for this task
            pollProofStatus(ctx, telegramId, wallet, taskUid);
        } else {
            logger.error('[BOT] Failed to initiate proof: No taskUid in response', response.data);
            await ctx.reply(MESSAGES.PROOF_INITIATION_FAILED);
            userStates[telegramId] = { state: 'awaiting_wallet' };
        }
    } catch (error: any) {
        logger.error(
            { 
                message: error.message, 
                method: error.config?.method, 
                url: error.config?.url, 
                status: error.response?.status, 
                responseData: error.response?.data, 
                stack: error.stack, 
                telegramId, 
                wallet 
            },
            '[BOT] API error initiating proof:'
        );
        await ctx.reply(MESSAGES.PROOF_INITIATION_FAILED);
        // Reset state to allow user to try linking again
        if (userStates[telegramId] && userStates[telegramId].state !== 'awaiting_wallet') {
             userStates[telegramId] = { state: 'awaiting_wallet' }; // Or delete userStates[telegramId] if preferred
        }
    }
}

// Constants for polling behavior
const POLLING_INTERVAL_MS = 10000; // 10 seconds
const MAX_POLLING_DURATION_MS = 15 * 60 * 1000; // 15 minutes

async function pollProofStatus(ctx: Context, telegramId: string, wallet: string, taskUid: string, startTimeMs: number = Date.now()) {
    //logger.debug({ telegramId, taskUid }, `[BOT] Starting pollProofStatus`);

    let isПерваяПроверка = true;
    let stopPollingSignalReceived = false;

    activePollingStopSignals[telegramId] = () => {
        stopPollingSignalReceived = true;
        logger.info({ telegramId }, `[BOT] Stop signal received for poll task ${taskUid} (user ${telegramId})`);
    };

    const checkStatus = async () => {
        if (stopPollingSignalReceived) {
            logger.info({ telegramId }, `[BOT] Halting poll for ${taskUid} (user ${telegramId}) due to external stop signal.`);
            if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
            delete activePollingTimeouts[telegramId];
            delete activePollingStopSignals[telegramId];
            return;
        }

        if (Date.now() - startTimeMs > MAX_POLLING_DURATION_MS) {
            logger.warn({ telegramId, taskUid }, `[BOT] Max polling duration reached for task ${taskUid} (user ${telegramId}). Stopping poll.`);
            const finalCurrentUserState = userStates[telegramId];
            if (finalCurrentUserState?.taskUid === taskUid) {
                delete userStates[telegramId];
                 try {
                    await ctx.reply(MESSAGES.POLLING_STOPPED_MAX_ATTEMPTS);
                    // if (finalCurrentUserState.messageId && ctx.chat?.id) {
                    //    await ctx.telegram.editMessageText(ctx.chat.id, finalCurrentUserState.messageId, undefined, MESSAGES.PROOF_EXPIRED_TASK(wallet) + " (Max polling time reached)", {}).catch(e => console.warn('[BOT] Failed to edit original message on max poll time: ' + e.message));
                    // }
                } catch (e: any) {
                    logger.error({ err: e }, '[BOT] Error replying on max polling duration:');
                }
            }
            if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
            delete activePollingTimeouts[telegramId];
            delete activePollingStopSignals[telegramId];
            return;
        }

        try {
            const response = await axiosInstance.get(`${API_URL}/api/v1/proof/status/${taskUid}`);
            const taskData = response.data;
            const currentUserState = userStates[telegramId];

            if (!currentUserState || currentUserState.taskUid !== taskUid) {
                logger.info({ telegramId, taskUid }, `[BOT] Poll for task ${taskUid} (user ${telegramId}) found that local user state changed or taskUid mismatch. Stopping poll.`);
                if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
                delete activePollingTimeouts[telegramId];
                delete activePollingStopSignals[telegramId];
                return;
            }
            
            let statusMessage = "";

            switch (taskData.status.toUpperCase()) {
                case 'PENDING':
                    statusMessage = MESSAGES.PROOF_PENDING(wallet);
                    activePollingTimeouts[telegramId] = setTimeout(checkStatus, POLLING_INTERVAL_MS);
                    break;
                case 'PROCESSING':
                    statusMessage = MESSAGES.PROOF_STILL_PROCESSING_POLL(wallet);
                    activePollingTimeouts[telegramId] = setTimeout(checkStatus, POLLING_INTERVAL_MS);
                    break;
                case 'SUCCESS':
                    logger.info({ telegramId, taskUid }, `[BOT] PollProofStatus: Task ${taskUid} (user ${telegramId}) received SUCCESS state.`);
                    delete userStates[telegramId];
                    //logger.debug(`[BOT] PollProofStatus: Attempting to send PROOF_SUCCESS message for wallet ${wallet}.`);
                    await ctx.reply(MESSAGES.PROOF_SUCCESS(wallet));
                    //logger.debug(`[BOT] PollProofStatus: PROOF_SUCCESS message sent for wallet ${wallet}.`);
                    if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
                    delete activePollingTimeouts[telegramId];
                    delete activePollingStopSignals[telegramId];
                    
                    await handleStatus(ctx);
                    break;
                case 'FAILED_NO_TX':
                case 'EXPIRED':
                case 'ERROR':
                    logger.info({ telegramId, taskUid }, `[BOT] PollProofStatus: Task ${taskUid} (user ${telegramId}) failed or expired. Status: ${taskData.status}`);
                    delete userStates[telegramId];
                    const failureMessage = taskData.status === 'EXPIRED' ? MESSAGES.PROOF_EXPIRED_TASK(wallet) :
                                         taskData.status === 'ERROR' ? MESSAGES.PROOF_ERROR(wallet, taskData.error_message) :
                                         MESSAGES.PROOF_FAILED_NO_TX(wallet);
                    await ctx.reply(failureMessage);
                    if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
                    delete activePollingTimeouts[telegramId];
                    delete activePollingStopSignals[telegramId];
                    break;
                default:
                    logger.warn({ telegramId, status: taskData.status }, `[BOT] Unknown task status for ${taskUid}:`);
                    activePollingTimeouts[telegramId] = setTimeout(checkStatus, POLLING_INTERVAL_MS * 2);
            }
        } catch (error: any) {
            logger.error(
                { 
                    message: error.message, 
                    method: error.config?.method, 
                    url: error.config?.url, 
                    status: error.response?.status, 
                    responseData: error.response?.data, 
                    stack: error.stack, 
                    telegramId, 
                    taskUid 
                },
                `[BOT] Error polling status for task ${taskUid} (user ${telegramId}): `
            );
            const currentUserState = userStates[telegramId];
            if (!currentUserState || currentUserState.taskUid !== taskUid) {
                logger.info({ telegramId, taskUid }, `[BOT] Poll for task ${taskUid} found user state changed or taskUid mismatch after error. Stopping poll.`);
                if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
                delete activePollingTimeouts[telegramId];
                delete activePollingStopSignals[telegramId];
                return;
            }
            if (Date.now() - startTimeMs < MAX_POLLING_DURATION_MS - POLLING_INTERVAL_MS) { 
                 activePollingTimeouts[telegramId] = setTimeout(checkStatus, POLLING_INTERVAL_MS); 
            } else {
                logger.info({ telegramId }, `[BOT] Max polling duration reached for task ${taskUid} after error. Stopping poll.`);
                delete userStates[telegramId]; 
                await ctx.reply(MESSAGES.PROOF_ERROR(wallet, "Polling failed due to repeated errors.")).catch(e => {});
                if (activePollingTimeouts[telegramId]) clearTimeout(activePollingTimeouts[telegramId]);
                delete activePollingTimeouts[telegramId];
                delete activePollingStopSignals[telegramId];
            }
        }
    };

    await checkStatus();
}

// Fallback for unknown commands
bot.on('message', (ctx: any) => {
    // logger.debug({ userId: ctx.from.id, message: ctx.message }, `[BOT] Fallback handler: Received unhandled message`);
    // Check if the message is a text message and not a command being processed by other handlers
    if (ctx.message && 'text' in ctx.message && !isCommand(ctx.message.text)) {
        // If it's not a recognized command and not part of a state machine flow already handled,
        // it might be an unknown command or just casual text.
        // The `bot.on('text', ...)` handler above should catch text inputs for state machines.
        // This is a final fallback.
        ctx.reply(MESSAGES.COMMAND_UNKNOWN);
    }
    // If it's a command but not caught by specific handlers, Telegraf might have already processed it or it's truly unknown.
    // If it's not text (e.g., sticker, photo), we can ignore or reply with a generic message.
});

// Error handling
bot.catch((err: any, ctx: any) => {
    if (err.isAxiosError) {
        logger.error(
            { 
                message: err.message, 
                method: err.config?.method, 
                url: err.config?.url, 
                status: err.response?.status, 
                responseData: err.response?.data, 
                stack: err.stack,
                updateType: ctx.updateType,
                update: ctx.update?.message?.text || ctx.update?.callback_query?.data || 'N/A'
            },
            `[BOT] Axios error in global handler`
        );
    } else {
        logger.error({ err, updateType: ctx.updateType, update: ctx.update }, `[BOT] Ooops, encountered an error`);
    }

    // More specific error handling based on err.description or err.code for Telegram API errors
    if (err.response && err.response.description && !err.isAxiosError) { // check !isAxiosError to avoid double logging for Telegram API errors coming via Axios
        logger.error({ description: err.response.description, errorCode: err.response.error_code }, `[BOT] Telegram API Error`);
        if (err.response.error_code === 403) { // Forbidden: bot was blocked by the user
            logger.warn({ userId: ctx.from?.id, updateType: ctx.updateType }, `[BOT] User may have blocked the bot.`);
            // Potentially mark user as inactive in DB here if applicable for bulk messaging features
        } else if (err.response.error_code === 429) { // Too Many Requests
            logger.warn({ updateType: ctx.updateType }, `[BOT] Rate limit hit with Telegram API. Check bot's sending rate.`);
            // Implement retry logic with backoff if this happens frequently
        }
    }

    // Generic reply to user
    try {
        ctx.reply(MESSAGES.GENERAL_ERROR).catch((replyError: any) => {
            logger.error({ err: replyError }, '[BOT] Failed to send generic error message to user:');
        });
    } catch (e) {
        logger.error({ err: e }, '[BOT] Further error trying to reply with GENERAL_ERROR:');
    }
});

export { bot, MESSAGES, userStates, activePollingTimeouts, activePollingStopSignals, stopPolling };