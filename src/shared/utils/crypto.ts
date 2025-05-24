/**
 * Cryptographic utilities for hashing and encrypting sensitive data
 */
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

// Use a single SALT from .env, provide a default with a warning
const SALT = process.env.SALT || 'default-super-secret-salt-for-dev';
if (SALT === 'default-super-secret-salt-for-dev') {
    logger.warn('[SECURITY WARNING] Using default SALT for crypto operations. Please set a strong, unique SALT in your .env file for production!');
}

/**
 * Hashes a Telegram ID using SHA-256 with the defined SALT
 * @param telegramId - The Telegram ID to hash
 * @returns The hex-encoded hash string
 */
export function hashTelegramId(telegramId: string): string {
    return crypto.createHash('sha256')
        .update(telegramId.toString().trim() + SALT)
        .digest('hex');
}

/**
 * Hashes a wallet address using SHA-256 with the defined SALT
 * @param wallet - The wallet address to hash
 * @returns The hex-encoded hash string
 */
export function hashWallet(wallet: string): string {
    return crypto.createHash('sha256')
        .update(wallet.toString().trim().toLowerCase() + SALT)
        .digest('hex');
}

/**
 * Encrypts a wallet address using AES with the defined SALT as the key
 * @param wallet - The wallet address to encrypt
 * @returns The Base64-encoded ciphertext string
 */
export function encryptWallet(wallet: string): string {
    const walletToEncrypt = wallet.toString().trim().toLowerCase() || ' ';
    return CryptoJS.AES.encrypt(walletToEncrypt, SALT).toString();
}

/**
 * Decrypts an encrypted wallet address using AES with the defined SALT as the key
 * @param encrypted - The Base64-encoded ciphertext string
 * @returns The original decrypted wallet address, or an empty string on error
 */
export function decryptWallet(encrypted: string): string {
    if (!encrypted) return '';
    
    try {
        const bytes = CryptoJS.AES.decrypt(encrypted, SALT);
        const decrypted = bytes.toString(CryptoJS.enc.Utf8);
        
        if (decrypted === '' && encrypted) {
            logger.warn(`[Crypto] Decryption resulted in empty string for non-empty encrypted data.`);
        }
        
        return decrypted === ' ' ? '' : decrypted;
    } catch (error) {
        logger.error({ err: error }, '[Crypto] Decryption failed:');
        return '';
    }
} 