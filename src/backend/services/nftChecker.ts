/**
 * Service for checking NFT ownership
 */
import { JsonRpcProvider, Contract, getAddress } from 'ethers';
import dotenv from 'dotenv';
import logger from '../../shared/utils/logger'; // Import logger

// Load environment variables
dotenv.config();

// Constants from environment
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || '';
const FORMA_RPC = process.env.FORMA_RPC || 'https://rpc.forma.art';

// ABI for the balanceOf method of the NFT contract
const NFT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)"
];

/**
 * Checks if the user owns at least one NFT
 * @param walletAddress - Address of the wallet to check
 * @returns true if the user owns at least one NFT
 */
export async function checkNFTOwnership(walletAddress: string): Promise<boolean> {
  try {
    const balance = await getNFTBalance(walletAddress);
    return Number(balance) > 0;
  } catch (error) {
    logger.error({ err: error, walletAddress }, 'Error in checkNFTOwnership:');
    return false; // Return false on error to prevent access
  }
}

/**
 * Gets the NFT balance for a given wallet address
 * @param walletAddress - Address of the wallet to check
 * @returns NFT balance as a string
 */
export async function getNFTBalance(walletAddress: string): Promise<string> {
  if (!NFT_CONTRACT_ADDRESS) {
    // Log error and throw, as this is a critical configuration issue
    logger.error('[NFT CHECKER] NFT_CONTRACT_ADDRESS not defined in environment');
    throw new Error("NFT_CONTRACT_ADDRESS not defined in environment");
  }

  try {
    const normalizedAddress = getAddress(walletAddress.toLowerCase());
    logger.debug({ walletAddress: normalizedAddress }, `[NFT CHECKER] Getting balance for wallet`);

    const provider = new JsonRpcProvider(FORMA_RPC);
    const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);

    const balance = await nftContract.balanceOf(normalizedAddress);
    logger.debug({ walletAddress: normalizedAddress, balance: balance.toString() }, `[NFT CHECKER] Balance for wallet`);
    
    return balance.toString();
  } catch (error) {
    logger.error({ err: error, walletAddress }, `[NFT CHECKER] Error getting NFT balance for wallet`);
    throw error;
  }
}

/**
 * Gets all NFT tokens belonging to an address
 * @param walletAddress - Address of the wallet to check
 * @returns Array of token IDs
 */
export async function getNFTTokens(walletAddress: string): Promise<string[]> {
  if (!NFT_CONTRACT_ADDRESS) {
    logger.error('[NFT CHECKER] NFT_CONTRACT_ADDRESS not defined in environment during getNFTTokens');
    throw new Error("NFT_CONTRACT_ADDRESS not defined in environment");
  }

  try {
    // Normalize wallet address
    const normalizedAddress = getAddress(walletAddress.toLowerCase());
    
    // Connect to provider and contract
    const provider = new JsonRpcProvider(FORMA_RPC);
    const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
    
    // Get balance
    const balance = await nftContract.balanceOf(normalizedAddress);
    const tokenCount = balance.toNumber();
    
    if (tokenCount === 0) {
      return [];
    }
    
    // Get all token IDs using tokenOfOwnerByIndex
    const tokenIds = [];
    for (let i = 0; i < tokenCount; i++) {
      const tokenId = await nftContract.tokenOfOwnerByIndex(normalizedAddress, i);
      tokenIds.push(tokenId.toString());
    }
    
    return tokenIds;
  } catch (error) {
    logger.error({ err: error, walletAddress }, `[NFT CHECKER] Error getting token IDs for wallet`);
    throw error;
  }
} 