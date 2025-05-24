# Zroop NFT Agent Bot: Developer's Technical Guide

This document serves as a technical guide for developers working on the Zroop NFT Agent Bot. It provides a high-level overview of the existing architecture and, more importantly, outlines how to extend its functionality, particularly by adding support for new blockchains, NFT marketplaces, and alert types.

For a general user-facing overview, project setup, and current features, please refer to `README.md`.

## 1. Core System Overview (Implemented Features)

This section briefly describes the main components and processes that are already implemented.

### ⚠️ Marketplace & Collection Mapping Modules

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

### 1.1. Wallet Linking & Proof of Ownership

*   **Purpose:** Securely links a user's Telegram ID to an EVM wallet and verifies their control over it.
*   **Core Flow:**
    1.  User initiates via `/link` (Bot).
    2.  Bot calls `POST /api/v1/proof/initiate` (Backend).
    3.  Backend creates a `proof_tasks` entry and returns a `taskUid`.
    4.  User sends a zero-value transaction to a `CHECK_WALLET`.
    5.  `ProofVerificationService` (Backend Service) periodically picks up pending tasks.
    6.  `proofChecker.ts` (Backend Service) scans the blockchain (Forma via GraphQL) for the transaction.
    7.  On success, `wallets` table is updated (`proofed = 1`), task status becomes `COMPLETED_SUCCESS`.
    8.  Bot polls `GET /api/v1/proof/status/:taskUid` and informs the user.
*   **Developer Notes:**
    *   `proofChecker.ts` uses the Forma (Blockscout) GraphQL API (`https://explorer.forma.art/api/v1/graphql`). Ensure `FORMA_EXPLORER_GRAPHQL_URL` is correct.
    *   `telegramId` hashing is standardized via `shared/utils/crypto.ts#hashTelegramId`. Consistent use is critical.
    *   The `CHECK_WALLET` address and `SALT` for encryption/hashing are critical environment variables.

### 1.2. API Endpoints (Backend - `/api/v1/`)

A brief overview of key API endpoint groups. Detailed request/response structures are in the code or can be inferred from `README.md`.

*   **User Wallet & Status (`users.ts`, `proof.ts`):** `/status/:telegramId`, `/unlink`, `/proof/initiate`, `/proof/status/:taskUid`, `/proof/task/active/:telegramId`, `/proof/task/cancel/by-telegram/:telegramId`.
*   **User NFTs (`users.ts`):** `GET /users/:telegramId/nfts` (utilizes `MarketplaceService` and `UserNftService`).
*   **Collection Data (`collections.ts`):** `GET /collections`, `GET /collections/:collectionAddress` (utilizes `MarketplaceService`, which in turn uses `NftMetadataService`).
*   **Alert Subscriptions (`users.ts`):** `POST /users/:telegramId/alerts/subscriptions`, `GET /users/:telegramId/alerts/subscriptions`, `DELETE /users/:telegramId/alerts/subscriptions/:subscriptionId`.
*   **User Profile (`users.ts`):** `GET /users/:telegramId/profile`, `POST /users/:telegramId/activity/terminal-visit`.

### 1.3. Key Backend Services

*   **`ProofVerificationService.ts`:** Manages proof task lifecycle.
*   **`proofChecker.ts`:** Blockchain scanner for proof transactions (currently Forma GraphQL).
*   **`NftMetadataService.ts`:** Fetches on-chain NFT metadata (`tokenURI`/`uri`).
    *   *Developer Note:* Resolves IPFS links and handles base64 encoded JSON. Uses `viem` for public client interactions.
*   **`MarketplaceService.ts`:** Abstracts interactions with external marketplace APIs (initially Modularium).
    *   *Developer Note:* Responsible for fetching user NFTs, collection data, and floor/offer prices. Uses `NftMetadataService` for on-chain enrichment where necessary. Contains logic for `collection-mappings.ts`.
*   **`UserNftService.ts`:** Aggregates and processes user NFT data, often using `MarketplaceService`.
    *   *Developer Note:* Includes logic for `isModulariumMarketplace` flag based on `fetchAllowedCollectionAddressesGraphQL`.
*   **`AlertService.ts`:** Manages CRUD for `alert_subscriptions` and triggers direct Telegram API calls for notifications.
    *   *Developer Note:* Directly calls Telegram Bot API to send messages, bypassing the running bot instance to avoid conflicts when deployed separately.
*   **`AlertProcessorService.ts`:** Periodically checks alert conditions (currently every 10 minutes) against `MarketplaceService` data and triggers notifications via `AlertService`.
    *   *Developer Note:* Uses `modularium_collection_market_state` table for cooldowns and state tracking per collection.
*   **`ProfileService.ts`:** Aggregates data for user profiles.
*   **`HousekeepingService.ts`:** Cleans up old `proof_tasks`.

### 1.4. Database Schema

Core tables (SQLite):

*   **`wallets`**: Stores `telegram_id_hash`, encrypted wallet, `proofed` status, `raw_telegram_id`.
*   **`proof_tasks`**: Manages wallet verification task states.
*   **`alert_subscriptions`**: User alert preferences, including `raw_telegram_id`, `last_floor_notified_at`, `last_offer_notified_at`.
*   **`modularium_collection_market_state`**: Tracks last known market prices and processing timestamps for collections to manage alert notifications globally for collections.

    *Developer Note:* `raw_telegram_id` is stored in `wallets` and `alert_subscriptions` to allow services like `AlertProcessorService` to directly message users without needing to reverse hashes, especially when the main bot process might be separate.

### 1.5. Telegram Bot (`bot/bot.ts`)

*   Handles user commands (`/link`, `/status`, `/unlink`, `/restart`, `/terminal`, `/help`).
*   Manages polling for `proof_tasks` status updates.
*   Interacts with backend API endpoints.

### 1.6. WebApp (`frontend/templates/interface.html`)

*   Provides a user interface for viewing Modularium collections, user's NFTs (on Forma), and managing alert subscriptions.
*   Features client-side pagination, filtering ("Modularium Only" for user NFTs), and alert icon buttons.
*   Loads data via backend API calls.

## 2. Developer Guide: Extending the System

This section provides guidance on how to add new functionalities, such as support for new blockchains, marketplaces, or alert types.

### 2.1. General Principles for Modularity

*   **Service Abstraction:** Encapsulate interactions with external services (blockchain nodes, marketplace APIs) within dedicated backend services (e.g., `MarketplaceService`, `proofChecker.ts`).
*   **Configuration Management:** Store external URLs, API keys, and other integration-specific parameters in environment variables (`.env`) and access them via `process.env`.
*   **Shared Types:** Define common data structures in `src/shared/types/` to ensure consistency between frontend, backend, and bot.
*   **Database Migrations (if schema changes):** While currently using SQLite with `IF NOT EXISTS` for simplicity, significant schema changes for new features might require a more formal migration strategy if the project grows.

### 2.2. Adding Support for a New Blockchain

Adding a new blockchain (e.g., Ethereum, Base) involves several areas:

1.  **Proof of Ownership (`proofChecker.ts` & `ProofVerificationService.ts`):
    *   **Transaction Scanning:** The `proofChecker.ts` service will need a new method to scan the target blockchain for the proof-of-ownership transaction. This might involve:
        *   Identifying a suitable block explorer API (GraphQL or REST) for the new chain.
        *   Implementing the logic to query this API, similar to `findProofTransactionGraphQL` for Forma.
        *   Handling potential differences in transaction structures or API responses.
    *   **Service Adaptation:** `ProofVerificationService.ts` might need minor adjustments if the new proof checking method requires different parameters or returns data in a slightly different format, though the goal should be to conform to the existing `ProofResult` interface.
    *   **Configuration:** Add new environment variables for the new chain's RPC URL, explorer API URL, and potentially a different `CHECK_WALLET` if required.

2.  **NFT Metadata (`NftMetadataService.ts`):
    *   The current service uses `viem` and is somewhat chain-agnostic for standard ERC721/ERC1155 `tokenURI`/`uri` calls. However, ensure the `PublicClient` can be configured or instantiated for the new chain.
    *   Add the new chain's configuration to `viem/chains` or provide necessary chain-specific parameters if using custom chain definitions.
    *   Update environment variables for the new chain's RPC URL if `NftMetadataService` uses a separate client instance.

3.  **User NFT Data (`UserNftService.ts` & `MarketplaceService.ts`):
    *   If NFTs from the new chain are to be displayed, `MarketplaceService` (or a new, chain-specific service called by `UserNftService`) will need to fetch this data.
    *   This likely involves integrating with an API that indexes NFTs on the new chain (e.g., OpenSea API, Alchemy NFT API, Moralis NFT API, or a specific marketplace API for that chain).
    *   `UserNftService` will need to be updated to call the appropriate methods for the new chain, potentially based on a `network` parameter.
    *   Consider how to handle `isModulariumMarketplace` or equivalent flags for collections on the new chain.

4.  **Alerts (`AlertProcessorService.ts` & `MarketplaceService.ts`):
    *   If alerts are to be supported for collections on the new chain, `MarketplaceService` must be able to fetch relevant data (floor prices, offers) for those collections.
    *   `AlertProcessorService` logic for grouping subscriptions and fetching market data will need to accommodate the new chain, possibly by calling chain-specific methods in `MarketplaceService`.

5.  **Frontend (`interface.html`):
    *   Update network selection dropdowns (e.g., in "My NFTs", "Favorites", "Terminal" tabs) to include the new blockchain.
    *   Ensure JavaScript functions handling data loading and display can correctly pass and use the new network identifier in API calls.

6.  **Database (Potentially):
    *   No immediate changes might be needed if existing tables like `alert_subscriptions` use `collection_address` generically. However, if chain-specific data needs to be stored, schema adjustments might be necessary.

### 2.3. Adding Support for a New NFT Marketplace

Integrating a new NFT marketplace primarily impacts `MarketplaceService.ts` and potentially `AlertProcessorService.ts`.

1.  **`MarketplaceService.ts` Modifications:
    *   **API Client:** Implement methods to interact with the new marketplace's API. This could involve creating a new internal helper class or set of functions specific to that marketplace.
    *   **Data Fetching:** Add logic to fetch:
        *   Collection lists (top, trending, searchable).
        *   Detailed collection information.
        *   User NFTs (if the marketplace API provides this).
        *   Floor prices, best offers, and other market statistics.
    *   **Data Normalization:** Transform the data received from the new marketplace API into the common formats used by the Zroop bot (e.g., `CollectionItem`, `Nft` interfaces in `MarketplaceService.ts`). This is crucial for consistency in the rest of the application.
    *   **Aggregation:** If data from multiple marketplaces is to be presented in a unified way (e.g., showing the best floor price across several sources), `MarketplaceService` will need to handle this aggregation.
    *   **Configuration:** Add environment variables for the new marketplace's API base URL, API key, etc.
    *   **Collection Mappings (`collection-mappings.ts`):** If the new marketplace has its own specific collection identifiers or needs special handling for certain collections, update this mapping file.

2.  **`AlertProcessorService.ts` Modifications:
    *   If alerts should consider data from the new marketplace (e.g., its floor prices), `AlertProcessorService` will need to call `MarketplaceService` methods that incorporate this new data source.
    *   The `modularium_collection_market_state` table (or a more generically named equivalent if we expand beyond Modularium) would need to store/compare prices from this new source if it becomes an authoritative source for alerts.

3.  **Frontend (`interface.html`):
    *   If the new marketplace is a primary source or offers unique collections, you might want to add a new tab or filter options for it.
    *   Update links on NFT/collection cards if the new marketplace offers direct viewing links.

### 2.4. Adding a New Alert Type

1.  **Define Alert Type (`alertService.ts`):
    *   Add the new type to the `AlertType` enum (e.g., `LISTING_NEW`, `SALE_DETECTED`).

2.  **Database (`alert_subscriptions` table):
    *   No schema change needed if the new alert type doesn't require new specific fields (like `threshold_value` or new `last_X_notified_at` columns).
    *   If it does (e.g., an alert for sales above a certain price), you'll need to add columns to `alert_subscriptions` and update DB functions in `db.ts`.
    *   Consider if new columns are needed in `modularium_collection_market_state` for global state tracking related to this new alert type.

3.  **`MarketplaceService.ts` (Potentially):
    *   Ensure it can fetch the data necessary to trigger this new alert type (e.g., recent sales data, new listing events).

4.  **`AlertService.ts`:
    *   Update `createSubscription` if the new alert type has specific validation or requires new parameters.

5.  **`AlertProcessorService.ts` (`processAlerts` method):
    *   Add a new block of logic to handle subscriptions for this `alert_type`.
    *   Fetch the required data from `MarketplaceService`.
    *   Implement the condition checking logic.
    *   Format the notification message.
    *   Call `alertService.sendNotification`.
    *   Update relevant `last_X_notified_at` timestamps in `alert_subscriptions` and potentially global state in `modularium_collection_market_state`.
    *   Ensure the NFT ownership check is applied if relevant for this alert type.

6.  **Frontend (`interface.html`):
    *   Add UI elements (e.g., new buttons/checkboxes on NFT/collection cards or in a dedicated alert setup section) to allow users to subscribe to this new alert type.
    *   Update `handleAlertButtonClick` (or a similar handler) to correctly create/delete subscriptions for the new type.
    *   Ensure `isAlertActive` can check the new alert type.

## 3. Security Considerations (Brief)

*   **Secrets Management:** `SALT`, `BOT_TOKEN`, API keys must be kept secure in `.env` and not committed.
*   **Input Validation:** Backend should validate all inputs, especially `telegramId`, wallet addresses, and collection addresses.
*   **Rate Limiting:** API endpoints should have rate limiting (consider `express-rate-limit` or similar).
*   **Authentication/Authorization:** While bot-backend communication might be on a trusted internal network, ensure sensitive user-specific endpoints correctly verify the `telegramId` making the request if directly exposed or if authentication context is available.

---
This guide provides a starting point. Specific implementation details will vary based on the exact requirements of the new integration. 