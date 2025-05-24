/**
 * Utility functions for Express
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Type for async request handler with proper Express typing
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<any>;

/**
 * Wrapper for async request handlers to properly handle exceptions
 * and provide correct TypeScript typing
 */
export const asyncHandler = (fn: AsyncRequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * There are many typing errors in Express routers, so we add a wrapper
 * for asynchronous handlers in legacyRouter
 */
export const wrapAsync = (fn: (req: Request, res: Response) => Promise<any>): RequestHandler => {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}; 