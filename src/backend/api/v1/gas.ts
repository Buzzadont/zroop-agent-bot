/**
 * API routes for gas price information
 */
import express, { Request, Response } from 'express';
import { asyncHandler } from '../../../shared/utils/express-helpers';
import { marketplaceService } from '../../services/marketplaceService';
import logger from '../../../shared/utils/logger';

const router = express.Router();

/**
 * @route GET /api/v1/gas/price
 * @description Get current gas price information
 * @access Public
 */
router.get('/price', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const gasPrice = await marketplaceService.getGasPrice();
    res.json({
      success: true,
      gasPrice
    });
  } catch (error) {
    logger.error({ err: error }, '[API] Error fetching gas price:');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch gas price information' 
    });
  }
}));

/**
 * @route GET /api/v1/gas/history
 * @description Get gas price history for a specified time period
 * @access Public
 */
router.get('/history', asyncHandler(async (req: Request, res: Response) => {
  const period = req.query.period as string || '24h';
  
  try {
    const history = await marketplaceService.getGasPriceHistory(period);
    res.json({
      success: true,
      period,
      history
    });
  } catch (error) {
    logger.error({ err: error, period }, `[API] Error fetching gas price history for period ${period}:`);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch gas price history' 
    });
  }
}));

export default router; 