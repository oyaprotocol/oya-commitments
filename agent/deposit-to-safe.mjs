/**
 * Deposit Hormuz YES conditional tokens from trading wallet into the Safe.
 *
 * Step 1: Check ERC-1155 balance of YES tokens in trading wallet
 * Step 2: Transfer them to the Safe via safeTransferFrom
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, getAddress, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

const TRADING_WALLET = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const SAFE = '0x0b8f80755D2621C62D669e2aBd7B8ABA73230887';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Tokens on Polygon

// Hormuz YES token
const YES_TOKEN_ID = '77893140510362582253172593084218413010407941075415081594586195705930819989216';

const ERC1155_ABI = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: polygon, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: polygon, transport: http(RPC_URL) });

console.log(`Trading wallet: ${TRADING_WALLET}`);
console.log(`Safe: ${SAFE}`);
console.log(`CTF Contract: ${CTF_CONTRACT}`);
console.log(`YES Token ID: ${YES_TOKEN_ID.substring(0, 20)}...`);

// Step 1: Check balance
console.log('\n=== Step 1: Check YES token balance ===');
const balance = await publicClient.readContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: [TRADING_WALLET, BigInt(YES_TOKEN_ID)],
});
console.log(`YES token balance in trading wallet: ${balance}`);

if (balance === 0n) {
    console.log('No YES tokens to deposit. Exiting.');
    process.exit(0);
}

// Also check Safe balance
const safeBalance = await publicClient.readContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: [SAFE, BigInt(YES_TOKEN_ID)],
});
console.log(`YES token balance in Safe: ${safeBalance}`);

// Step 2: Transfer tokens to Safe
console.log(`\n=== Step 2: Transfer ${balance} YES tokens to Safe ===`);

const hash = await walletClient.writeContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'safeTransferFrom',
    args: [
        getAddress(TRADING_WALLET),
        getAddress(SAFE),
        BigInt(YES_TOKEN_ID),
        balance,
        '0x',
    ],
});
console.log(`TX: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`Status: ${receipt.status}`);

// Verify
const newBalance = await publicClient.readContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: [TRADING_WALLET, BigInt(YES_TOKEN_ID)],
});
const newSafeBalance = await publicClient.readContract({
    address: CTF_CONTRACT,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: [SAFE, BigInt(YES_TOKEN_ID)],
});
console.log(`\n=== Verification ===`);
console.log(`Trading wallet YES balance: ${newBalance}`);
console.log(`Safe YES balance: ${newSafeBalance}`);
console.log(`\nDeposit complete!`);
