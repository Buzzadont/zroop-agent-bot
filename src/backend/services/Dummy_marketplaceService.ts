// Stub for the public repository. Does not contain real logic.

export class MarketplaceService {
    async getUserNfts() {
      throw new Error('MarketplaceService: Not implemented in public version');
    }
    async getCollections() {
      return { items: [], totalItems: 0, totalPages: 0, currentPage: 1 };
    }
    async getCollectionDetails() {
      return null;
    }
    async getCollection() {
      return null;
    }
    async getCollectionStats() {
      return {};
    }
    async searchCollections() {
      return { items: [], totalItems: 0, totalPages: 0, currentPage: 1 };
    }
    async getTrendingCollections() {
      return { items: [], totalItems: 0, period: '24h' };
    }
    async getGasPrice() {
      return {
        current: '0',
        formatted: { gwei: '0', tia: '0' },
        safe: '0',
        estimatedTimeInSeconds: { slow: 0, standard: 0, fast: 0 }
      };
    }
    async getGasPriceHistory() {
      return [];
    }
    async getFloorPriceFromOrders() {
      return undefined;
    }
    async getBestOfferFromOrders() {
      return undefined;
    }
    async getCollectionMetadata() {
      return {};
    }
    async getFeaturedCollections() {
      return { items: [], totalItems: 0 };
    }
  }
  
  export const marketplaceService = new MarketplaceService();