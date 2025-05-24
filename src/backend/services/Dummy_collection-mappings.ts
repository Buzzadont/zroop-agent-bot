// Stub for the public repository. Does not contain real logic.

export interface CollectionMappingValue {
    name?: string;
    fetchNameFromContract?: boolean;
    instanceId?: string;
    baseAddress?: string;
    note?: string;
    description?: string;
    tokenId?: string;
    itemCount?: number;
  }
  
  export function getCollectionMapping(): CollectionMappingValue | undefined {
    return undefined;
  }
  
  export function getFeaturedCollectionKeys(): string[] {
    return [];
  }
  
  export function getAllMappedBaseAddresses(): string[] {
    return [];
  }