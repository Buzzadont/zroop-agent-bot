import { Context, Middleware } from 'telegraf';
import logger from '../shared/utils/logger';

/**
 * Configuration for the anti-abuse protection system
 */
export interface RateLimitConfig {
  /** Number of allowed requests in the time window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Duration of blocking when limit is exceeded (in milliseconds) */
  blockDuration: number;
  /** Message sent when blocked */
  blockMessage: string;
  /** Exceptions (user IDs or @usernames) */
  whitelist?: string[];
  /** Permanently blocked user IDs */
  blacklist?: string[];
  /** Slowdown: if true, requests will be delayed instead of blocked */
  slowdown?: boolean;
  /** Number of allowed requests after which slowdown begins */
  slowdownThreshold?: number;
  /** Slowdown coefficient (in ms) for each request after exceeding threshold */
  slowdownMs?: number;
}

/**
 * Default configuration for anti-abuse protection
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRequests: 30,      // 30 requests 
  windowMs: 60 * 1000,  // within 1 minute
  blockDuration: 5 * 60 * 1000, // Block for 5 minutes
  blockMessage: '⚠️ You are sending too many requests. Please wait 5 minutes before trying again.',
  whitelist: [], // Empty list by default
  blacklist: [], // Empty blacklist by default
  slowdown: true, // Enable request slowdown
  slowdownThreshold: 15, // Start slowdown after 15 requests
  slowdownMs: 500 // 500 milliseconds delay for each request above threshold
};

/**
 * User record for tracking requests
 */
interface UserRateLimit {
  /** Number of requests in current window */
  count: number;
  /** Timestamp of last request */
  lastRequest: number;
  /** Timestamp of block end */
  blockedUntil?: number;
  /** Number of times user has been blocked */
  blockCount: number;
  /** Array of request timestamps for slowdown */
  requestTimestamps: number[];
}

/**
 * Store for user request data
 */
class RateLimitStore {
  private users: Map<string, UserRateLimit> = new Map();
  private readonly config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout | null = null; // Store interval ID

  constructor(config: RateLimitConfig) {
    this.config = config;
    
    // Automatic cleanup of old records every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  /**
   * Checks if the user is whitelisted
   */
  private isWhitelisted(userId: string, username?: string): boolean {
    if (!this.config.whitelist || this.config.whitelist.length === 0) return false;
    
    return this.config.whitelist.some(entry => 
      entry === userId || (username && entry === username)
    );
  }

  /**
   * Checks if the user is blacklisted
   */
  private isBlacklisted(userId: string, username?: string): boolean {
    if (!this.config.blacklist || this.config.blacklist.length === 0) return false;
    
    return this.config.blacklist.some(entry => 
      entry === userId || (username && entry === username)
    );
  }

  /**
   * Checks if the user can make a request
   */
  canMakeRequest(userId: string, username?: string): {allowed: boolean, delay?: number, blockTimeLeft?: number} {
    // Blacklisted users are always blocked
    if (this.isBlacklisted(userId, username)) {
      return { allowed: false, blockTimeLeft: 999999 }; // Very long block time
    }
    
    // Whitelisted users can always make requests
    if (this.isWhitelisted(userId, username)) {
      return { allowed: true };
    }
    
    const now = Date.now();
    let user = this.users.get(userId);
    
    // If user not found, create a new record
    if (!user) {
      user = {
        count: 0,
        lastRequest: now,
        blockCount: 0,
        requestTimestamps: []
      };
      this.users.set(userId, user);
    }
    
    // If user is blocked, check if block duration has expired
    if (user.blockedUntil && user.blockedUntil > now) {
      const timeLeftSeconds = Math.ceil((user.blockedUntil - now) / 1000);
      return { allowed: false, blockTimeLeft: Math.max(0, timeLeftSeconds) }; // Ensure non-negative
    }
    
    // Clear block information if expired
    if (user.blockedUntil && user.blockedUntil <= now) {
      user.blockedUntil = undefined;
      user.count = 0; // Reset count when unblocked to allow next request
      user.requestTimestamps = []; // Also clear timestamps
    }
    
    // Reset request counter if a new period started
    if (now - user.lastRequest > this.config.windowMs) {
      user.count = 0;
      user.requestTimestamps = [];
    }
    
    // If user exceeded the limit, block them
    if (user.count >= this.config.maxRequests) {
      user.blockedUntil = now + this.config.blockDuration;
      user.blockCount++;
      
      // Increase block duration for repeat offenders
      if (user.blockCount > 1) {
        user.blockedUntil = now + (this.config.blockDuration * Math.min(user.blockCount, 5));
      }
      
      const timeLeftSeconds = Math.ceil((user.blockedUntil - now) / 1000);
      return { allowed: false, blockTimeLeft: Math.max(0, timeLeftSeconds) }; // Ensure non-negative
    }
    
    // If slowdown is enabled, check if request should be slowed down
    let delay = 0;
    if (this.config.slowdown && this.config.slowdownThreshold && this.config.slowdownMs) {
      if (user.count >= this.config.slowdownThreshold) {
        const countAboveThreshold = user.count - this.config.slowdownThreshold + 1;
        delay = countAboveThreshold * this.config.slowdownMs;
      }
    }
    
    return { allowed: true, delay };
  }
  
  /**
   * Registers a user request
   */
  registerRequest(userId: string): void {
    const now = Date.now();
    let user = this.users.get(userId);
    
    // If user not found, create a new record
    if (!user) {
      user = {
        count: 1,
        lastRequest: now,
        blockCount: 0,
        requestTimestamps: [now]
      };
    } else {
      // Reset request counter if a new period started
      if (now - user.lastRequest > this.config.windowMs) {
        user.count = 1;
        user.requestTimestamps = [now];
      } else {
        user.count++;
        user.requestTimestamps.push(now);
      }
      user.lastRequest = now;
    }
    
    this.users.set(userId, user);
  }
  
  /**
   * Cleans up outdated data
   */
  private cleanup(): void {
    const now = Date.now();
    
    for (const [userId, user] of this.users.entries()) {
      // If last request was long ago, remove the record
      if (now - user.lastRequest > 24 * 60 * 60 * 1000) { // 24 hours
        // If user is not blocked, remove the record
        if (!user.blockedUntil || user.blockedUntil < now) {
          this.users.delete(userId);
        }
      }
    }
  }

  /**
   * Stops the automatic cleanup interval.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Creates middleware for abuse protection
 * Returns an object containing the middleware and a destroy function.
 */
export function createRateLimiter(config: Partial<RateLimitConfig> = {}): { middleware: Middleware<Context>, destroy: () => void } {
  // Get admin and blocked IDs from environment variables
  const adminIdsEnv = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const blockedIdsEnv = (process.env.BLOCKED_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

  // Merge provided config with default config
  const baseConfig: RateLimitConfig = {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    ...config // User-provided config overrides defaults
  };

  // Merge whitelist/blacklist from env and config, ensuring uniqueness
  const finalWhitelist = [...new Set([...adminIdsEnv, ...(baseConfig.whitelist || [])])];
  const finalBlacklist = [...new Set([...blockedIdsEnv, ...(baseConfig.blacklist || [])])];

  // Create the final configuration object
  const finalConfig: RateLimitConfig = {
      ...baseConfig,
      whitelist: finalWhitelist,
      blacklist: finalBlacklist
  };
  
  const store = new RateLimitStore(finalConfig); // Use final config here
  
  const middleware: Middleware<Context> = async (ctx: Context, next: () => Promise<void>) => {
    const userId = ctx.from?.id.toString();
    const username = ctx.from?.username;

    if (!userId) {
      return next(); // Cannot identify user, proceed
    }

    const { allowed, delay, blockTimeLeft } = store.canMakeRequest(userId, username);

    if (allowed) {
      store.registerRequest(userId);
      if (delay && delay > 0) {
        // Apply slowdown
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return next();
    } else {
      if (blockTimeLeft !== undefined) {
        const minutesLeft = Math.max(1, Math.ceil(blockTimeLeft / 60)); // Show at least 1 minute
        const message = finalConfig.blockMessage.replace('5 minutes', `${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}`);
        logger.warn({ userId, blockTimeLeft, minutesLeft }, `[RateLimiter] User ${userId} blocked. Time left: ${blockTimeLeft}s (${minutesLeft} min).`);
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery(message, { show_alert: true });
        } else {
          await ctx.reply(message);
        }
      }
      // Do not proceed to next middleware if blocked
    }
  };

  // Return both the middleware and the destroy function
  return {
    middleware,
    destroy: () => store.destroy()
  };
}

/**
 * Creates middleware to block bot accounts
 */
export function createBotBlocker(message: string = 'Bot accounts are not allowed to use this bot.'): Middleware<Context> {
  return (ctx, next) => {
    if (ctx.from && ctx.from.is_bot) {
      return ctx.reply(message);
    }
    return next();
  };
}

/**
 * Creates middleware to restrict access to specific commands
 */
export function createCommandLimiter(
  commands: string[],
  limit: number,
  windowMs: number = 60 * 60 * 1000,
  message: string = 'You have used this command too many times. Please try again later.'
): Middleware<Context> {
  const userMap = new Map<string, { count: number, windowStart: number }>();

  const middleware: Middleware<Context> = async (ctx: Context, next: () => Promise<void>) => {
    const userId = ctx.from?.id.toString();
    if (!userId) return next();

    // Check if the current update is a text message with entities
    if (ctx.message && 'text' in ctx.message && ctx.message.entities) {
      const commandEntity = ctx.message.entities.find((e: any) => e.type === 'bot_command'); // Added type assertion for e
      if (commandEntity) {
        const command = ctx.message.text.substring(commandEntity.offset, commandEntity.offset + commandEntity.length);
        if (commands.includes(command)) {
          const now = Date.now();
          let userData = userMap.get(userId);

          if (!userData || now - userData.windowStart > windowMs) {
            // New window or new user
            userData = { count: 1, windowStart: now };
          } else {
            userData.count++;
          }
          userMap.set(userId, userData);

          if (userData.count > limit) {
            const timeLeftMs = (userData.windowStart + windowMs) - now;
            const minutesLeft = Math.max(1, Math.ceil(timeLeftMs / (60 * 1000))); // Show at least 1 minute
            const replyMessage = message.includes('Please try again later.') 
              ? message.replace('Please try again later.', `Please try again in approximately ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`)
              : `${message} Please try again in approximately ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}.`;
            logger.warn(`[CommandLimiter] User ${userId} exceeded limit for command ${command}. Wait ${minutesLeft} min.`);
            return ctx.reply(replyMessage);
          }
        }
      }
    }
    return next();
  };
  return middleware;
} 