export const FORMA_RPC = process.env.FORMA_RPC || 'https://rpc.forma.art';
export const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
export const CHECK_WALLET = process.env.CHECK_WALLET;

export const NETWORKS = {
    FORMA: {
        id: 984122,
        name: 'Forma Mainnet',
        network: 'forma',
        nativeCurrency: {
            decimals: 18,
            name: 'TIA',
            symbol: 'TIA',
        },
        rpcUrls: {
            default: { http: [FORMA_RPC] },
            public: { http: [FORMA_RPC] }
        },
        blockExplorers: {
            default: { name: 'Forma Explorer', url: 'https://explorer.forma.art' }
        },
        fees: {
            minGasPrice: '18000000000'
        }
    },
    BASE: {
        id: 8453,
        name: 'Base',
        network: 'base',
        nativeCurrency: {
            decimals: 18,
            name: 'Ethereum',
            symbol: 'ETH',
        },
        rpcUrls: {
            default: { http: [BASE_RPC] },
            public: { http: [BASE_RPC] }
        },
        blockExplorers: {
            default: { url: 'https://basescan.org' }
        }
    }
};

export const CONTRACTS = {
    NFT: {
        address: process.env.NFT_CONTRACT_ADDRESS,
        abi: [
            // ... ABI as is ...
        ]
    }
};

export const MESSAGES = {
    WELCOME: `Welcome to Zroop NFT Terminal!\n\nAvailable commands:\n> /terminal - Open NFT terminal interface\n> /status - Check wallet and NFT status\n> /ls - List available files\n> /cat <filename> - View file contents\n> /mint - Mint new NFT\n> /help - Show help message`,
    NO_NFT: '❌ You need to own an NFT to access this feature',
    OPEN_INTERFACE: 'Click the button below to open the NFT terminal:',
    ERROR: '❌ An error occurred'
};

export const WEBAPP_CONFIG = {
    title: 'Zroop NFT Terminal',
    description: 'Terminal interface for NFT holders',
    buttonText: 'Open Terminal',
    theme: {
        bg_color: '#1E1E1E',
        text_color: '#00FF00',
        hint_color: '#00FFFF',
        link_color: '#00FF00',
        button_color: '#006400',
        button_text_color: '#00FF00'
    }
};

// Alert Processor Configuration
export const ALERT_PROCESSOR_POLLING_INTERVAL_MS = 3 * 60 * 1000; // 5 minutes
export const ALERT_PROCESSOR_NOTIFICATION_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes 

// Admin IDs for special access (e.g., dev mode in WebApp)
// Comma-separated string, sourced from .env
export const ADMIN_IDS = process.env.ADMIN_IDS || '';

// Default deadline for proof verification tasks in minutes
export const PROOF_TASK_DEADLINE_MINUTES = 20;

// Max attempts for ProofVerificationService to process a task
export const PROOF_RETRY_LIMIT = 7;

// Interval for ProofVerificationService to run its processing cycle
export const PROOF_CHECK_INTERVAL_MS = 30 * 1000;

// Max attempts for a single GraphQL call within proofChecker.ts
export const MAX_API_CALL_ATTEMPTS = 5;

// Max transactions to scan per user wallet for proof
// ... existing code ... 