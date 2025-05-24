// Simple script to fetch gas price information from Forma blockchain
const { ethers } = require('ethers');

// RPC URL for Forma
const FORMA_RPC = process.env.FORMA_RPC || 'https://rpc.forma.art';

async function getGasPrice() {
  try {
    //console.log(`Connecting to Forma RPC: ${FORMA_RPC}`);
    const provider = new ethers.JsonRpcProvider(FORMA_RPC);
    
    // Get fee data
    //console.log('Fetching gas price data...');
    const feeData = await provider.getFeeData();
    
    if (!feeData || !feeData.gasPrice) {
      console.error('Failed to get gas price from RPC');
      return;
    }
    
    // Format gas price data
    const gasPrice = feeData.gasPrice;
    const gweiValue = Number(gasPrice) / 1e9;
    const tiaValue = Number(gasPrice) / 1e18;
    
    //console.log('\n=== FORMA BLOCKCHAIN GAS PRICE INFO ===');
    //console.log(`Current Gas Price: ${gasPrice.toString()} wei`);
    //console.log(`                   ${gweiValue.toFixed(2)} Gwei`);
    //console.log(`                   ${tiaValue.toFixed(9)} TIA`);
    
    if (feeData.maxFeePerGas) {
      //console.log(`Max Fee Per Gas:   ${feeData.maxFeePerGas.toString()} wei`);
    }
    
    // Calculate some recommended gas prices
    const slowGasPrice = gasPrice * BigInt(8) / BigInt(10); // 80% of current
    const fastGasPrice = gasPrice * BigInt(15) / BigInt(10); // 150% of current
    
    //console.log('\n--- Recommended Gas Prices ---');
    //console.log(`Slow:     ${slowGasPrice.toString()} wei (${(Number(slowGasPrice) / 1e9).toFixed(2)} Gwei)`);
    //console.log(`Standard: ${gasPrice.toString()} wei (${gweiValue.toFixed(2)} Gwei)`);
    //console.log(`Fast:     ${fastGasPrice.toString()} wei (${(Number(fastGasPrice) / 1e9).toFixed(2)} Gwei)`);
    
    //console.log('\n--- Estimated Confirmation Times ---');
    //console.log('Slow:     ~60 seconds');
    //console.log('Standard: ~30 seconds');
    //console.log('Fast:     ~15 seconds');
  } catch (error) {
    console.error('Error fetching gas price:', error);
  }
}

// Execute the function
getGasPrice(); 