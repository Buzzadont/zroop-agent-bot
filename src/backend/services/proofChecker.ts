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
const FORMA_EXPLORER_GRAPHQL_URL = process.env.FORMA_EXPLORER_GRAPHQL_URL || 'https://explorer.forma.art/graphiql';

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
                        block: {
                            timestamp: string; // ISO date string
                        };
                        blockNumber: number;
                        earliestProcessingStart?: string | null;
                    };
                }>;
                pageInfo?: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
            };
        };
    };
    errors?: any[]; // Or a more specific error type
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

    let currentApiCallAttempt = 0;

    do {
        logger.debug({ cursor: nextCursor }, `[proofChecker] findProofTransactionGraphQL: Loop iteration.`); 
        
        const query = 'query GetUserAddressTransactions($userAddress: AddressHash!, $afterCursor: String) { address(hash: $userAddress) { hash transactions(first: 10, after: $afterCursor) { edges { node { hash fromAddressHash toAddressHash value gasUsed status block { timestamp } blockNumber earliestProcessingStart } } pageInfo { hasNextPage endCursor } } } }';
        
        const variables: { userAddress: string; afterCursor: string | null } = { userAddress: userWalletLower, afterCursor: nextCursor };

        let response: AxiosResponse<GraphQLResponseData> | null = null;

        while (currentApiCallAttempt < MAX_API_CALL_ATTEMPTS && !response) {
            currentApiCallAttempt++;
            try {
                response = await axios.post(FORMA_EXPLORER_GRAPHQL_URL!, { query, variables });
            } catch (error: any) {
                logger.error({
                    err: error,
                    url: FORMA_EXPLORER_GRAPHQL_URL,
                    responseData: error.response?.data,
                    attempt: currentApiCallAttempt,
                    maxAttempts: MAX_API_CALL_ATTEMPTS
                }, '[proofChecker] findProofTransactionGraphQL: GraphQL request error:');
                if (currentApiCallAttempt >= MAX_API_CALL_ATTEMPTS) {
                    logger.error("[proofChecker] findProofTransactionGraphQL: Max API call attempts reached. Giving up on this page.");
                    return null; // Critical error after retries, stop processing for this task
                }
                const delayMs = Math.pow(2, currentApiCallAttempt -1) * 1000; // 1s, 2s, 4s ...
                logger.info(`[proofChecker] findProofTransactionGraphQL: Retrying API call in ${delayMs}ms...`);
                await delay(delayMs);
            }
        }

        if (!response) { // Should not happen if logic above is correct, but as a safeguard
            logger.error('[proofChecker] findProofTransactionGraphQL: Response is null after retry loop. This indicates a bug. Returning null.');
            return null;
        }

        const responseData: GraphQLResponseData = response.data;
        logger.debug({ responseData }, '[proofChecker] findProofTransactionGraphQL: Full GraphQL Response (first 100 chars of data):'); // Log snippet

        if (!responseData?.data?.address?.transactions?.edges) {
            logger.debug('[proofChecker] findProofTransactionGraphQL: No transactions found or unexpected GraphQL response structure.');
            return null;
        }

        const edges = responseData.data.address.transactions.edges;
        const pageInfo = responseData.data.address.transactions.pageInfo;

        logger.debug({ batchSize: edges.length, pageInfo }, `[proofChecker] findProofTransactionGraphQL: Received response.`);

        for (const edge of edges) {
            if (!edge?.node) {
                logger.debug('[proofChecker] findProofTransactionGraphQL: Edge or node is null, skipping.');
                continue;
            }
            const txNode = edge.node;
            currentTxNumber++;
            logger.debug({ txNum: currentTxNumber, txHash: txNode.hash }, `[proofChecker] findProofTransactionGraphQL: Checking Tx.`);
            
            const txOriginalTimestamp = txNode.block.timestamp;
            const blockTimestampSeconds = Math.floor(new Date(txOriginalTimestamp).getTime() / 1000);

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
            const isValueZero = txNode.value === '0.0 TIA' || txNode.value === '0' || parseFloat(txNode.value) === 0; 
            const isAfterTimestamp = blockTimestampSeconds >= afterTimestamp;
            const isBeforeDeadline = blockTimestampSeconds < deadlineTimestamp;

            logger.debug({
                isToCorrect, isFromCorrect, isStatusOk, isValueZero, isAfterTimestamp, isBeforeDeadline,
                txFrom: fromAddressLower, userWalletLower, txTo: toAddressLower, targetWalletLower,
                txTime: humanTime(blockTimestampSeconds), afterTime: humanTime(afterTimestamp), deadlineTime: humanTime(deadlineTimestamp)
            }, `[proofChecker] findProofTransactionGraphQL: Criteria check`);

            if (isFromCorrect && isToCorrect && isStatusOk && isValueZero && isAfterTimestamp && isBeforeDeadline) {
                logger.info({ txHash: txNode.hash, userWallet }, `[proofChecker] findProofTransactionGraphQL: SUCCESS! Found matching transaction.`);
                result = {
                    hash: txNode.hash,
                    from: txNode.fromAddressHash,
                    to: txNode.toAddressHash,
                    blockNumber: txNode.blockNumber,
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

        if (pageInfo?.hasNextPage) {
            nextCursor = pageInfo.endCursor;
            // Optimization: If the oldest transaction on this page is already older than our 'afterTimestamp', stop.
            if (edges.length > 0) {
                const lastTxNodeOnPage = edges[edges.length - 1]?.node;
                if (lastTxNodeOnPage) {
                    const lastTxTimestampOnPage = Math.floor(new Date(lastTxNodeOnPage.block.timestamp).getTime() / 1000);
                    if (lastTxTimestampOnPage < afterTimestamp) {
                        logger.debug({ oldestTxTimeOnPage: humanTime(lastTxTimestampOnPage), afterTimestamp: humanTime(afterTimestamp) }, `[proofChecker] findProofTransactionGraphQL: Oldest transaction on page is older than afterTimestamp. Stopping pagination.`);
                        nextCursor = null; // This will terminate the do...while loop
                    }
                }
            }
        } else {
            nextCursor = null;
        }

    } while (nextCursor);

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