import db from '../database/db';
import { NftMetadataService } from './NftMetadataService';
import { marketplaceService, MarketplaceService, Nft as MarketplaceNft, PaginatedNfts } from './marketplaceService'; // Import MarketplaceService and its types
import { NETWORKS } from '../../shared/utils/constants';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';
import { fetchAllowedCollectionAddressesGraphQL, AllowedCollectionsResponse } from '../../shared/utils/modularium-queries';
import logger from '../../shared/utils/logger'; // Import logger

// Temporarily using 'string' and 'any' for EvmAddress and UserNft
// interface UserNft { /* ... Temporarily defined inline or use any ... */ } 

// Define the structure for NFT data fetched from an external API (e.g., Blockscout)
// This can be removed if we fully rely on MarketplaceService
/* interface ExplorerNftToken { ... } */
/* interface ExplorerNftResponse { ... } */

const MODULARIUM_COLLECTIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
type EvmAddress = string; // Define EvmAddress locally as string

export class UserNftService {
    private nftMetadataService: NftMetadataService; // This might become redundant if MarketplaceService handles all metadata
    private provider: JsonRpcProvider; // This might also become redundant
    private marketplaceService: MarketplaceService; // Added MarketplaceService instance
    private allowedModulariumCollections: Set<string> = new Set();
    private lastModulariumCollectionsFetchTimestamp: number = 0;

    constructor(
        nftMetadataService: NftMetadataService, // Potentially remove if not directly used
        provider: JsonRpcProvider, // Potentially remove if not directly used
        marketplaceService: MarketplaceService // Replace 'any' with the actual MarketplaceService type
    ) {
        this.nftMetadataService = nftMetadataService; // Keep for now, might be used by other methods if any
        this.provider = provider; // Keep for now
        this.marketplaceService = marketplaceService; // Store marketplaceService instance
        logger.debug("[UserNftService] Initialized.");
    }

    private async _updateAllowedModulariumCollections(): Promise<void> {
        const now = Date.now();
        if (now - this.lastModulariumCollectionsFetchTimestamp > MODULARIUM_COLLECTIONS_CACHE_TTL_MS) {
            try {
                // Assuming fetchAllowedCollectionAddressesGraphQL returns: { collections: { items: [{ tokenAddress: string }] } }
                // Based on previous context. If different, this needs adjustment.
                const gqlResponse: AllowedCollectionsResponse = await fetchAllowedCollectionAddressesGraphQL();
                if (gqlResponse && gqlResponse.collections && Array.isArray(gqlResponse.collections.items)) {
                    this.allowedModulariumCollections = new Set(gqlResponse.collections.items.map(item => item.tokenAddress.toLowerCase()));
                    this.lastModulariumCollectionsFetchTimestamp = now;
                    logger.debug({ count: this.allowedModulariumCollections.size }, `[UserNftService] Updated allowed Modularium collections cache.`);
                } else {
                    logger.warn("[UserNftService] fetchAllowedCollectionAddressesGraphQL returned unexpected structure or no items. Allowed collections cache not updated.");
                }
            } catch (error) {
                logger.error({ err: error }, "[UserNftService] Failed to fetch allowed Modularium collections for cache:");
            }
        }
    }

    /**
     * Fetches NFTs for a given wallet address, optionally filtering by Modularium-only collections,
     * and enriches each NFT with an `isModulariumMarketplace` flag.
     */
    public async getNftsForWallet(
        walletAddress: EvmAddress, 
        network: string = 'forma',
        page: number = 1, // Page for the final paginated result
        limit: number = 200, // Limit for the final paginated result
        modulariumOnly: boolean = false // Server-side filter flag
    ): Promise<MarketplaceNft[]> { 
        if (network !== 'forma') {
            logger.warn({ network, walletAddress }, `[UserNftService] Network not yet supported for fetching user NFTs.`);
            return [];
        }

        let allUserNftsFromApi: MarketplaceNft[] = [];
        try {
            // Fetch ALL NFTs for the user by requesting page 1 with a very large limit.
            const fetchAllLimit = 10000; 
            const paginatedResult: PaginatedNfts = await this.marketplaceService.getUserNfts(
                walletAddress,
                1, // Always fetch from page 1
                fetchAllLimit, // Use large limit to get all NFTs
                undefined // No specific collection filter at this stage
            );

            if (paginatedResult && Array.isArray(paginatedResult.items)) {
                allUserNftsFromApi = paginatedResult.items;
            } else {
            logger.warn({ walletAddress }, `[UserNftService] No items received from MarketplaceService for wallet.`);
            return [];
            }
        } catch (error) {
            logger.error({ err: error, walletAddress }, `[UserNftService] Error calling MarketplaceService.getUserNfts for wallet:`);
            return []; 
        }

        await this._updateAllowedModulariumCollections();

        const nftsWithModulariumFlag = allUserNftsFromApi.map(nft => {
            const contractAddrLower = nft.contractAddress?.toLowerCase();
            return {
                ...nft,
                isModulariumMarketplace: contractAddrLower ? this.allowedModulariumCollections.has(contractAddrLower) : false
            };
        });
        
        let nftsToPaginateFurther: MarketplaceNft[]; // Renamed for clarity

        if (modulariumOnly) {
            logger.debug({ walletAddress, countBeforeFilter: nftsWithModulariumFlag.length }, `[UserNftService] Server-side filtering for Modularium-only NFTs.`);
            nftsToPaginateFurther = nftsWithModulariumFlag.filter(nft => nft.isModulariumMarketplace === true);
            logger.debug({ walletAddress, countAfterFilter: nftsToPaginateFurther.length }, `[UserNftService] Server-side filter result.`);
        } else {
            nftsToPaginateFurther = nftsWithModulariumFlag;
        }
        
        // Apply final pagination to the list that has been enriched and (optionally) server-side filtered.
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit; // Corrected endIndex calculation
        const paginatedNftsToReturn = nftsToPaginateFurther.slice(startIndex, endIndex);
        
        logger.debug({ 
            walletAddress, 
            returnedCount: paginatedNftsToReturn.length, 
            requestedPage: page, 
            requestedLimit: limit, 
            modulariumOnly, 
            totalBeforePaginate: nftsToPaginateFurther.length 
        }, `[UserNftService] Returning paginated & enriched NFTs for wallet.`);
        return paginatedNftsToReturn;
    }

    private async fetchAllNftsForWallet(walletAddress: string, network: string): Promise<MarketplaceNft[]> {
        // Implementation of fetchAllNftsForWallet method
        // This method should return an array of NFTs fetched from the API
        // For now, we'll use a placeholder return
        return [];
    }
} 