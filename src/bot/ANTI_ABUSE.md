# Anti-Abuse Protection System

This document describes the anti-abuse protection system added to the Zroop NFT Agent bot.

## Main Components

The system consists of three main protection components:

1. **Bot Blocking** - automatic detection and blocking of other bot accounts
2. **General Request Rate Limiting** - limiting the frequency of requests from users with flexible configuration
3. **Special Restrictions for Critical Commands** - additional limitations on sensitive commands

## Configuration

To configure the anti-abuse protection system, add the following variables to the `.env` file:

```
# Comma-separated list of Telegram IDs of administrators exempted from limitations
# These IDs will be ADDED to any whitelist provided in the code configuration.
ADMIN_IDS=123456789,987654321

# Comma-separated list of Telegram IDs permanently blocked from using the bot
# These IDs will be ADDED to any blacklist provided in the code configuration.
BLOCKED_IDS=111111111,222222222
```

## How It Works

### Bot Blocking

The `createBotBlocker` middleware checks the `is_bot` field of the user and blocks access if this value is `true`. This protects against attempts by other bots to interact with your bot.

### Request Rate Limiter

The `createRateLimiter` middleware tracks the number of requests from each user and applies the following measures:

1. **Blacklist** - users in the blacklist are always blocked from using the bot. This is useful for permanently blocking problematic accounts.

2. **Request Slowdown** - after exceeding the threshold (default is 20 requests per minute), each subsequent request from the user is delayed by a few milliseconds. The delay increases with each new request.

3. **Temporary Blocking** - if the user continues to send too many requests (default is 40 requests per minute), they are temporarily blocked.

4. **Progressive Blocking** - for repeat offenders, the blocking time increases automatically.

### Command Limiter

The `createCommandLimiter` middleware tracks the use of critical commands (e.g., `/link`, `/unlink`) specified in its configuration. It limits the **total number of times** any of these commands can be used by a single user within a defined time window (default is up to 3 uses per hour across all specified commands for that user).

## Parameter Settings

While `ADMIN_IDS` and `BLOCKED_IDS` are read from `.env`, other system parameters are configured directly in the code where the middleware is used (e.g., in `src/bot/bot.ts`):

```typescript
// General request rate limiting
const { middleware: rateLimiterMiddleware, destroy: destroyRateLimiter } = createRateLimiter({
  maxRequests: 30,        // Default: 30 requests
  windowMs: 60 * 1000,    // Default: within 1 minute
  blockDuration: 5 * 60 * 1000, // Default: Block for 5 minutes
  blockMessage: '⚠️ Too many requests. Please wait...', // Default message can be overridden
  slowdown: true,         // Default: true
  slowdownThreshold: 15,  // Default: Start slowdown after 15 requests
  slowdownMs: 500         // Default: 500ms delay increment
});
bot.use(rateLimiterMiddleware);

// Restrictions for critical commands
bot.use(createCommandLimiter(
  ['link', 'unlink'], // List of commands with increased restrictions
  3,                  // Usage limit (total across these commands for the user)
  60 * 60 * 1000,     // Time window (1 hour)
  '⚠️ You are using this command too frequently. Please try again later.'
));
```

## Whitelist and Blacklist

- **Whitelist**: Administrators and trusted users can be exempted from rate limiting. Add their Telegram IDs to the `ADMIN_IDS` environment variable (comma-separated). You can also provide additional IDs in the `whitelist` array when calling `createRateLimiter`.

- **Blacklist**: Problematic users can be permanently blocked. Add their Telegram IDs to the `BLOCKED_IDS` environment variable (comma-separated). You can also provide additional IDs in the `blacklist` array when calling `createRateLimiter`.

## Monitoring

The system logs abuse attempts:

```