# Zroop NFT Agent Bot

**Zroop NFT Agent Bot is a Telegram-based service designed to provide users with timely notifications about events related to their NFT collections in the Forma network.** It allows users to link their Telegram accounts with EVM wallet addresses, verifying ownership to enable personalized alerts. Currently, the bot focuses on collections tracked by the Modularium marketplace, offering floor price and best offer change notifications.

The system aims to be a user-friendly tool for NFT enthusiasts to stay updated on their assets without needing constant manual checks or complex wallet interactions for a_string_var = """Hello World!""" 
a_second_one = 'How's life?'
another = "Yo!"
'''their primary alert features.

## Key Features (Current)

*   **Wallet Linking & Proof of Ownership:** Securely link your Telegram ID to an EVM wallet address.
*   **NFT Event Alerts:** Receive notifications for:
    *   Floor price changes for collections on Modularium.
    *   Best offer changes for collections on Modularium.
*   **"My NFTs" Overview:** The in-app terminal (WebApp) displays all NFTs owned by the user on the Forma blockchain.
*   **User-Friendly Interface:** Manage alerts and view NFT information via a Telegram WebApp.

## Project Structure

```
/
├── src/                        # Source code
│   ├── backend/                # Backend application
│   │   ├── api/                # API routes
│   │   │   └── v1/             # API version 1
│   │   │       ├── users.ts    # User profile, NFT, and alert subscription routes
│   │   │       ├── collections.ts # Collection data routes
│   │   │       └── proof.ts    # Wallet proof verification routes
│   │   ├── database/           # Database operations
│   │   │   └── db.ts           # SQLite module
│   │   ├── services/           # Business logic
│   │   │   ├── marketplaceService.ts # Interacts with NFT marketplace APIs (e.g., Modularium)
│   │   │   ├── nftChecker.ts   # NFT ownership verification for specific project NFTs
│   │   │   ├── proofChecker.ts # Wallet ownership proof transaction finder (uses Forma Explorer GraphQL)
│   │   │   ├── proofVerificationService.ts # Manages and processes proof_tasks lifecycle
│   │   │   ├── NftMetadataService.ts # Fetches and parses NFT metadata from on-chain (tokenURI/uri)
│   │   │   ├── alertService.ts   # Manages alert subscriptions CRUD and sending notifications
│   │   │   ├── AlertProcessorService.ts # Periodically checks alert conditions and triggers notifications
│   │   │   ├── profileService.ts # Aggregates data for user profiles
│   │   │   └── housekeepingService.ts # Performs periodic cleanup tasks (e.g., old proof_tasks)
│   │   ├── utils/              # Backend utilities
│   │   └── server.ts           # Main backend server file
│   ├── bot/                    # Telegram bot
│   │   ├── bot.ts              # Telegram bot logic (commands, polling for proof status)
│   │   ├── anti-abuse.ts       # Anti-abuse protection middleware
│   │   └── ANTI_ABUSE.md       # Anti-abuse system documentation
│   ├── shared/                 # Shared code (types, utils) between backend and potentially other parts
│   │   ├── types/              # TypeScript types and interfaces
│   │   ├── config/             # Configuration files or constants (if any)
│   │   └── utils/              # Common utilities
│   │       ├── crypto.ts       # Cryptographic functions (hashing, encryption)
│   │       └── modularium-queries.ts # GraphQL queries for Modularium API
│   └── index.ts                # Main entry point (spawns backend and bot processes)
├── dist/                       # Compiled JavaScript code (output of `pnpm run build`)
├── frontend/                   # Terminal web interface (WebApp)
│   └── templates/              # HTML templates (e.g., interface.html)
│       └── interface.html      # Main WebApp interface
├── tests/                      # Automated tests (e.g., using Jest)
├── db/                         # SQLite database directory (ensure .gitkeep is present if dir is empty)
│   └── .gitkeep                # Placeholder to keep the directory in git
├── certs/                      # SSL certificates (if used, e.g., for local HTTPS)
├── logs/                       # Application logs (gitignored)
├── .env                        # Environment variables (gitignored)
├── .env.example                # Example environment variables
├── Dockerfile                  # Defines the Docker image build process
├── .dockerignore               # Specifies files to exclude from Docker build context
├── ecosystem.config.js         # PM2 configuration for running apps in Docker
├── package.json                # Project dependencies and scripts
├── pnpm-lock.yaml              # Exact versions of dependencies for pnpm
├── nodemon.json                # Configuration for nodemon (used by `pnpm run dev`)
└── tsconfig.json               # TypeScript compiler configuration
```

---

## ⚠️ Marketplace & Collection Mapping Modules

> **Note:**  
> The following files are **not included** in the public repository:
>
> - `src/backend/services/marketplaceService.ts`
> - `src/backend/services/collection-mappings.ts`
>
> Instead, you will find stub modules with the prefix `Dummy_`:
>
> - `src/backend/services/Dummy_marketplaceService.ts`
> - `src/backend/services/Dummy_collection-mappings.ts`
>
> These stubs only provide the interface and empty implementations.  
> **They do not contain any real business logic.**
>
> If you want to use this project in production, you must implement your own versions of these modules according to your needs and the provided interfaces.

---

## Installation and Running

### Environment Setup

1.  Clone the repository:
    ```bash
    git clone https://github.com/buzzadont/zroop-agent-bot.git
    cd zroop-agent-bot
    ```

2.  **Install pnpm (if not already installed):**
    ```bash
    npm install -g pnpm
    ```

3.  Install dependencies using pnpm:
    ```bash
    pnpm install
    ```
    **Note:** After the first installation, you might need to approve build scripts for certain packages (like `better-sqlite3`, `sharp`). If prompted by pnpm, run:
    ```bash
    pnpm approve-builds
    ```
    And allow the necessary packages to build.

4.  Create a `.env` file based on the example:
    ```bash
    cp .env.example .env
    # Edit .env with your settings
    ```
    Ensure all necessary variables are set, including `BOT_TOKEN`, `CHECK_WALLET`, `SALT`, `DB_PATH`, RPC URLs (`FORMA_RPC_URL`), GraphQL URLs (`FORMA_EXPLORER_GRAPHQL_URL`), marketplace API details (`MODULARIUM_API_URL`, `MODULARIUM_API_KEY`), etc.

5.  Build the project:
    ```bash
    pnpm run build
    ```

### Running the Application

The main way to run the application for development (which starts both the backend server and the Telegram bot with hot-reloading) is:
```bash
pnpm run dev
```
This uses `nodemon` to monitor `src/` and restarts the application (via `ts-node src/index.ts`) on changes.

To run the compiled version (after `pnpm run build`):
```bash
pnpm start 
```
This will run the `dist/index.js` script, which starts both the backend server and the Telegram bot.

### Deployment with Docker (Recommended)

Docker is the recommended method for deploying the application as it provides a consistent environment. This project includes a `Dockerfile` for building the application image and an `ecosystem.config.js` for managing the backend and bot processes with PM2 inside the container.

For detailed instructions on building the Docker image and running the container, please refer to the **[Developer\'s Technical Guide](TECHNICAL_IMPLEMENTATION_PLAN.md#44-deployment-with-docker-recommended)**.

## Core Flow: Wallet Linking and Proof of Ownership

This robust, API-driven, and resilient system ensures a user genuinely controls a wallet. It involves the Telegram Bot, a Backend API, a background `ProofVerificationService`, and two key database tables: `wallets` (for confirmed links) and `proof_tasks` (for managing verification attempts).

1.  **User Initiates Link (Bot)**: User sends EVM wallet address via `/link` command.
2.  **Bot Validates & Calls API**: Bot validates address. If valid, calls `POST /api/v1/proof/initiate` on the backend with `telegramId`, `wallet`, and `afterTimestamp`.
3.  **Backend Creates Task**: Backend generates `taskUid`, creates a record in `proof_tasks` (status `PENDING`), calculates `check_deadline_utc`. Responds to bot with `taskUid`.
4.  **Bot Instructs User & Starts Polling**: Bot shows the designated `CHECK_WALLET` address and `deadlineMinutes` to the user, instructing them to send a 0 TIA transaction. Begins polling `GET /api/v1/proof/status/:taskUid`.
5.  **Backend Processes Task (`ProofVerificationService`)**: Periodically, this service picks up `PENDING` tasks.
    *   Sets task status to `PROCESSING`.
    *   Uses `proofChecker.ts` to search for the proof transaction (user's wallet to `CHECK_WALLET` after `after_timestamp`, before `check_deadline_utc`). The `proofChecker.ts` utilizes the GraphQL API of the Forma (Blockscout) explorer for this.
6.  **Outcome & DB Update (Backend)**:
    *   **Success**: If transaction found, `proof_tasks.status` becomes `COMPLETED_SUCCESS`. `ProofVerificationService` then updates/creates a record in `wallets` table (hashes IDs, encrypts wallet, sets `proofed = 1`, stores `raw_telegram_id`).
    *   **Failure/Expired**: If no transaction by deadline, or error, `proof_tasks.status` becomes `COMPLETED_FAILED` or `EXPIRED`.
7.  **Bot Informs User**: Based on polled status, bot notifies user of success, failure, or expiration.
    *   On `COMPLETED_SUCCESS`, bot may also call `GET /api/v1/status/:telegramId` to show full updated status.

### Key Bot Logic Changes for Proof of Ownership
*   **`/link` command**: Calls `POST /api/v1/proof/initiate` and starts polling `GET /api/v1/proof/status/:taskUid`.
*   **`/status` command**:
    *   Primarily calls `GET /api/v1/status/:telegramId` for the main status.
    *   If main status shows wallet not linked/proofed AND bot has no local polling state, it calls `GET /api/v1/proof/task/active/:telegramId` to check for ongoing backend verification.
*   **`/restart` command**: Calls `POST /api/v1/proof/task/cancel/by-telegram/:telegramId` on the backend and clears local bot state.
*   **Polling Mechanism**: Bot uses `taskUid` to poll for status updates.

### Key Implementation Learnings

During the development of the proof-of-ownership system and core functionalities, several key technical insights were gained:

*   **GraphQL Endpoint Precision:** It's crucial to use the exact API endpoint for GraphQL services (e.g., `https://explorer.forma.art/api/v1/graphql` for Blockscout) rather than the GraphiQL web interface URL, which serves HTML. This was vital for `proofChecker.ts` to reliably fetch transaction data.
*   **Hashing Consistency:** Discrepancies in hashing methods for identifiers like `telegramId` (e.g., `crypto.createHash` vs. `ethers.sha256` which might add "0x" prefixes) can lead to critical lookup failures. Standardizing on a single, centrally managed hashing function (like `hashTelegramId` from `src/shared/utils/crypto.ts`) across the application is essential for data integrity and successful lookups.

## Anti-Abuse Protection System

The bot includes a comprehensive anti-abuse protection system with features like bot blocking, rate limiting, command limiting, and blacklist/whitelist capabilities.
For detailed configuration options, see [the Anti-Abuse documentation](src/bot/ANTI_ABUSE.md).

Ensure `ADMIN_IDS` and `BLOCKED_IDS` are configured in your `.env` file.

## API Endpoints

The backend exposes REST API endpoints under the `/api/v1` prefix.

### User Wallet & General Status (Module: `users.ts` & `proof.ts`)

*   **`GET /status/:telegramId`**
    *   Retrieves linkage status, proof status, and NFT balance.
    *   Response: `{ wallet: string | null, isLinked: boolean, proofed: boolean, balance: number, hasNFT: boolean }`
*   **`POST /unlink`**
    *   Unlinks wallet, removes proof tasks, and deletes associated alert subscriptions.
    *   Body: `{ "telegramId": "string" }`
    *   Response: `{ success: boolean, message: string }`

### Proof of Ownership (Wallet Verification Specific - Module: `proof.ts`)

*   **`POST /proof/initiate`**
    *   Initiates a wallet proof task.
    *   Body: `{ "telegramId": "string", "wallet": "string", "afterTimestamp": number }`
    *   Response (201): `{ success: true, taskUid: "string", walletAddress: "string", deadlineMinutes: number, message: "Proof verification initiated." }`
*   **`GET /proof/status/:taskUid`**
    *   Retrieves status of a proof task.
    *   Response: `{ status: "PENDING" | "PROCESSING" | "COMPLETED_SUCCESS" | "COMPLETED_FAILED" | "EXPIRED" | "NOT_FOUND" | "ERROR", wallet_address?: string | null, message?: string | null }`
*   **`GET /proof/task/active/:telegramId`**
    *   Checks for active proof tasks for a user.
    *   Response: `{ isActive: boolean, taskUid?: string | null, walletAddress?: string | null, status?: string | null }`
*   **`POST /proof/task/cancel/by-telegram/:telegramId`**
    *   Attempts to cancel an active proof task.
    *   Response: `{ success: boolean, message: string }`

### User NFTs (Module: `users.ts`)

*   **`GET /users/:telegramId/nfts`**
    *   Retrieves NFTs owned by the user (linked and proofed wallet).
    *   Query Params: `page`, `limit`, `collectionAddress` (optional).
    *   Backend uses `MarketplaceService` and `hashTelegramId`.
    *   Response: Paginated list `{ nfts: [ { name, collectionName, collectionAddress, tokenId, imageUrl, floorPrice, marketplaceLink } ], pagination: { currentPage, totalPages, totalItems } }`
    *   Errors: 404 (User/wallet not found/linked/proofed), 500.

### Collection Data (Module: `collections.ts`)

*   **`GET /collections`**
    *   Retrieves a list of NFT collections (e.g., top/trending).
    *   Query Params: `sortBy` (e.g., `volume`, `floorPrice`), `sortOrder`, `limit`, `page`.
    *   Backend uses `MarketplaceService`.
    *   Response: Paginated list `{ collections: [ { name, address, description, imageUrl, totalSupply, floorPrice, volume24h, totalVolume, numOwners, marketplaceLink } ], pagination: { ... } }`
*   **`GET /collections/:collectionAddress`**
    *   Retrieves detailed information for a specific collection.
    *   `MarketplaceService` uses `NftMetadataService` for dynamic metadata of unmapped collections.
    *   Response: `{ collection: { name, address, description, imageUrl, bannerImageUrl, externalLink, totalSupply, floorPrice, volume24h, totalVolume, numOwners, marketplaces: [ { name, link } ] } }`

### Alert Subscriptions (Module: `users.ts`)
*Pre-condition for POST/DELETE: User must have a linked and proofed wallet.*

*   **`POST /users/:telegramId/alerts/subscriptions`**
    *   Creates a new alert subscription.
    *   Body: `{ type: "floor_change" | "new_mint" | ..., collectionAddress: "string", thresholdValue?: number | null }`
    *   Backend uses `AlertService` and stores `raw_telegram_id`.
    *   Response (201): `{ message: "Subscription created.", subscription: { id, type, collectionAddress, thresholdValue } }`
*   **`GET /users/:telegramId/alerts/subscriptions`**
    *   Retrieves all active alert subscriptions for a user.
    *   Response: `{ subscriptions: [ { id, type, collectionAddress, collectionName?, thresholdValue?, createdAt } ] }`
*   **`DELETE /users/:telegramId/alerts/subscriptions/:subscriptionId`**
    *   Deletes a specific alert subscription.
    *   Response (200/204): `{ message: "Subscription deleted." }`

### User Profile (Module: `users.ts`)

*   **`GET /users/:telegramId/profile`**
    *   Retrieves aggregated profile information (linked+proofed wallets, alert counts, NFT counts, activity).
    *   Response: `{ profile: { telegramId, linkedWallets: [ { address, linkedAt, proofedAt } ], trackedCollectionsCount, totalNftCount, lastTerminalVisit } }`
*   **`POST /users/:telegramId/activity/terminal-visit`**
    *   Logs a terminal visit for the user (called by WebApp).
    *   Pre-condition: Linked, proofed wallet and necessary NFT for terminal access.
    *   Updates `last_terminal_activity_at` in `wallets` table.
    *   Response (200): `{ message: "Activity logged." }`

## Database Schema

The application uses an SQLite database (default: `db/zroop.db`).

### `wallets` Table
Stores information about linked wallets, their proof status, and raw Telegram ID for notifications.

```sql
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id_hash TEXT NOT NULL UNIQUE, -- SHA-256 hash of (telegramId + SALT)
  raw_telegram_id TEXT,                 -- Raw Telegram ID, populated during proofing.
  wallet_hash TEXT NOT NULL,            -- SHA-256 hash of (lowercase_wallet_address + SALT)
  wallet_encrypted TEXT NOT NULL,       -- AES encrypted lowercase_wallet_address (key: SALT)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  proofed INTEGER DEFAULT 0,            -- 0 for false, 1 for true
  last_terminal_activity_at DATETIME    -- Timestamp of last WebApp terminal visit
);
-- Indexes on telegram_id_hash and wallet_hash. Trigger updates updated_at.
```

### `proof_tasks` Table
Manages the state of wallet proof-of-ownership verification tasks.

```sql
CREATE TABLE IF NOT EXISTS proof_tasks (
    task_uid TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    after_timestamp INTEGER NOT NULL,
    check_deadline_utc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed_success', 'completed_failed', 'expired', 'error', 'cancelled_by_user'
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Indexes on telegram_id, status, check_deadline_utc. Trigger updates updated_at.
```

### `alert_subscriptions` Table
Stores user alert subscriptions, including raw Telegram ID and per-user notification cooldown timestamps.

```sql
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id_hash TEXT NOT NULL,
  raw_telegram_id TEXT NOT NULL,
  collection_address TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- e.g., 'floor_change', 'offer_change'
  threshold_value REAL,
  is_active INTEGER DEFAULT 1,
  last_floor_notified_at TEXT, -- ISO 8601 UTC
  last_offer_notified_at TEXT, -- ISO 8601 UTC
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (telegram_id_hash) REFERENCES wallets(telegram_id_hash) ON DELETE CASCADE
);
-- Indexes on telegram_id_hash, collection_address, alert_type, is_active. Trigger updates updated_at.
```

### `modularium_collection_market_state` Table
Stores last known market prices (floor, offer) for collections from Modularium, used by `AlertProcessorService`.

```sql
CREATE TABLE IF NOT EXISTS modularium_collection_market_state (
    collection_address TEXT PRIMARY KEY,
    last_known_floor_price REAL,
    last_known_offer_price REAL,
    last_floor_price_processed_at TEXT, -- Timestamp when floor price was last processed for notifications
    last_offer_price_processed_at TEXT, -- Timestamp when offer price was last processed for notifications
    data_updated_at DATETIME,           -- Timestamp when price data was last updated from marketplace
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Trigger updates updated_at.
```

## Security and Data Handling
*   **Hashing**: `telegramId` (for `wallets` table) and `wallet` addresses are hashed (SHA-256 with `SALT`) before being stored or used in lookups.
*   **Encryption**: The raw `wallet` address is encrypted (AES using `SALT` as the key) and stored in `wallet_encrypted`.
*   **SALT**: A secret `SALT` (from `.env`) is used in both hashing and as the encryption key. Ensure it's strong and unique.
*   The `proof_tasks` table stores `telegram_id` raw for backend task management.
*   The `alert_subscriptions` table stores `raw_telegram_id` for direct notifications by `AlertProcessorService`.
*   Protect API endpoints, especially those modifying data or exposing user info. Rate limit APIs. Validate all inputs.

## WebApp (`frontend/templates/interface.html`) Overview
The WebApp provides a user interface for interacting with NFTs and managing alerts. Key features include:
*   **"My NFTs" Tab**: Displays user's NFTs with client-side pagination and filtering (e.g., "Modularium Only").
*   **"Modularium" Tab**: Shows collections from the Modularium marketplace.
*   **"Favorites" Tab**: Displays collections for which the user has active alerts.
*   **Alert Management**: Users can toggle floor price and offer price alerts directly from collection/NFT cards using bell icons.
*   **Data Loading**: Employs parallel data loading for a smoother experience and client-side caching for NFTs and alert subscriptions.
*   **Gas Price Display**: Shows current gas price on the Forma network.

(Refer to `TECHNICAL_IMPLEMENTATION_PLAN.md` section 6 for more detailed WebApp changes if needed).

## Future Plans

The Zroop NFT Agent Bot is envisioned to evolve with the following enhancements:

*   **Expanded Blockchain & Marketplace Support:** While currently focused on the Forma network and Modularium marketplace, a primary goal is to integrate support for additional blockchains (e.g., Ethereum, Base) and other NFT marketplaces.
*   **Universal Alert Configuration:** Users will be able to set up alerts for any NFT collection on supported networks by directly providing the contract address via the "Terminal" tab in the WebApp. This will allow monitoring beyond collections pre-listed on specific marketplaces.
*   **Modular Architecture:** The backend services are being designed with modularity in mind, aiming to simplify the process of adding new network and marketplace integrations by developing and "plugging in" new modules.
*   **Enhanced User Features (Long-term):**
    *   **Advanced Alert Types:** Introducing more sophisticated alert conditions.
    *   **Web3 Portal:** Potential development of a full-fledged Web3 website where users can connect their wallets for advanced interactions, such as participating in or creating governance votes related to NFT communities.
*   **Simplified Interactions:** Continue to prioritize features that do not require users to sign wallet transactions for core alert and monitoring functionalities, maintaining a low barrier to entry.

---

*This README provides a general overview. For more specific technical details on the proof-of-ownership system and initial API design, please refer to `TECHNICAL_IMPLEMENTATION_PLAN.md` (though some information may be superseded by this README or deprecated as the project evolves).* 