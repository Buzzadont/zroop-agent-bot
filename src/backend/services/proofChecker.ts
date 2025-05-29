/**
 * Service for verifying wallet ownership through proof transactions
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import axios, { AxiosResponse } from 'axios';
import logger from '../../shared/utils/logger'; // Import logger
import { CHECK_WALLET, PROOF_CHECK_INTERVAL_MS, PROOF_RETRY_LIMIT, MAX_API_CALL_ATTEMPTS } from '../../shared/utils/constants'; // Added MAX_API_CALL_ATTEMPTS

dotenv.config();

// Environment variables
const FORMA_RPC = process.env.FORMA_RPC || 'https://rpc.forma.art';
const BLOCKS_TO_CHECK = Number(process.env.BLOCKS_TO_CHECK) || 1000;
const BLOCK_TIME = 2; // ~2 seconds per block on Forma
const FORMA_EXPLORER_GRAPHQL_URL = process.env.FORMA_EXPLORER_GRAPHQL_URL || 'https://explorer.forma.art/api/v1/graphql'; // Corrected URL from graphiql to graphql

// Export provider for tests
export const provider = new ethers.JsonRpcProvider(FORMA_RPC);

const isValidEvmAddress = (addr: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(addr);

const humanTime = (ts: number): string => new Date(ts * 1000).toLocaleString();

// Helper function for delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Define ProofResult interface used by checkOwnershipAfter
export interface ProofResult { // Added export to make it available for ProofVerificationService if needed, though it primarily uses it internally now.
    isProofConfirmed: boolean;
    txHash: string | null;
    error?: string; 
}

async function getBlockNumberFromTimestamp(timestamp: number, currentBlockNumber: number): Promise<number> {
    // const currentBlock = await provider.getBlockNumber(); // Already fetched
    const latestBlock = await provider.getBlock(currentBlockNumber);
    if (!latestBlock) {
        logger.error({ currentBlockNumber }, "[proofChecker] Could not get latest block data in getBlockNumberFromTimestamp");
        throw new Error('Could not get latest block data');
    }
    if (typeof latestBlock.timestamp !== 'number') {
        logger.error({ currentBlockNumber, latestBlock }, "[proofChecker] Latest block data does not contain a valid timestamp in getBlockNumberFromTimestamp");
        throw new Error('Latest block data does not contain a valid timestamp');
    }
    
    // Calculate approximate block number based on timestamp difference
    const timeDiff = latestBlock.timestamp - timestamp;
    const blockDiff = Math.floor(timeDiff / BLOCK_TIME);
    
    const calculatedStartBlock = Math.max(0, currentBlockNumber - blockDiff);
    // Ensure we don't go further back than BLOCKS_TO_CHECK from current block, if BLOCKS_TO_CHECK is positive
    if (BLOCKS_TO_CHECK > 0) {
        return Math.max(currentBlockNumber - BLOCKS_TO_CHECK + 1, calculatedStartBlock);
    }
    return calculatedStartBlock;
}

interface ProofTransaction {
    hash: string;
    from: string;
    to: string;
    blockNumber: number;
    timestamp: number; // Unix timestamp in seconds
}

// Define a more specific type for the GraphQL response data if possible, or use any
interface GraphQLResponseData {
    data?: {
        address?: {
            hash?: string;
            transactions?: {
                edges?: Array<{
                    node?: {
                        hash: string;
                        fromAddressHash: string;
                        toAddressHash: string;
                        value: string;
                        gasUsed: string;
                        status: string;
                        block?: { // Optional: block with timestamp
                            timestamp: string;
                        };
                        blockNumber: number; // Always expected, fallback relies on this
                        earliestProcessingStart?: string | null;
                    };
                }>;
                pageInfo?: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
            };
        };
        block?: { // For getTimestampForBlockGraphQL
            timestamp: string;
        }
    };
    errors?: Array<{ message: string; [key: string]: any }>; // More specific errors
}

async function getTimestampForBlockGraphQL(blockNumber: number): Promise<number | null> {
    const query = `query GetBlockTimestamp($blockNumber: Int!) { block(number: $blockNumber) { timestamp } }`;
    const variables = { blockNumber };
    let currentAttempt = 0;

    logger.debug({ blockNumber }, "[proofChecker] getTimestampForBlockGraphQL: Fetching timestamp.");

    while (currentAttempt < MAX_API_CALL_ATTEMPTS) {
        currentAttempt++;
        try {
            const response = await axios.post<GraphQLResponseData>(
                FORMA_EXPLORER_GRAPHQL_URL!,
                { query, variables }
            );

            if (response.data?.errors && response.data.errors.length > 0) {
                logger.error({ blockNumber, errors: response.data.errors, attempt: currentAttempt }, "[proofChecker] getTimestampForBlockGraphQL: GraphQL error.");
                // Check if this error is retryable or fatal for this specific call
                const isInternalError = response.data.errors.some(err => err.message?.toLowerCase().includes("internal server error"));
                if (isInternalError && currentAttempt >= MAX_API_CALL_ATTEMPTS) {
                    return null; // Fatal after retries for internal server error
                }
            } else if (response.data?.data?.block?.timestamp) {
                const timestampStr = response.data.data.block.timestamp;
                const timestampSeconds = Math.floor(new Date(timestampStr).getTime() / 1000);
                logger.debug({ blockNumber, timestamp: humanTime(timestampSeconds) }, "[proofChecker] getTimestampForBlockGraphQL: Timestamp fetched successfully.");
                return timestampSeconds;
            } else {
                 logger.warn({ blockNumber, responseData: response.data, attempt: currentAttempt }, "[proofChecker] getTimestampForBlockGraphQL: No timestamp in response or unexpected structure.");
            }
        } catch (error: any) {
            logger.error({
                err: error.message,
                status: error.response?.status,
                responseData: error.response?.data,
                blockNumber,
                attempt: currentAttempt
            }, "[proofChecker] getTimestampForBlockGraphQL: HTTP error.");
            if (error.response?.status === 500 && currentAttempt >= MAX_API_CALL_ATTEMPTS) {
                return null; // Fatal after retries for HTTP 500
            }
        }
        
        if (currentAttempt < MAX_API_CALL_ATTEMPTS) {
            const delayMs = Math.pow(2, currentAttempt - 1) * 1000 * (1 + Math.random() * 0.5) ; // Exponential backoff with jitter
            logger.info(`[proofChecker] getTimestampForBlockGraphQL: Retrying for block ${blockNumber} in ${delayMs.toFixed(0)}ms... (Attempt ${currentAttempt}/${MAX_API_CALL_ATTEMPTS})`);
            await delay(delayMs);
        }
    }
    logger.error({ blockNumber }, "[proofChecker] getTimestampForBlockGraphQL: Failed to fetch timestamp after max attempts.");
    return null;
}

async function findProofTransactionGraphQL(
    userWallet: string,
    targetWallet: string,
    afterTimestamp: number,
    deadlineTimestamp: number
): Promise<ProofTransaction | null> {
    const userWalletLower = userWallet.toLowerCase();
    const targetWalletLower = targetWallet.toLowerCase();
    let nextCursor: string | null = null;
    let transactionsChecked = 0;
    const MAX_TRANSACTIONS_TO_CHECK_PER_USER = 100;
    let proofFound = false;
    let result: ProofTransaction | null = null;
    let currentTxNumber = 0; // Tracks total transactions checked across all pages

    logger.debug({ userWallet, targetWallet, afterTimestamp: humanTime(afterTimestamp), deadlineTimestamp: humanTime(deadlineTimestamp) }, "[proofChecker] findProofTransactionGraphQL: Initiating search.");

    // Explicitly define types for variables that were causing linter errors
    interface QueryVariables {
        userAddress: string;
        afterCursor: string | null;
    }

    do {
        logger.debug({ cursor: nextCursor }, `[proofChecker] findProofTransactionGraphQL: Loop iteration.`); 
        
        let responseData: GraphQLResponseData | null = null;
        let useFallbackQuery = false;
        
        // --- Attempt 1: Primary query with block { timestamp } ---
        const primaryQuery = 'query GetUserAddressTransactions($userAddress: AddressHash!, $afterCursor: String) { address(hash: $userAddress) { hash transactions(first: 10, after: $afterCursor) { edges { node { hash fromAddressHash toAddressHash value gasUsed status block { timestamp } blockNumber earliestProcessingStart } } pageInfo { hasNextPage endCursor } } } }';
        const variables: QueryVariables = { userAddress: userWalletLower, afterCursor: nextCursor };
        
        let currentApiCallAttemptPrimary = 0;
        while (currentApiCallAttemptPrimary < MAX_API_CALL_ATTEMPTS && !responseData) {
            currentApiCallAttemptPrimary++;
            try {
                logger.debug(`[proofChecker] findProofTransactionGraphQL: Attempting primary query (attempt ${currentApiCallAttemptPrimary}/${MAX_API_CALL_ATTEMPTS}) for cursor: ${nextCursor === null ? 'null (first page)' : nextCursor}`);
                const response: AxiosResponse<GraphQLResponseData> = await axios.post<GraphQLResponseData>(FORMA_EXPLORER_GRAPHQL_URL!, { query: primaryQuery, variables });
                
                if (response.data?.errors && response.data.errors.length > 0) {
                    const isInternalError = response.data.errors.some(err => err.message?.toLowerCase().includes("internal server error"));
                    if (isInternalError) {
                        logger.warn(`[proofChecker] findProofTransactionGraphQL: Primary query failed with GraphQL internal server error (attempt ${currentApiCallAttemptPrimary}). Triggering fallback.`, { errors: response.data.errors });
                        useFallbackQuery = true;
                        break; 
                    } else {
                         logger.error(`[proofChecker] findProofTransactionGraphQL: Primary query failed with GraphQL errors (attempt ${currentApiCallAttemptPrimary}):`, { errors: response.data.errors });
                    }
                } else if (response.data?.data?.address?.transactions?.edges) {
                    responseData = response.data;
                    logger.debug(`[proofChecker] findProofTransactionGraphQL: Primary query successful (attempt ${currentApiCallAttemptPrimary}).`);
                    break; 
                } else {
                    logger.warn(`[proofChecker] findProofTransactionGraphQL: Primary query returned no data or unexpected structure (attempt ${currentApiCallAttemptPrimary}).`, { responseData: response.data });
                }
            } catch (error: any) {
                logger.error({
                    err: error.message,
                    status: error.response?.status,
                    responseData: error.response?.data,
                    url: FORMA_EXPLORER_GRAPHQL_URL,
                    attempt: currentApiCallAttemptPrimary,
                    maxAttempts: MAX_API_CALL_ATTEMPTS
                }, '[proofChecker] findProofTransactionGraphQL: Primary GraphQL request HTTP error:');
                if (error.response?.status === 500) {
                    logger.warn(`[proofChecker] findProofTransactionGraphQL: Primary query failed with HTTP 500 (attempt ${currentApiCallAttemptPrimary}). Triggering fallback.`);
                    useFallbackQuery = true;
                    break;
                }
            }

            if (useFallbackQuery) break; // Exit primary attempt loop if fallback is triggered

            if (currentApiCallAttemptPrimary < MAX_API_CALL_ATTEMPTS && !responseData) {
                const delayMs = Math.pow(2, currentApiCallAttemptPrimary -1) * 1000 * (1 + Math.random() * 0.5);
                logger.info(`[proofChecker] findProofTransactionGraphQL: Retrying primary API call in ${delayMs.toFixed(0)}ms... (Attempt ${currentApiCallAttemptPrimary +1}/${MAX_API_CALL_ATTEMPTS})`);
                await delay(delayMs);
            }
        }

        if (currentApiCallAttemptPrimary >= MAX_API_CALL_ATTEMPTS && !responseData && !useFallbackQuery) {
            logger.error("[proofChecker] findProofTransactionGraphQL: Max API call attempts reached for primary query. Giving up on this page.");
            return null; 
        }

        // --- Attempt 2: Fallback query with blockNumber only (if primary failed specifically) ---
        if (useFallbackQuery) {
            const fallbackQuery = 'query GetUserAddressTransactionsBlockNumber($userAddress: AddressHash!, $afterCursor: String) { address(hash: $userAddress) { hash transactions(first: 10, after: $afterCursor) { edges { node { hash fromAddressHash toAddressHash value gasUsed status blockNumber earliestProcessingStart } } pageInfo { hasNextPage endCursor } } } }';
            let currentApiCallAttemptFallback = 0;
            responseData = null; // Reset for fallback

            while (currentApiCallAttemptFallback < MAX_API_CALL_ATTEMPTS && !responseData) {
                currentApiCallAttemptFallback++;
                try {
                    logger.debug(`[proofChecker] findProofTransactionGraphQL: Attempting fallback query (attempt ${currentApiCallAttemptFallback}/${MAX_API_CALL_ATTEMPTS}) for cursor: ${nextCursor === null ? 'null (first page)' : nextCursor}`);
                    const response: AxiosResponse<GraphQLResponseData> = await axios.post<GraphQLResponseData>(FORMA_EXPLORER_GRAPHQL_URL!, { query: fallbackQuery, variables }); // variables are the same
                     if (response.data?.errors && response.data.errors.length > 0) {
                        logger.error(`[proofChecker] findProofTransactionGraphQL: Fallback query failed with GraphQL errors (attempt ${currentApiCallAttemptFallback}):`, { errors: response.data.errors });
                    } else if (response.data?.data?.address?.transactions?.edges) {
                        responseData = response.data;
                        logger.debug(`[proofChecker] findProofTransactionGraphQL: Fallback query successful (attempt ${currentApiCallAttemptFallback}).`);
                        break;
                    } else {
                        logger.warn(`[proofChecker] findProofTransactionGraphQL: Fallback query returned no data or unexpected structure (attempt ${currentApiCallAttemptFallback}).`, { responseData: response.data });
                    }
                } catch (error: any) {
                    logger.error({
                        err: error.message,
                        status: error.response?.status,
                        responseData: error.response?.data,
                        attempt: currentApiCallAttemptFallback,
                        maxAttempts: MAX_API_CALL_ATTEMPTS
                    }, '[proofChecker] findProofTransactionGraphQL: Fallback GraphQL request HTTP error:');
                }
                if (currentApiCallAttemptFallback < MAX_API_CALL_ATTEMPTS && !responseData) {
                    const delayMs = Math.pow(2, currentApiCallAttemptFallback -1) * 1000 * (1 + Math.random() * 0.5);
                    logger.info(`[proofChecker] findProofTransactionGraphQL: Retrying fallback API call in ${delayMs.toFixed(0)}ms... (Attempt ${currentApiCallAttemptFallback + 1}/${MAX_API_CALL_ATTEMPTS})`);
                    await delay(delayMs);
                }
            }
            if (currentApiCallAttemptFallback >= MAX_API_CALL_ATTEMPTS && !responseData) {
                logger.error("[proofChecker] findProofTransactionGraphQL: Max API call attempts reached for fallback query. Giving up on this page.");
                return null; 
            }
        }
        
        // --- Process transactions from responseData (either primary or fallback) ---
        if (!responseData?.data?.address?.transactions?.edges) {
            logger.debug('[proofChecker] findProofTransactionGraphQL: No transactions found or unexpected GraphQL response structure after all attempts for this page.');
            // If nextCursor is null here, it means we are done. If not, the outer loop will break if proofFound.
            // If no transactions on the first page, this will correctly return null eventually.
             if (!nextCursor) return null; // No transactions on first page and no subsequent pages.
             else break; // No transactions on this page, but there might be more.
        }

        const edges = responseData.data.address.transactions.edges;
        const pageInfo: { hasNextPage: boolean; endCursor: string | null } | undefined = responseData.data.address.transactions.pageInfo;

        logger.debug({ batchSize: edges.length, pageInfo, useFallbackQuery }, `[proofChecker] findProofTransactionGraphQL: Received response to process.`);

        for (const edge of edges) {
            if (!edge?.node) {
                logger.debug('[proofChecker] findProofTransactionGraphQL: Edge or node is null, skipping.');
                continue;
            }
            const txNode = edge.node;
            currentTxNumber++;
            logger.debug({ txNum: currentTxNumber, txHash: txNode.hash }, `[proofChecker] findProofTransactionGraphQL: Checking Tx.`);
            
            let blockTimestampSeconds: number | null = null;

            if (useFallbackQuery) {
                if (txNode.blockNumber === null || txNode.blockNumber === undefined) { // Ensure blockNumber is present
                    logger.warn({ txHash: txNode.hash }, "[proofChecker] findProofTransactionGraphQL: Fallback path - transaction node missing blockNumber. Skipping.");
                    continue;
                }
                logger.debug({txHash: txNode.hash, blockNumber: txNode.blockNumber}, "[proofChecker] findProofTransactionGraphQL: Fallback path - fetching timestamp for block.");
                const fetchedTimestamp = await getTimestampForBlockGraphQL(txNode.blockNumber);
                if (fetchedTimestamp === null) {
                    logger.warn({ txHash: txNode.hash, blockNumber: txNode.blockNumber }, "[proofChecker] findProofTransactionGraphQL: Fallback path - failed to fetch timestamp for block. Skipping tx.");
                    continue; 
                }
                blockTimestampSeconds = fetchedTimestamp;
            } else {
                // Primary path: timestamp should be in txNode.block.timestamp
                if (!txNode.block || !txNode.block.timestamp) {
                     logger.warn({ txHash: txNode.hash }, "[proofChecker] findProofTransactionGraphQL: Primary path - transaction node missing block or block.timestamp. Skipping.");
                     continue;
                }
                blockTimestampSeconds = Math.floor(new Date(txNode.block.timestamp).getTime() / 1000);
            }
            
            // Ensure blockTimestampSeconds is not null before proceeding
            if (blockTimestampSeconds === null) {
                logger.warn({ txHash: txNode.hash }, "[proofChecker] findProofTransactionGraphQL: blockTimestampSeconds is null after attempting to fetch/parse. Skipping tx.");
                continue;
            }

            logger.debug({ 
                from: txNode.fromAddressHash, 
                to: txNode.toAddressHash, 
                status: txNode.status, 
                value: txNode.value, 
                txTimestamp: humanTime(blockTimestampSeconds), 
                earliestProcessingStart: txNode.earliestProcessingStart ? humanTime(new Date(txNode.earliestProcessingStart).getTime()/1000) : 'N/A'
            }, `[proofChecker] Tx Details:`);

            const toAddressLower = txNode.toAddressHash?.toLowerCase();
            const fromAddressLower = txNode.fromAddressHash?.toLowerCase();

            const isToCorrect = toAddressLower === targetWalletLower;
            const isFromCorrect = fromAddressLower === userWalletLower;
            const isStatusOk = txNode.status === 'OK';
            
            // Value check is removed - any amount is acceptable

            const isAfterTimestamp = blockTimestampSeconds >= afterTimestamp;
            const isBeforeDeadline = blockTimestampSeconds < deadlineTimestamp;

            logger.debug({
                isToCorrect, isFromCorrect, isStatusOk, 
                isAfterTimestamp, isBeforeDeadline,
                txFrom: fromAddressLower, userWalletLower, txTo: toAddressLower, targetWalletLower,
                txTime: humanTime(blockTimestampSeconds), afterTime: humanTime(afterTimestamp), deadlineTime: humanTime(deadlineTimestamp),
                originalValue: txNode.value // log original value for clarity
            }, `[proofChecker] findProofTransactionGraphQL: Criteria check`);

            if (isFromCorrect && isToCorrect && isStatusOk && isAfterTimestamp && isBeforeDeadline) {
                logger.info({ txHash: txNode.hash, userWallet }, '[proofChecker] findProofTransactionGraphQL: SUCCESS! Found matching transaction (any amount).');
                result = {
                    hash: txNode.hash,
                    from: txNode.fromAddressHash,
                    to: txNode.toAddressHash,
                    blockNumber: txNode.blockNumber, // blockNumber is available in both primary and fallback node types
                    timestamp: blockTimestampSeconds,
                };
                proofFound = true;
                break; 
            } else {
                logger.debug({ txHash: txNode.hash }, `[proofChecker] findProofTransactionGraphQL: Tx did not match all criteria.`);
            }
        }

        if (proofFound) {
            break; 
        }

        if (pageInfo?.hasNextPage && pageInfo.endCursor) { // Ensure endCursor is not null
            nextCursor = pageInfo.endCursor;
            // Optimization: If the oldest transaction on this page is already older than our 'afterTimestamp', stop.
            // This check needs to be careful if using fallback as timestamps are fetched one by one.
            // For simplicity with fallback, we might rely more on the deadlineTimestamp check or number of pages.
            // However, if not using fallback, this optimization is still valid.
            if (!useFallbackQuery && edges.length > 0) {
                const lastTxNodeOnPage = edges[edges.length - 1]?.node;
                if (lastTxNodeOnPage && lastTxNodeOnPage.block && lastTxNodeOnPage.block.timestamp) {
                    const lastTxTimestampOnPage = Math.floor(new Date(lastTxNodeOnPage.block.timestamp).getTime() / 1000);
                    if (lastTxTimestampOnPage < afterTimestamp) {
                        logger.debug({ oldestTxTimeOnPage: humanTime(lastTxTimestampOnPage), afterTimestamp: humanTime(afterTimestamp) }, `[proofChecker] findProofTransactionGraphQL: Oldest transaction on page (primary query) is older than afterTimestamp. Stopping pagination.`);
                        nextCursor = null; // This will terminate the do...while loop
                    }
                }
            }
        } else {
            nextCursor = null;
        }

    } while (nextCursor && !proofFound); // Added !proofFound condition

    if (result) {
        return result;
    }

    logger.debug({ userWallet, targetWallet }, '[proofChecker] findProofTransactionGraphQL: No matching transaction found after checking all relevant transactions.');
    return null;
}

export async function findTransaction(walletHash: string, afterTimestamp: number): Promise<ethers.TransactionResponse | null> {
    const wallet = walletHash.trim().toLowerCase();
    if (!isValidEvmAddress(wallet)) {
        logger.error({ walletHash }, '[proofChecker] findTransaction: Invalid EVM address provided.');
        throw new Error('Invalid EVM address');
    }

    try {
        const currentBlock = await provider.getBlockNumber();
        const startBlock = await getBlockNumberFromTimestamp(afterTimestamp, currentBlock);
        
        logger.debug({ startBlock, currentBlock, wallet, targetWallet: CHECK_WALLET?.toLowerCase() }, '[proofChecker] findTransaction: Searching for tx.');

        // Limit search depth for performance
        const searchDepth = currentBlock - startBlock;
        const effectiveBlocksToCheck = BLOCKS_TO_CHECK > 0 ? Math.min(searchDepth + 1, BLOCKS_TO_CHECK) : searchDepth + 1;
        const actualStartBlock = currentBlock - effectiveBlocksToCheck + 1;

        logger.debug({ actualStartBlock, currentBlock, effectiveBlocksToCheck }, '[proofChecker] findTransaction: Effective search range.');

        for (let i = currentBlock; i >= actualStartBlock; i--) {
            const block = await provider.getBlock(i, true);
            if (!block) {
                logger.warn({ blockNumber: i }, '[proofChecker] findTransaction: Block not found or error fetching. Skipping.');
                continue;
            }

            if (!block.prefetchedTransactions || block.prefetchedTransactions.length === 0) {
                continue;
            }

            for (const tx of block.prefetchedTransactions) {
                 if (
                    tx.from?.toLowerCase() === wallet &&
                    tx.to?.toLowerCase() === CHECK_WALLET?.toLowerCase()
                ) {
                    logger.info({ blockNumber: tx.blockNumber, txHash: tx.hash, from: tx.from, to: tx.to, value: ethers.formatEther(tx.value) }, '[proofChecker] findTransaction: Found matching tx.');
                    return tx;
                }
            }
        }

        logger.debug({ startBlock: actualStartBlock, endBlock: currentBlock, wallet }, '[proofChecker] findTransaction: No matching transactions found.');
        return null;
    } catch (error: any) {
        logger.error({ err: error, walletHash }, '[proofChecker] Error in findTransaction for wallet:');
        return null;
    }
}

export async function checkOwnershipAfter(
    walletHash: string, 
    afterTimestamp: number, 
    deadlineTimestamp: number,
    targetWalletAddress: string
): Promise<ProofResult> {
    const userWallet = walletHash.trim().toLowerCase();
    if (!targetWalletAddress) {
        logger.error('[proofChecker] CRITICAL: targetWalletAddress is not defined in checkOwnershipAfter');
        return { isProofConfirmed: false, error: 'targetWalletAddress is not defined', txHash: null };
    }

    logger.debug({ userWallet, targetWalletAddress, afterTimestamp: humanTime(afterTimestamp), deadlineTimestamp: humanTime(deadlineTimestamp) }, "[proofChecker] checkOwnershipAfter: Initiating check.");

    if (!isValidEvmAddress(userWallet)) {
        logger.warn({ userWallet }, '[proofChecker] Invalid user EVM address in checkOwnershipAfter.');
        return { isProofConfirmed: false, error: 'Invalid user EVM address', txHash: null };
    }
    if (!isValidEvmAddress(targetWalletAddress)) {
        logger.error({ targetWalletAddress }, '[proofChecker] CRITICAL: Invalid targetWalletAddress EVM address provided to checkOwnershipAfter.');
        return { isProofConfirmed: false, error: 'Invalid target wallet address', txHash: null };
    }

    if (afterTimestamp >= deadlineTimestamp) {
        logger.warn({ userWallet, afterTimestamp: humanTime(afterTimestamp), deadlineTimestamp: humanTime(deadlineTimestamp) }, '[proofChecker] Invalid time window in checkOwnershipAfter.');
        return { isProofConfirmed: false, error: 'Invalid time window', txHash: null };
    }

    try {
        const proofTxNode = await findProofTransactionGraphQL(userWallet, targetWalletAddress, afterTimestamp, deadlineTimestamp);

        if (proofTxNode) {
            logger.info({ txHash: proofTxNode.hash, userWallet }, '[proofChecker] checkOwnershipAfter: SUCCESS: Valid tx found via GraphQL.');
            return { isProofConfirmed: true, txHash: proofTxNode.hash };
        } else {
            logger.info({ userWallet }, '[proofChecker] checkOwnershipAfter: No valid proof tx found via GraphQL.');
            return { isProofConfirmed: false, error: 'Proof transaction not found via GraphQL', txHash: null };
        }
    } catch (error: any) {
        logger.error({ err: error, userWallet }, '[proofChecker] checkOwnershipAfter: CRITICAL OVERALL ERROR:');
        return { isProofConfirmed: false, error: 'Overall error in checkOwnershipAfter: ' + error.message, txHash: null };
    }
}

export async function findWalletTransactions(walletHash: string, startBlock: number, endBlock: number): Promise<any[]> {
  const wallet = walletHash.trim().toLowerCase();
  if (!isValidEvmAddress(wallet)) {
    logger.error({ walletHash }, "[proofChecker] findWalletTransactions: Invalid EVM address");
    throw new Error('Invalid EVM address');
  }

  try {
    const logs = await provider.getLogs({
      fromBlock: startBlock,
      toBlock: endBlock,
      topics: [
        null,
        '0x' + wallet.slice(2).padStart(64, '0') // from address
      ]
    });

    const transactions: any[] = [];
    for (const log of logs) {
      const tx = await provider.getTransaction(log.transactionHash);
      if (!tx) continue;

      transactions.push({
        hash: tx.hash,
        blockNumber: tx.blockNumber,
        from: tx.from,
        to: tx.to,
        value: tx.value.toString(),
        timestamp: (await provider.getBlock(tx.blockNumber || 0))?.timestamp || 0
      });
    }

    return transactions;
  } catch (error: any) {
    logger.error({ err: error, walletHash }, '[proofChecker] Error in findWalletTransactions:');
    throw new Error('Failed to find transactions: ' + error.message);
  }
}