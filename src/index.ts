/**
 * Main entry point for Zroop NFT Agent Bot
 * Starts the backend server and Telegram bot
 */
import { spawn, ChildProcess, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import logger from './shared/utils/logger';

dotenv.config({ override: true });

// Function to terminate all existing processes before starting new ones
function killExistingProcesses() {
  return new Promise<void>((resolve) => {
    logger.info('Killing existing processes before startup...');
    
    // Terminate all node and ts-node processes (but not ngrok)
    // Use -n $$$ to exclude the current process
    exec('killall -n $$$ node ts-node 2>/dev/null || true', (error) => {
      if (error) {
        logger.info('No node/ts-node processes were found or terminated');
      } else {
        logger.info('Node/ts-node processes were successfully terminated');
      }
      
      // Give the system 2 seconds to clean up resources
      setTimeout(resolve, 2000);
    });
  });
}

// Helper to format log messages from child processes for console output
function formatLog(data: any, prefix: string): string {
  // const timestamp = new Date().toISOString(); // Timestamp is handled by the main logger now
  return `[${prefix}]: ${data.toString().trim()}`;
}

// Start backend server
let serverProcess: ChildProcess | null = null;
function startBackendServer() {
  logger.info('Starting backend server...');
  serverProcess = spawn('npx', ['ts-node', path.join(__dirname, 'backend/server.ts')]);

  serverProcess.stdout?.on('data', (data) => {
    const log = formatLog(data, 'SERVER');
    console.log(log.trim());
  });

  serverProcess.stderr?.on('data', (data) => {
    const log = formatLog(data, 'SERVER ERROR');
    console.error(log.trim());
  });

  serverProcess.on('close', (code) => {
    const log = formatLog(`Server process exited with code ${code}`, 'SERVER');
    if (code !== 0) {
        logger.warn(log.trim());
    } else {
        logger.info(log.trim());
    }

    // Restart server if it crashes
    if (code !== 0) {
      setTimeout(() => {
        startBackendServer();
      }, 5000);
    }
  });
}

// Start Telegram bot
let botProcess: ChildProcess | null = null;
function startBot() {
  logger.info('Starting Telegram bot...');
  botProcess = spawn('npx', ['ts-node', path.join(__dirname, 'bot/bot.ts')]);

  botProcess.stdout?.on('data', (data) => {
    const log = formatLog(data, 'BOT');
    console.log(log.trim());
  });

  botProcess.stderr?.on('data', (data) => {
    const log = formatLog(data, 'BOT ERROR');
    console.error(log.trim());
  });

  botProcess.on('close', (code) => {
    const log = formatLog(`Bot process exited with code ${code}`, 'BOT');
    if (code !== 0) {
        logger.warn(log.trim());
    } else {
        logger.info(log.trim());
    }

    // Restart bot if it crashes
    if (code !== 0) {
      setTimeout(() => {
        startBot();
      }, 5000);
    }
  });
}

// First terminate existing processes, then start new ones
killExistingProcesses().then(() => {
  // Start both processes
  startBackendServer();

  // Wait for backend to start before starting bot
  setTimeout(() => {
    startBot();
  }, 3000);
  
  const startupTimestamp = new Date().toISOString();
  logger.info(`[${startupTimestamp}] Zroop NFT Agent Bot started`);
});

// Handle process exit
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  
  if (serverProcess) {
    serverProcess.kill();
  }
  
  if (botProcess) {
    botProcess.kill();
  }
  
  process.exit(0);
});