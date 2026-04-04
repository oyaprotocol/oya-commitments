/**
 * Build and display the reimbursement proposal for manual review.
 * Does NOT post the bond — just shows exactly what would be proposed.
 */
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const RPC_URL = process.env.RPC_URL;

const SAFE = '0x0b8f80755D2621C62D669e2aBd7B8ABA73230887';
const TRADING_WALLET = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const YES_TOKEN_ID = '77893140510362582253172593084218413010407941075415081594586195705930819989216';
const OG_MODULE = '0xDA99A5B4c181D673275c3253EA3cf90E98eD2C27';

const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
]);
const erc1155Abi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
]);

const publicClient = createPublicClient({ chain: polygon, transport: http(RPC_URL) });

// Check current balances
console.log('=== Current State ===');

const safeUsdc = await publicClient.readContract({
    address: USDC_E, abi: erc20Abi, functionName: 'balanceOf', args: [SAFE],
});
console.log(`Safe USDC.e balance: ${safeUsdc} wei (${Number(safeUsdc) / 1e6} USDC)`);

const safeYes = await publicClient.readContract({
    address: CTF_CONTRACT, abi: erc1155Abi, functionName: 'balanceOf',
    args: [SAFE, BigInt(YES_TOKEN_ID)],
});
console.log(`Safe YES token balance: ${safeYes}`);

const walletUsdc = await publicClient.readContract({
    address: USDC_E, abi: erc20Abi, functionName: 'balanceOf', args: [TRADING_WALLET],
});
console.log(`Trading wallet USDC.e balance: ${walletUsdc} wei (${Number(walletUsdc) / 1e6} USDC)`);

// Build the reimbursement proposal
// Per commitment: reimburse the full Safe USDC balance to the trading wallet
const reimbursementAmount = safeUsdc;

const transferData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(TRADING_WALLET), reimbursementAmount],
});

const transaction = {
    to: getAddress(USDC_E),
    value: '0',
    data: transferData,
    operation: 0,
};

console.log('\n========================================');
console.log('REIMBURSEMENT PROPOSAL (for review)');
console.log('========================================');
console.log(`\nThis proposal, if executed, will transfer USDC.e from the Safe to the trading wallet.`);
console.log(`\nSafe address:          ${SAFE}`);
console.log(`OG Module:             ${OG_MODULE}`);
console.log(`\nTransaction details:`);
console.log(`  Action:              ERC-20 transfer`);
console.log(`  Token:               ${USDC_E} (USDC.e)`);
console.log(`  From:                ${SAFE} (Safe)`);
console.log(`  To:                  ${TRADING_WALLET} (trading wallet)`);
console.log(`  Amount:              ${reimbursementAmount} wei (${Number(reimbursementAmount) / 1e6} USDC)`);
console.log(`  Data:                ${transferData}`);
console.log(`  Operation:           0 (Call)`);

console.log(`\nContext:`);
console.log(`  The trading wallet spent 9.9 USDC.e to buy 99 Hormuz YES tokens`);
console.log(`  Those tokens are now deposited in the Safe (balance: ${safeYes})`);
console.log(`  The reimbursement returns ${Number(reimbursementAmount) / 1e6} USDC to the trading wallet`);
console.log(`  This matches the commitment: "proposes one reimbursement transfer for all of the USDC in the Safe"`);

console.log('\n========================================');
console.log('To submit this proposal, set PROPOSE_REQUIRES_APPROVAL=false');
console.log('in .env and restart the agent, or run a separate proposal script.');
console.log('========================================');
