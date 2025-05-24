/**
 * GraphQL queries for Modularium API
 */

/**
 * Get tokens with marketplace allowance information
 * Returns tokens where tokenId is less than or equal to 1, with a limit of 1000
 * This query helps identify collections by checking the first token of each collection
 */
export const GET_TOKENS_WITH_MARKETPLACE_INFO = `
query Tokens {
  tokens(where: {tokenId_lte: "1"}, limit: 1000) {
    items {
      tokenAddress
      tokenId
      totalSupply
      collection {
        isMarketplaceAllowed
      }
    }
  }
}
`;

/**
 * Helper function to execute GraphQL query
 * @param query GraphQL query string
 * @param variables Optional variables for the query
 * @param apiUrl Optional API URL to override the default
 * @param apiKey Optional API Key for authorization
 * @returns Promise with query result
 */
export const executeGraphQLQuery = async <T>(
  query: string, 
  variables?: Record<string, any>,
  apiUrl?: string, 
  apiKey?: string
): Promise<T> => {
  const targetUrl = apiUrl || 'https://api.modularium.art/graphql';
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    // Assuming X-API-Key, adjust if Modularium uses a different header e.g., Authorization: Bearer
    headers['X-API-Key'] = apiKey; 
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      query,
      variables,
    }),
    // Example: Add a timeout (uncomment and adjust as needed)
    // signal: AbortSignal.timeout(15000) // 15 seconds
  });

  if (!response.ok) {
    // Try to get more error details from the response body
    let errorBody = 'Unknown error';
    try {
      errorBody = await response.text();
    } catch (e) {
      // ignore if text() fails
    }
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}. Body: ${errorBody}`);
  }

  const result = await response.json();
  
  if (result.errors) {
    // Include more details from the GraphQL error object if available
    const errorMessages = result.errors.map((err: any) => err.message || JSON.stringify(err)).join('; ');
    throw new Error(`GraphQL errors: ${errorMessages}`);
  }
  
  return result.data as T;
};

/**
 * Interface for token data returned by GET_TOKENS_WITH_MARKETPLACE_INFO query
 */
export interface TokenWithMarketplaceInfo {
  tokenAddress: string;
  tokenId: string;
  totalSupply: string;
  collection: {
    isMarketplaceAllowed: boolean;
  };
}

/**
 * Interface for the response from GET_TOKENS_WITH_MARKETPLACE_INFO query
 */
export interface TokensQueryResponse {
  tokens: {
    items: TokenWithMarketplaceInfo[];
  };
}

/**
 * Get all tokens with marketplace allowance information
 * @returns Promise with tokens data
 */
export const getTokensWithMarketplaceInfo = (
  apiUrl?: string, 
  apiKey?: string
): Promise<TokensQueryResponse> => {
  return executeGraphQLQuery<TokensQueryResponse>(GET_TOKENS_WITH_MARKETPLACE_INFO, undefined, apiUrl, apiKey);
};

/**
 * Filter tokens to get only those allowed on the marketplace
 * @param tokens List of tokens with marketplace info
 * @returns List of token addresses allowed on the marketplace
 */
export const filterMarketplaceAllowedTokens = (tokens: TokenWithMarketplaceInfo[]): string[] => {
  return tokens
    .filter(token => token.collection.isMarketplaceAllowed)
    .map(token => token.tokenAddress);
};

// Query to get active sell orders (minimum price)
export const GET_COLLECTION_FLOOR_PRICE = `
  query GetCollectionFloorPrice($collectionAddress: String!, $tokenId: BigInt) {
    orders(
      limit: 1
      orderBy: "price"
      orderDirection: "asc"
      where: {orderType: SELL, orderStatus: ACTIVE, tokenAddress: $collectionAddress, tokenId: $tokenId}
    ) {
      items {
        id
        price
        tokenAddress
        tokenId
      }
    }
  }
`;

// Interface for the response with orders
export interface OrdersQueryResponse {
  orders: {
    items: Array<{
      id: string;
      price: string;
      tokenAddress: string;
      tokenId: string;
    }>;
  };
}

// Query to get the highest offer (buy offer)
export const GET_COLLECTION_BEST_OFFER = `
  query GetCollectionBestOffer($collectionAddress: String!, $tokenId: BigInt) {
    orders(
      limit: 1
      orderBy: "price"
      orderDirection: "desc"
      where: {orderType: BUY, orderStatus: ACTIVE, tokenAddress: $collectionAddress, tokenId: $tokenId}
    ) {
      items {
        id
        price
        tokenAddress
        tokenId
      }
    }
  }
`;

// Query to get active sell orders (minimum price), without filtering by tokenId
export const GET_COLLECTION_FLOOR_PRICE_NO_TOKENID = `
query GetCollectionFloorPriceNoTokenId($collectionAddress: String!) {
  orders(
    limit: 1
    orderBy: "price"
    orderDirection: "asc"
    where: {orderType: SELL, orderStatus: ACTIVE, tokenAddress: $collectionAddress}
  ) {
    items {
      id
      price
      tokenAddress
      tokenId
    }
  }
}
`;

// Query to get the highest offer (buy offer), without filtering by tokenId
export const GET_COLLECTION_BEST_OFFER_NO_TOKENID = `
query GetCollectionBestOfferNoTokenId($collectionAddress: String!) {
  orders(
    limit: 1
    orderBy: "price"
    orderDirection: "desc"
    where: {orderType: BUY, orderStatus: ACTIVE, tokenAddress: $collectionAddress}
  ) {
    items {
      id
      price
      tokenAddress
      tokenId
      isCollectionOffer
    }
  }
}
`;

// Query to get the highest COLLECTION offer (buy offer), without filtering by tokenId, but IS COLLECTION OFFER
export const GET_COLLECTION_BEST_COLLECTION_OFFER_NO_TOKENID = `
query GetCollectionBestCollectionOfferNoTokenId($collectionAddress: String!) {
  orders(
    limit: 1
    orderBy: "price"
    orderDirection: "desc"
    where: {orderType: BUY, orderStatus: ACTIVE, tokenAddress: $collectionAddress, isCollectionOffer: true}
  ) {
    items {
      id
      price
      tokenAddress
      tokenId
      isCollectionOffer
    }
  }
}
`; 

// NEW: GraphQL query to fetch collection addresses allowed on the marketplace
export const GET_ALLOWED_COLLECTION_ADDRESSES = `
query FetchAllowedCollections {
  collections(where: {isMarketplaceAllowed: true}, limit: 1000) { # Added limit as good practice
    items {
      tokenAddress
      # isMarketplaceAllowed # This is implicitly true due to the 'where' clause, can be omitted
    }
  }
}
`;

// Interface for a single collection item from the new query
export interface AllowedCollectionItem {
  tokenAddress: string;
}

// Interface for the response from GET_ALLOWED_COLLECTION_ADDRESSES query
export interface AllowedCollectionsResponse {
  collections: {
    items: AllowedCollectionItem[];
  };
}

/**
 * Function to fetch allowed collection addresses from GraphQL API
 */
export const fetchAllowedCollectionAddressesGraphQL = (
  apiUrl?: string, 
  apiKey?: string
): Promise<AllowedCollectionsResponse> => {
  return executeGraphQLQuery<AllowedCollectionsResponse>(GET_ALLOWED_COLLECTION_ADDRESSES, undefined, apiUrl, apiKey);
}; 