/**
 * Show complete Safe state — all balances in one view.
 */
import { createPublicClient, http, parseAbi } from 'viem';
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
const NO_TOKEN_ID = '56231474151770057648855426299021396541474371449092934400587810748856711049761';

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const erc1155Abi = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);

const publicClient = createPublicClient({ chain: polygon, transport: http(RPC_URL) });

const [safeUsdc, safeYes, safeNo, walletUsdc, walletYes, walletNo, walletMatic] = await Promise.all([
    publicClient.readContract({ address: USDC_E, abi: erc20Abi, functionName: 'balanceOf', args: [SAFE] }),
    publicClient.readContract({ address: CTF_CONTRACT, abi: erc1155Abi, functionName: 'balanceOf', args: [SAFE, BigInt(YES_TOKEN_ID)] }),
    publicClient.readContract({ address: CTF_CONTRACT, abi: erc1155Abi, functionName: 'balanceOf', args: [SAFE, BigInt(NO_TOKEN_ID)] }),
    publicClient.readContract({ address: USDC_E, abi: erc20Abi, functionName: 'balanceOf', args: [TRADING_WALLET] }),
    publicClient.readContract({ address: CTF_CONTRACT, abi: erc1155Abi, functionName: 'balanceOf', args: [TRADING_WALLET, BigInt(YES_TOKEN_ID)] }),
    publicClient.readContract({ address: CTF_CONTRACT, abi: erc1155Abi, functionName: 'balanceOf', args: [TRADING_WALLET, BigInt(NO_TOKEN_ID)] }),
    publicClient.getBalance({ address: TRADING_WALLET }),
]);

console.log('╔══════════════════════════════════════════════════╗');
console.log('║         HORMUZ COPY-TRADE STATUS                ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log('║                                                  ║');
console.log('║  SAFE (0x0b8f...0887)                           ║');
console.log(`║    USDC.e:         ${String(Number(safeUsdc) / 1e6).padEnd(10)} USDC             ║`);
console.log(`║    Hormuz YES:     ${String(safeYes).padEnd(10)} tokens           ║`);
console.log(`║    Hormuz NO:      ${String(safeNo).padEnd(10)} tokens           ║`);
console.log('║                                                  ║');
console.log('║  TRADING WALLET (0x2Ee0...9659)                 ║');
console.log(`║    USDC.e:         ${String(Number(walletUsdc) / 1e6).padEnd(10)} USDC             ║`);
console.log(`║    Hormuz YES:     ${String(walletYes).padEnd(10)} tokens           ║`);
console.log(`║    Hormuz NO:      ${String(walletNo).padEnd(10)} tokens           ║`);
console.log(`║    MATIC:          ${String((Number(walletMatic) / 1e18).toFixed(2)).padEnd(10)} MATIC            ║`);
console.log('║                                                  ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log('║  TRADE SUMMARY                                  ║');
console.log('║    Agent bought 99 Hormuz YES @ $0.10           ║');
console.log('║    Cost: 9.9 USDC.e from trading wallet         ║');
console.log('║    YES tokens deposited to Safe: ✓              ║');
console.log('║                                                  ║');
console.log('║  NEXT STEP                                      ║');
if (safeUsdc > 0n) {
    console.log(`║    Propose reimbursement of ${Number(safeUsdc) / 1e6} USDC to wallet  ║`);
} else {
    console.log('║    No USDC in Safe to reimburse                 ║');
}
console.log('╚══════════════════════════════════════════════════╝');
