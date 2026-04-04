/**
 * Test order placement on Polymarket CLOB.
 * Places a small BUY order for the Hormuz YES token at a low price
 * so it won't fill (limit order well below market).
 * Then cancels it immediately.
 */
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, getAddress, zeroAddress } from 'viem';
import { polygon } from 'viem/chains';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const API_KEY = process.env.POLYMARKET_CLOB_API_KEY;
const API_SECRET = process.env.POLYMARKET_CLOB_API_SECRET;
const API_PASSPHRASE = process.env.POLYMARKET_CLOB_API_PASSPHRASE;
const HOST = 'https://clob.polymarket.com';

// Hormuz market tokens from config.json
const YES_TOKEN_ID = '77893140510362582253172593084218413010407941075415081594586195705930819989216';

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
    account, chain: polygon, transport: http(process.env.RPC_URL),
});

// --- HMAC L2 auth ---
function buildL2Headers(method, path, body) {
    const ts = Math.floor(Date.now() / 1000);
    let msg = `${ts}${method}${path}`;
    if (body) msg += body;
    const sig = crypto.createHmac('sha256', Buffer.from(API_SECRET, 'base64'))
        .update(msg).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_');
    return {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': account.address,
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_PASSPHRASE': API_PASSPHRASE,
    };
}

// --- Check neg risk ---
console.log('Step 1: Check neg risk for token...');
const negRiskRes = await fetch(`${HOST}/neg-risk?token_id=${YES_TOKEN_ID}`);
const negRiskData = await negRiskRes.json();
const isNegRisk = Boolean(negRiskData?.neg_risk);
console.log(`  neg_risk: ${isNegRisk}`);

// Exchange addresses
const CTF_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const exchange = isNegRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
console.log(`  Using exchange: ${exchange}`);

// --- Get fee rate ---
console.log('\nStep 2: Get fee rate...');
const feeHeaders = buildL2Headers('GET', `/fee-rate?token_id=${YES_TOKEN_ID}`, undefined);
const feeRes = await fetch(`${HOST}/fee-rate?token_id=${YES_TOKEN_ID}`, { headers: feeHeaders });
let feeRateBps = '0';
if (feeRes.ok) {
    const feeData = await feeRes.json();
    feeRateBps = String(feeData?.base_fee ?? feeData?.fee_rate_bps ?? '0');
    console.log(`  Fee rate: ${feeRateBps} bps`);
} else {
    console.log(`  Fee rate request failed: ${feeRes.status} ${await feeRes.text()}`);
    console.log('  Using default 0');
}

// --- Get midpoint to understand current price ---
console.log('\nStep 3: Get current midpoint...');
const midRes = await fetch(`${HOST}/midpoint?token_id=${YES_TOKEN_ID}`);
const midData = await midRes.json();
console.log(`  Midpoint: ${JSON.stringify(midData)}`);

// --- Build order ---
// BUY YES at 1 cent (0.01) — well below market, won't fill
// makerAmount = collateral (USDC in 6 decimals) = 0.01 USDC = 10000
// takerAmount = tokens to receive = collateral / price = 10000 / 0.01 = 1000000
// Actually for a $0.10 spend at $0.01 price: makerAmount=100000, takerAmount=10000000
// Let's do $0.10 at 1 cent price:
const price = 0.01;  // 1 cent — way below market, won't fill
const collateral = 100000;  // 0.10 USDC (6 decimals)
const tokens = Math.round(collateral / price);

console.log('\nStep 4: Build and sign order...');
console.log(`  Side: BUY`);
console.log(`  Price: $${price}`);
console.log(`  Collateral (makerAmount): ${collateral} (${collateral / 1e6} USDC)`);
console.log(`  Tokens (takerAmount): ${tokens}`);

const salt = String(Math.round(Math.random() * Date.now()));

const orderFields = {
    salt: BigInt(salt),
    maker: getAddress(account.address),
    signer: getAddress(account.address),
    taker: zeroAddress,
    tokenId: BigInt(YES_TOKEN_ID),
    makerAmount: BigInt(collateral),
    takerAmount: BigInt(tokens),
    expiration: BigInt(0),
    nonce: BigInt(0),
    feeRateBps: BigInt(feeRateBps),
    side: 0,  // BUY
    signatureType: 0,  // EOA
};

const ORDER_EIP712_TYPES = [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
];

const signature = await walletClient.signTypedData({
    account,
    domain: {
        name: 'Polymarket CTF Exchange',
        version: '1',
        chainId: 137,
        verifyingContract: getAddress(exchange),
    },
    types: { Order: ORDER_EIP712_TYPES },
    primaryType: 'Order',
    message: orderFields,
});

console.log(`  Signature: ${signature.substring(0, 20)}...`);

// --- Place order ---
console.log('\nStep 5: Place order...');
const apiOrder = {
    salt: Number.parseInt(salt, 10),
    maker: getAddress(account.address),
    signer: getAddress(account.address),
    taker: zeroAddress,
    tokenId: YES_TOKEN_ID,
    makerAmount: String(collateral),
    takerAmount: String(tokens),
    side: 'BUY',
    expiration: '0',
    nonce: '0',
    feeRateBps: feeRateBps,
    signatureType: 0,
    signature: signature,
};

const body = JSON.stringify({
    deferExec: false,
    order: apiOrder,
    owner: API_KEY,
    orderType: 'FOK',
    postOnly: false,
});

console.log(`  Body (first 200): ${body.substring(0, 200)}`);

const orderHeaders = buildL2Headers('POST', '/order', body);
const orderRes = await fetch(`${HOST}/order`, {
    method: 'POST',
    headers: orderHeaders,
    body: body,
});
const orderText = await orderRes.text();
console.log(`  Status: ${orderRes.status}`);
console.log(`  Response: ${orderText}`);

if (orderRes.status === 200) {
    try {
        const orderData = JSON.parse(orderText);
        console.log('\n  *** ORDER PLACED SUCCESSFULLY! ***');
        console.log(`  Order ID: ${orderData.orderID || orderData.id || 'N/A'}`);
        console.log(`  Status: ${orderData.status || 'N/A'}`);

        // Cancel it
        if (orderData.orderID || orderData.id) {
            console.log('\nStep 6: Cancel order...');
            const cancelBody = JSON.stringify([orderData.orderID || orderData.id]);
            const cancelHeaders = buildL2Headers('DELETE', '/order', cancelBody);
            const cancelRes = await fetch(`${HOST}/order`, {
                method: 'DELETE',
                headers: cancelHeaders,
                body: cancelBody,
            });
            console.log(`  Cancel status: ${cancelRes.status} ${await cancelRes.text()}`);
        }
    } catch(e) { /* not json */ }
} else {
    console.log('\n  Order failed. Possible causes:');
    console.log('  - Invalid order payload (check field formats)');
    console.log('  - Insufficient balance');
    console.log('  - Exchange address mismatch');
}
