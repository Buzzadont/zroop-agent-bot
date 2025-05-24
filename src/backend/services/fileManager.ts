import { createPublicClient, http, type Chain } from 'viem';
import { NETWORKS, CONTRACTS } from '../../shared/utils/constants';
import logger from '../../shared/utils/logger';

class FileManager {
    client: ReturnType<typeof createPublicClient>;
    constructor() {
        this.client = createPublicClient({
            chain: NETWORKS.FORMA as Chain,
            transport: http(NETWORKS.FORMA.rpcUrls.default.http[0])
        });
    }

    async getFiles(): Promise<any> {
        try {
            const files = await this.client.readContract({
                address: CONTRACTS.NFT.address as `0x${string}`,
                abi: CONTRACTS.NFT.abi,
                functionName: 'files'
            });
            return files;
        } catch (error: any) {
            logger.error({ err: error }, 'Error getting files:');
            throw new Error(`Failed to get files: ${error.message}`);
        }
    }

    async getFileContents(fileName: string): Promise<any> {
        try {
            const contents = await this.client.readContract({
                address: CONTRACTS.NFT.address as `0x${string}`,
                abi: CONTRACTS.NFT.abi,
                functionName: 'fileContents',
                args: [fileName]
            });
            return contents;
        } catch (error: any) {
            logger.error({ err: error, fileName }, 'Error getting file contents:');
            throw new Error(`Failed to get file contents: ${error.message}`);
        }
    }

    async addFile(fileName: string, fileParts: any, walletAddress: string): Promise<any> {
        try {
            const { request } = await this.client.simulateContract({
                address: CONTRACTS.NFT.address as `0x${string}`,
                abi: CONTRACTS.NFT.abi,
                functionName: 'addFile',
                args: [fileName, fileParts],
                account: walletAddress as `0x${string}`
            });
            return request;
        } catch (error: any) {
            logger.error({ err: error, fileName, walletAddress }, 'Error adding file:');
            throw new Error(`Failed to add file: ${error.message}`);
        }
    }
}

export default new FileManager(); 