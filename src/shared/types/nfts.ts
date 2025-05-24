export type EvmAddress = string;

export interface UserNft {
    tokenId: string;
    contractAddress: EvmAddress;
    name?: string | null;
    imageUrl?: string | null;
    collectionName?: string | null;
    network: string; // e.g., 'forma', 'ethereum'
    // quantity?: number; // For ERC1155, could be added later
} 