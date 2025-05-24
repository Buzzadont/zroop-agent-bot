/**
 * API routes for collections
 */
import express, { Request, Response } from 'express';
import { asyncHandler } from '../../../shared/utils/express-helpers';
import { marketplaceService } from '../../services/marketplaceService';
import logger from '../../../shared/utils/logger';

const router = express.Router();

// Get FEATURED collections (replaces the old paginated GET /)
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  // Pagination parameters are ignored for featured collections
  // const page = req.query.page ? Number(req.query.page) : 1;
  // const limit = req.query.limit ? Number(req.query.limit) : 20;
  // const sortBy = req.query.sortBy as string || 'volume';
  // const order = req.query.order as 'asc' | 'desc' || 'desc';
  logger.debug('[API /collections] Request received for featured collections.');
  try {
    // Call the new service method
    const featuredCollections = await marketplaceService.getFeaturedCollections();
    logger.debug({ count: featuredCollections.totalItems }, `[API /collections] Sending featured collections.`);
    res.json(featuredCollections); // Send the response { items: Collection[], totalItems: number }
  } catch (error) {
    logger.error({ err: error }, '[API /collections] Error fetching featured collections:');
    // Send a generic error response
    res.status(500).json({ error: 'Failed to fetch featured collections' });
  }
}));

// NEW: Get ALL discoverable collections with pagination
router.get('/all', asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  logger.debug({ page, limit }, `[API /collections/all] Request received for ALL collections.`);
  try {
    // This method should fetch featured AND discover new ones via GraphQL
    const paginatedCollections = await marketplaceService.getCollections(page, limit);
    logger.debug({ count: paginatedCollections.items.length, total: paginatedCollections.totalItems, page }, `[API /collections/all] Sending collections.`);
    res.json(paginatedCollections);
  } catch (error) {
    logger.error({ err: error }, '[API /collections/all] Error fetching all collections:');
    res.status(500).json({ error: 'Failed to fetch all collections' });
  }
}));

// Search collections
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const query = req.query.q as string;
  const page = req.query.page ? Number(req.query.page) : 1;
  const limit = req.query.limit ? Number(req.query.limit) : 20;

  if (!query) {
    return res.status(400).json({ error: 'Search query required' });
  }

  try {
    const results = await marketplaceService.searchCollections(query, page, limit);
    res.json(results);
  } catch (error) {
    logger.error({ err: error, query }, '[API] Error searching collections:');
    res.status(500).json({ error: 'Failed to search collections' });
  }
}));

// Get trending collections
router.get('/trending', asyncHandler(async (req: Request, res: Response) => {
  const period = req.query.period as string || '24h';
  const limit = req.query.limit ? Number(req.query.limit) : 10;

  try {
    const trendingCollections = await marketplaceService.getTrendingCollections(period, limit);
    res.json(trendingCollections);
  } catch (error) {
    logger.error({ err: error, period, limit }, '[API] Error fetching trending collections:');
    res.status(500).json({ error: 'Failed to fetch trending collections' });
  }
}));

// Get collection by address
router.get('/:collectionAddress', asyncHandler(async (req: Request, res: Response) => {
  const { collectionAddress } = req.params;
  logger.debug({ collectionAddress }, `[API /collections/:address] Request for collection`);

  // Basic validation
  // Allow address/instance/id format here as well, although the service handles base address mostly
   if (!collectionAddress) { // Simplified check, needs better regex if instances are allowed in this route
      return res.status(400).json({ error: 'Invalid collection identifier' });
   }

  try {
    // Use getCollectionDetails which now returns the updated Collection type
    const collection = await marketplaceService.getCollectionDetails(collectionAddress);

    if (!collection) {
      logger.info({ collectionAddress }, `[API /collections/:address] Collection not found`);
      return res.status(404).json({ error: 'Collection not found' });
    }

    logger.debug({ collectionAddress }, `[API /collections/:address] Sending details for collection`);
    res.json(collection); // Returns the updated Collection object
  } catch (error) {
    logger.error({ err: error, collectionAddress }, `[API /collections/:address] Error fetching collection`);
    res.status(500).json({ error: 'Failed to fetch collection details' });
  }
}));

// Get collection stats
router.get('/:collectionAddress/stats', asyncHandler(async (req: Request, res: Response) => {
  const { collectionAddress } = req.params;
  
  if (!collectionAddress || !/^0x[a-fA-F0-9]{40}$/.test(collectionAddress)) {
    return res.status(400).json({ error: 'Invalid collection address' });
  }

  try {
    const stats = await marketplaceService.getCollectionStats(collectionAddress);
    res.json(stats);
  } catch (error) {
    logger.error({ err: error, collectionAddress }, `[API] Error fetching stats for collection`);
    res.status(500).json({ error: 'Failed to fetch collection stats' });
  }
}));

export default router; 