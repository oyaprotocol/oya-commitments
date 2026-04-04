/**
 * Check USDC balance and set allowance for Polymarket CTF Exchange.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, getAddress, parseAbi, maxUint256 } from 'viem';
import { polygon } from 'viem/chains';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

// USDC.e on Polygon
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Standard CTF Exchange (neg_risk=false for Hormuz market)
const CTF_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
// Neg Risk CTF Exchange (for neg risk markets)
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ERC20_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
]);

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: polygon, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: polygon, transport: http(RPC_URL) });

console.log(`Wallet: ${account.address}\n`);

// Check MATIC balance for gas
const maticBalance = await publicClient.getBalance({ address: account.address });
console.log(`MATIC balance: ${Number(maticBalance) / 1e18} MATIC`);

// Check USDC balance
const usdcBalance = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
});
console.log(`USDC.e balance: ${Number(usdcBalance) / 1e6} USDC`);

// Check allowances for both exchanges
const ctfAllowance = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'allowance',
    args: [account.address, CTF_EXCHANGE],
});
console.log(`\nCTF Exchange allowance: ${Number(ctfAllowance) / 1e6} USDC`);

const negRiskAllowance = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'allowance',
    args: [account.address, NEG_RISK_CTF_EXCHANGE],
});
console.log(`Neg Risk CTF Exchange allowance: ${Number(negRiskAllowance) / 1e6} USDC`);

// Approve both exchanges if needed
if (ctfAllowance === 0n) {
    console.log('\nApproving CTF Exchange for max USDC...');
    const hash1 = await walletClient.writeContract({
        address: USDC, abi: ERC20_ABI, functionName: 'approve',
        args: [CTF_EXCHANGE, maxUint256],
    });
    console.log(`  TX: ${hash1}`);
    const receipt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 });
    console.log(`  Status: ${receipt1.status}`);
} else {
    console.log('\nCTF Exchange already approved.');
}

if (negRiskAllowance === 0n) {
    console.log('\nApproving Neg Risk CTF Exchange for max USDC...');
    const hash2 = await walletClient.writeContract({
        address: USDC, abi: ERC20_ABI, functionName: 'approve',
        args: [NEG_RISK_CTF_EXCHANGE, maxUint256],
    });
    console.log(`  TX: ${hash2}`);
    const receipt2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
    console.log(`  Status: ${receipt2.status}`);
} else {
    console.log('Neg Risk CTF Exchange already approved.');
}

// Also need to approve the conditional tokens (CTF) contract for the exchange
// The CTF contract on Polygon:
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_1155_ABI = parseAbi([
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
]);

const ctfApproved = await publicClient.readContract({
    address: CTF_CONTRACT, abi: CTF_1155_ABI, functionName: 'isApprovedForAll',
    args: [account.address, CTF_EXCHANGE],
});
console.log(`\nCTF tokens approved for CTF Exchange: ${ctfApproved}`);

if (!ctfApproved) {
    console.log('Approving CTF tokens for CTF Exchange...');
    const hash3 = await walletClient.writeContract({
        address: CTF_CONTRACT, abi: CTF_1155_ABI, functionName: 'setApprovalForAll',
        args: [CTF_EXCHANGE, true],
    });
    console.log(`  TX: ${hash3}`);
    const receipt3 = await publicClient.waitForTransactionReceipt({ hash: hash3 });
    console.log(`  Status: ${receipt3.status}`);
}

const negRiskCtfApproved = await publicClient.readContract({
    address: CTF_CONTRACT, abi: CTF_1155_ABI, functionName: 'isApprovedForAll',
    args: [account.address, NEG_RISK_CTF_EXCHANGE],
});
console.log(`CTF tokens approved for Neg Risk CTF Exchange: ${negRiskCtfApproved}`);

if (!negRiskCtfApproved) {
    console.log('Approving CTF tokens for Neg Risk CTF Exchange...');
    const hash4 = await walletClient.writeContract({
        address: CTF_CONTRACT, abi: CTF_1155_ABI, functionName: 'setApprovalForAll',
        args: [NEG_RISK_CTF_EXCHANGE, true],
    });
    console.log(`  TX: ${hash4}`);
    const receipt4 = await publicClient.waitForTransactionReceipt({ hash: hash4 });
    console.log(`  Status: ${receipt4.status}`);
}

console.log('\n=== DONE ===');
console.log('All approvals set. You can now place orders.');
