import { createPublicClient, http, parseAbi, Address, PublicClient } from 'viem';
import { forma } from 'viem/chains';
import axios from 'axios';
import { CollectionMetadata } from '../../shared/types';
import dotenv from 'dotenv';
import { JsonRpcProvider } from 'ethers';
import { getCollectionMapping, CollectionMappingValue } from './collection-mappings'; // Ensure this is imported
import logger from '../../shared/utils/logger'; // Import logger

dotenv.config();

// const FORMA_RPC = process.env.FORMA_RPC_URL || 'https://rpc.forma.art'; // Will be passed via constructor

// --- Constants for metadata fetching ---
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
// const PREFERRED_TOKEN_IDS_FOR_COLLECTION_METADATA = [BigInt(0), BigInt(1), BigInt(18)]; // Removed
const MAX_TOKEN_ID_SEARCH_ATTEMPTS = BigInt(500); // Max attempts to find a an existing token ID if not provided
const CONTRACT_CALL_TIMEOUT_MS = 7000; 
const DEFAULT_COLLECTION_PLACEHOLDER_IMAGE = '/images/collections/placeholder.webp'; // Path to the placeholder

// --- Cache ---
const CONTRACT_METADATA_CACHE = new Map<string, CollectionMetadata | null>();
const TOKEN_SPECIFIC_METADATA_CACHE = new Map<string, Partial<CollectionMetadata> | null>(); // Cache for token-specific metadata

export class NftMetadataService {
  private publicClient: PublicClient;
  private formaProvider: JsonRpcProvider;
  private graphqlUrl: string;
  private apiKey: string;

  constructor(
    formaProvider: JsonRpcProvider,
    graphqlUrl: string,
    apiKey: string,
    formaRpcUrl?: string
  ) {
    this.formaProvider = formaProvider;
    this.graphqlUrl = graphqlUrl;
    this.apiKey = apiKey;

    this.publicClient = createPublicClient({
      chain: forma,
      transport: http(formaRpcUrl || process.env.FORMA_RPC_URL || 'https://rpc.forma.art'),
    });
    logger.debug({ graphqlUrl, apiKeyUsed: !!this.apiKey }, `[NftMetadataService] Initialized.`);
  }

  public resolveIpfsUrl(uri: string): string {
    if (!uri) return DEFAULT_COLLECTION_PLACEHOLDER_IMAGE; // Return placeholder if URI is empty
    if (uri.startsWith('ipfs://')) {
      return `${IPFS_GATEWAY}${uri.substring(7)}`;
    }
    return uri;
  }

  private async fetchAndParseUri(uri: string): Promise<CollectionMetadata | null> {
    const resolvedUri = this.resolveIpfsUrl(uri);
    try {
      if (resolvedUri.startsWith('data:application/json;base64,')) {
        const base64Data = resolvedUri.substring('data:application/json;base64,'.length);
        const jsonData = Buffer.from(base64Data, 'base64').toString('utf-8');
        const metadata = JSON.parse(jsonData) as CollectionMetadata;
        if (metadata.image) {
          metadata.image = this.resolveIpfsUrl(metadata.image);
        }
        return metadata;
      } else if (resolvedUri.startsWith('http://') || resolvedUri.startsWith('https://')) {
        const response = await axios.get(resolvedUri, { timeout: CONTRACT_CALL_TIMEOUT_MS });
        const metadata = response.data as CollectionMetadata;
        if (metadata.image) {
          metadata.image = this.resolveIpfsUrl(metadata.image);
        }
        return metadata;
      } else {
        logger.warn({ uri, resolvedUri }, `[NftMetadataService.fetchAndParseUri] Unsupported URI scheme.`);
        return null;
      }
    } catch (error: any) {
      logger.error({ err: error, uri, resolvedUri }, `[NftMetadataService.fetchAndParseUri] Error fetching or parsing URI`);
      return null;
    }
  }

  private async checkTokenExists(contractAddress: Address, tokenId: bigint): Promise<boolean> {
    const erc721ExistsAbi = parseAbi(['function exists(uint256 tokenId) view returns (bool)']);
    const erc721OwnerOfAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);

    try {
      // Try a common 'exists' function first
      const existsResult = await Promise.race([
        this.publicClient.readContract({
          address: contractAddress,
          abi: erc721ExistsAbi,
          functionName: 'exists',
          args: [tokenId],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout exists')), CONTRACT_CALL_TIMEOUT_MS / 2))
      ]) as boolean;
      if (typeof existsResult === 'boolean' && existsResult) {
        logger.debug({ contractAddress, tokenId }, `[NftMetadataService.checkTokenExists] Exists (via exists function)`);
        return true;
      }
    } catch (e: any) {
      logger.debug({ contractAddress, tokenId, error: e.message }, `[NftMetadataService.checkTokenExists] 'exists' function failed or not applicable.`);
    }

    try {
      // Fallback to 'ownerOf' for ERC721 as a proxy for existence
      const owner = await Promise.race([
        this.publicClient.readContract({
          address: contractAddress,
          abi: erc721OwnerOfAbi,
          functionName: 'ownerOf',
          args: [tokenId],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ownerOf')), CONTRACT_CALL_TIMEOUT_MS / 2))
      ]) as Address | null;
      
      if (owner && owner !== '0x0000000000000000000000000000000000000000') {
        logger.debug({ contractAddress, tokenId }, `[NftMetadataService.checkTokenExists] Exists (via ownerOf function)`);
        return true;
      }
    } catch (e: any) {
      logger.debug({ contractAddress, tokenId, error: e.message }, `[NftMetadataService.checkTokenExists] 'ownerOf' function failed.`);
    }
    
    logger.debug({ contractAddress, tokenId }, `[NftMetadataService.checkTokenExists] Does not exist or check failed.`);
    return false; 
  }

  public async getTokenMetadata(contractAddress: Address, tokenId: bigint): Promise<Partial<CollectionMetadata> | null> {
    const lowerCaseAddress = contractAddress.toLowerCase() as Address;
    const cacheKey = `${lowerCaseAddress}:${tokenId.toString()}`;

    if (TOKEN_SPECIFIC_METADATA_CACHE.has(cacheKey)) {
      logger.debug({ cacheKey }, `[NftMetadataService.getTokenMetadata] Cache hit.`);
      return TOKEN_SPECIFIC_METADATA_CACHE.get(cacheKey) || null;
    }
    logger.debug({ cacheKey }, `[NftMetadataService.getTokenMetadata] Cache miss. Fetching...`);

    const erc721Abi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
    const erc1155Abi = parseAbi(['function uri(uint256 id) view returns (string)']);
    let metadataUri: string | null = null;
    let parsedMetadata: Partial<CollectionMetadata> | null = null;

    // Try ERC721 tokenURI
    try {
      metadataUri = await Promise.race([
        this.publicClient.readContract({
          address: lowerCaseAddress,
          abi: erc721Abi,
          functionName: 'tokenURI',
          args: [tokenId],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout tokenURI for specific token')), CONTRACT_CALL_TIMEOUT_MS))
      ]) as string | null;

      if (metadataUri) {
        parsedMetadata = await this.fetchAndParseUri(metadataUri);
        if (parsedMetadata) {
          logger.debug({ cacheKey }, `[NftMetadataService.getTokenMetadata] Successfully fetched from tokenURI.`);
          TOKEN_SPECIFIC_METADATA_CACHE.set(cacheKey, parsedMetadata);
          return parsedMetadata;
        }
      }
    } catch (e: any) {
      logger.debug({ cacheKey, error: e.message }, `[NftMetadataService.getTokenMetadata] Error calling tokenURI.`);
    }

    // Try ERC1155 uri if ERC721 failed or didn't yield metadata
    if (!parsedMetadata) {
      try {
        metadataUri = await Promise.race([
          this.publicClient.readContract({
            address: lowerCaseAddress,
            abi: erc1155Abi,
            functionName: 'uri',
            args: [tokenId],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout uri for specific token')), CONTRACT_CALL_TIMEOUT_MS))
        ]) as string | null;

        if (metadataUri) {
          const filledUri = metadataUri.replace('{id}', tokenId.toString(16).padStart(64, '0'));
          parsedMetadata = await this.fetchAndParseUri(filledUri);
          if (parsedMetadata) {
            logger.debug({ cacheKey }, `[NftMetadataService.getTokenMetadata] Successfully fetched from ERC1155 uri.`);
            TOKEN_SPECIFIC_METADATA_CACHE.set(cacheKey, parsedMetadata);
            return parsedMetadata;
          }
        }
      } catch (e: any) {
        logger.debug({ cacheKey, error: e.message }, `[NftMetadataService.getTokenMetadata] Error calling ERC1155 uri.`);
      }
    }
    
    logger.warn({ cacheKey }, `[NftMetadataService.getTokenMetadata] Failed to fetch metadata.`);
    TOKEN_SPECIFIC_METADATA_CACHE.set(cacheKey, null); // Cache failure to avoid retrying constantly for known unresolvable URIs
    return null;
  }

  public async getCollectionMetadata(contractAddress: Address, optionalSampleTokenId?: bigint): Promise<CollectionMetadata> {
    const lowerCaseAddress = contractAddress.toLowerCase() as Address;
    if (CONTRACT_METADATA_CACHE.has(lowerCaseAddress)) {
      const cachedData = CONTRACT_METADATA_CACHE.get(lowerCaseAddress);
      if (cachedData) { 
        logger.debug({ contractAddress: lowerCaseAddress }, `[NftMetadataService.getCollectionMetadata] Cache hit.`);
        return cachedData;
      } 
    }
    logger.debug({ contractAddress: lowerCaseAddress }, `[NftMetadataService.getCollectionMetadata] Cache miss. Fetching...`);

    // --- BEGIN LOGIC FOR AUTHORITATIVE COLLECTION NAME ---
    let authoritativeCollectionName: string | undefined;
    const mapping = getCollectionMapping(lowerCaseAddress);

    if (mapping?.name) {
      authoritativeCollectionName = mapping.name;
    } else if (mapping?.fetchNameFromContract) {
      try {
        const nameAbi = parseAbi(['function name() view returns (string)']);
        const contractName = await Promise.race([
          this.publicClient.readContract({
            address: lowerCaseAddress,
            abi: nameAbi,
            functionName: 'name',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetching contract name')), CONTRACT_CALL_TIMEOUT_MS))
        ]) as string | null;

        if (contractName) {
          authoritativeCollectionName = contractName;
        }
      } catch (e: any) {
        logger.warn({ contractAddress: lowerCaseAddress, error: e.message || e }, `[NftMetadataService.getCollectionMetadata] Error fetching name() from contract`);
      }
    }
    // --- END LOGIC FOR AUTHORITATIVE COLLECTION NAME ---

    const erc721Abi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
    const erc1155Abi = parseAbi(['function uri(uint256 id) view returns (string)']);
    let tokenIdToUse: bigint | undefined = undefined;

    if (optionalSampleTokenId !== undefined) {
      tokenIdToUse = optionalSampleTokenId;
    } else {
      for (let i = BigInt(0); i < MAX_TOKEN_ID_SEARCH_ATTEMPTS; i++) {
        if (await this.checkTokenExists(lowerCaseAddress, i)) {
          tokenIdToUse = i;
          logger.debug({ contractAddress: lowerCaseAddress, foundTokenId: i }, `[NftMetadataService.getCollectionMetadata] Found existing token ID for URI metadata search.`);
          break;
        }
      }
    }

    let uriMetadata: CollectionMetadata | null = null; // Metadata from sample token URI

    if (tokenIdToUse === undefined) {
      logger.warn({ contractAddress: lowerCaseAddress }, `[NftMetadataService.getCollectionMetadata] Could not determine a token ID for URI metadata.`);
    } else {
      let metadataUriFromToken: string | null = null;
      try { 
        metadataUriFromToken = await Promise.race([
          this.publicClient.readContract({
            address: lowerCaseAddress,
            abi: erc721Abi,
            functionName: 'tokenURI',
            args: [tokenIdToUse],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout tokenURI')), CONTRACT_CALL_TIMEOUT_MS))
        ]) as string | null;
        if (metadataUriFromToken) {
          uriMetadata = await this.fetchAndParseUri(metadataUriFromToken);
        }
      } catch (e: any) { /* continue to ERC1155 */ }

      if (!uriMetadata) { 
        try { 
          metadataUriFromToken = await Promise.race([
            this.publicClient.readContract({
              address: lowerCaseAddress,
              abi: erc1155Abi,
              functionName: 'uri',
              args: [tokenIdToUse],
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout uri')), CONTRACT_CALL_TIMEOUT_MS))
          ]) as string | null;
          if (metadataUriFromToken) {
            const filledUri = metadataUriFromToken.replace('{id}', tokenIdToUse.toString(16).padStart(64, '0')); 
            uriMetadata = await this.fetchAndParseUri(filledUri);
          }
        } catch (e: any) { /* ignore */ }
      }

    }
    
    // Construct final metadata
    const finalMetadata: CollectionMetadata = {}; // Start with an empty object

    // 1. Set NAME: Prioritize authoritative, then URI name, then default
    if (authoritativeCollectionName) {
      finalMetadata.name = authoritativeCollectionName;
    } else if (uriMetadata?.name) {
      finalMetadata.name = uriMetadata.name;
    } else {
      finalMetadata.name = `Collection ${lowerCaseAddress.substring(0, 6)}...`;
    }

    // 2. Set IMAGE: Prioritize URI image, then default placeholder
    // Ensure this doesn't overwrite an image if uriMetadata is null but finalMetadata somehow had it (though unlikely with current flow)
    finalMetadata.image = uriMetadata?.image || DEFAULT_COLLECTION_PLACEHOLDER_IMAGE;

    // 3. Set DESCRIPTION: Prioritize URI description. Fallback based on name or generic.
    if (uriMetadata?.description) {
      finalMetadata.description = uriMetadata.description;
    } else if (finalMetadata.name && finalMetadata.name !== `Collection ${lowerCaseAddress.substring(0, 6)}...`) {
      // Only add 'Collection: ' if name is something meaningful
      finalMetadata.description = `Collection: ${finalMetadata.name}`;
    } else {
      finalMetadata.description = 'Collection metadata.';
    }
    
    // 4. Other fields from uriMetadata if available, otherwise they remain undefined
    finalMetadata.external_url = uriMetadata?.external_url;
    finalMetadata.attributes = uriMetadata?.attributes;
    // Ensure any other fields from CollectionMetadata type are handled if necessary, e.g., animation_url
    finalMetadata.animation_url = uriMetadata?.animation_url;

    CONTRACT_METADATA_CACHE.set(lowerCaseAddress, finalMetadata);
    return finalMetadata;
  }
}
