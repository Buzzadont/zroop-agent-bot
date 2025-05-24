/**
 * Common TypeScript types for the Zroop NFT Agent Bot
 */

/**
 * Wallet record from database
 */
export interface WalletRecord {
  wallet: string;
  proofed: boolean;
  createdAt: string;
  lastTerminalActivityAt: string | null;
}

/**
 * User status response
 */
export interface UserStatus {
  isLinked: boolean;
  wallet?: string;
  proofed?: boolean;
  balance?: number | string;
  hasNFT?: boolean;
  error?: string;
}

/**
 * Terminal access response
 */
export interface TerminalAccess {
  access: boolean;
  reason?: string;
  error?: string;
}

/**
 * NFT item representation
 */
export interface NFTItem {
  name: string;
  collectionName: string;
  collectionAddress: string;
  tokenId: string;
  imageUrl: string;
  floorPrice?: number | null;
  marketplaceLink: string;
}

/**
 * Collection item representation
 */
export interface CollectionItem {
  id: string; // Unique identifier (can be contract address or a custom ID for mapped items)
  name: string;
  address: string; // Contract address
  description: string | null;
  imageUrl: string | null; // Will be populated by NftMetadataService for new items
  itemCount: number | null; // Was totalSupply, corresponds to itemCount
  floorPrice: number | null;
  totalVolume: number | string | null;
  bestOffer: number | null; // Added based on usage in MarketplaceService

  // Fields for extended logic
  isNew?: boolean;       // Flag for newly discovered vs. mapped
  isFeatured?: boolean;  // Flag for featured collections
  tokenId?: string | null; // If this collection represents a specific token ID, made nullable
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  currentPage: number;
  totalPages: number;
  totalItems: number;
}

/**
 * Alert subscription type
 */
export interface AlertSubscription {
  id: number;
  collectionAddress: string;
  alertType: string;
  thresholdValue: number | null;
  lastNotifiedAt: string | null;
  createdAt: string;
}

/**
 * Represents the metadata typically found in an NFT's URI (tokenURI or uri).
 * This is often a nested object within NFTItem or CollectionExtended.
 */
export interface CollectionMetadata {
  name?: string;
  description?: string;
  image?: string;        // Can be HTTP(S) URL, IPFS URI, or base64 data URI
  external_url?: string; // Link to the collection's or token's own site
  attributes?: Array<{ 
    trait_type?: string;
    value?: string | number;
    display_type?: string; 
  }>;
  animation_url?: string; 
}

/**
 * Represents an NFT collection, extending or aligning with CollectionItem.
 * This version includes fields for mapped collections and detailed stats.
 */
export interface CollectionExtended { // Названо CollectionExtended, чтобы не конфликтовать с существующим CollectionItem
  id: string;           // Unique identifier (e.g., contractAddress or a marketplace-specific ID)
  contractAddress: string; 
  name: string;
  description?: string;
  imageUrl?: string;     // Cover image for the collection
  bannerImageUrl?: string;
  externalUrl?: string;
  creatorAddress?: string;
  
  // Stats (can be populated from various sources)
  itemCount?: number;    // Total number of items
  ownerCount?: number;   // Number of unique owners
  floorPrice?: number;   // Lowest current asking price (in native currency like TIA)
  totalVolume?: number | string; // Total volume traded
  bestOffer?: number;    // Highest current bid

  // For mapped collections from collectionMappings.ts
  tokenId?: string;      // If this collection represents a specific token ID
  isNew?: boolean;       // Flag for newly discovered vs. mapped
  isFeatured?: boolean;  // Flag for featured collections

  // Aligning with fields from your existing CollectionItem if needed
  // address: string; // Already have contractAddress
  // totalSupply: number; // Similar to itemCount
  // volume24h: number | null;
  // marketplaceLink: string; // Could be part of externalUrl or a separate field
}

/**
 * Represents collection statistics, often fetched from an API.
 */
export interface CollectionStats {
  floorPrice?: number;
  totalVolume?: number | string;
  itemCount?: number;
  ownerCount?: number;
  numMinted?: number;
  primaryVolume?: string | number; 
  totalSalesQty?: number;
  maxSalePrice?: string | number;
  minSalePrice?: string | number;
  avgSalePrice?: string | number;
  name?: string; 
  imageUrl?: string; 
  description?: string; 
  contractAddress?: string; 
}

/**
 * Represents the structure of an item in the collection mapping configuration.
 */
export interface CollectionMappingConfig {
  id: string; 
  name?: string; 
  baseAddress?: string; 
  instanceId?: string; 
  tokenId?: string; 
  description?: string;
  fetchNameFromContract?: boolean; 
  staticImageName?: string; 
  fetchFloorPriceFromStats?: boolean; 
  floorPrice?: number; 
} 