/**
 * Test what the CLOB API actually returns for a FOK order to understand the response structure.
 * Uses a $1 order at a low price (won't fill, will be killed).
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
const YES_TOKEN_ID = '77893140510362582253172593084218413010407941075415081594586195705930819989216';

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
    account, chain: polygon, transport: http(process.env.RPC_URL),
});

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

const CTF_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
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

// $1 order at 1 cent — will be killed by FOK since no liquidity at this price
const collateral = 1000000; // 1 USDC
const price = 0.01;
const tokens = Math.round(collateral / price);
const salt = String(Math.round(Math.random() * Date.now()));

const signature = await walletClient.signTypedData({
    account,
    domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: getAddress(CTF_EXCHANGE) },
    types: { Order: ORDER_EIP712_TYPES },
    primaryType: 'Order',
    message: {
        salt: BigInt(salt), maker: getAddress(account.address), signer: getAddress(account.address),
        taker: zeroAddress, tokenId: BigInt(YES_TOKEN_ID), makerAmount: BigInt(collateral),
        takerAmount: BigInt(tokens), expiration: 0n, nonce: 0n, feeRateBps: 0n, side: 0, signatureType: 0,
    },
});

const apiOrder = {
    salt: Number.parseInt(salt, 10), maker: getAddress(account.address), signer: getAddress(account.address),
    taker: zeroAddress, tokenId: YES_TOKEN_ID, makerAmount: String(collateral), takerAmount: String(tokens),
    side: 'BUY', expiration: '0', nonce: '0', feeRateBps: '0', signatureType: 0, signature,
};

// Test FOK order
console.log('=== Testing FOK order response structure ===');
const fokBody = JSON.stringify({ deferExec: false, order: apiOrder, owner: API_KEY, orderType: 'FOK', postOnly: false });
const fokHeaders = buildL2Headers('POST', '/order', fokBody);
const fokRes = await fetch(`${HOST}/order`, { method: 'POST', headers: fokHeaders, body: fokBody });
const fokText = await fokRes.text();
console.log(`FOK Status: ${fokRes.status}`);
console.log(`FOK Response (raw): ${fokText}`);
try {
    const fokData = JSON.parse(fokText);
    console.log('FOK Response (parsed):', JSON.stringify(fokData, null, 2));
    console.log('\nOrder ID fields:');
    console.log('  .orderID:', fokData.orderID);
    console.log('  .id:', fokData.id);
    console.log('  .orderId:', fokData.orderId);
    console.log('  .order?.id:', fokData.order?.id);
} catch(e) { console.log('Not JSON'); }

// Also test GTC order at 1 cent (will sit in the book, can cancel after)
console.log('\n=== Testing GTC order response structure ===');
const salt2 = String(Math.round(Math.random() * Date.now()));
const sig2 = await walletClient.signTypedData({
    account,
    domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: getAddress(CTF_EXCHANGE) },
    types: { Order: ORDER_EIP712_TYPES },
    primaryType: 'Order',
    message: {
        salt: BigInt(salt2), maker: getAddress(account.address), signer: getAddress(account.address),
        taker: zeroAddress, tokenId: BigInt(YES_TOKEN_ID), makerAmount: BigInt(1000000),
        takerAmount: BigInt(100000000), expiration: 0n, nonce: 0n, feeRateBps: 0n, side: 0, signatureType: 0,
    },
});
const gtcOrder = { ...apiOrder, salt: Number.parseInt(salt2, 10), signature: sig2 };
const gtcBody = JSON.stringify({ deferExec: false, order: gtcOrder, owner: API_KEY, orderType: 'GTC', postOnly: false });
const gtcHeaders = buildL2Headers('POST', '/order', gtcBody);
const gtcRes = await fetch(`${HOST}/order`, { method: 'POST', headers: gtcHeaders, body: gtcBody });
const gtcText = await gtcRes.text();
console.log(`GTC Status: ${gtcRes.status}`);
console.log(`GTC Response (raw): ${gtcText}`);
try {
    const gtcData = JSON.parse(gtcText);
    console.log('GTC Response (parsed):', JSON.stringify(gtcData, null, 2));
    console.log('\nOrder ID fields:');
    console.log('  .orderID:', gtcData.orderID);
    console.log('  .id:', gtcData.id);
    console.log('  .orderId:', gtcData.orderId);
    console.log('  .order?.id:', gtcData.order?.id);

    // Cancel the GTC order
    if (gtcData.orderID || gtcData.id) {
        const oid = gtcData.orderID || gtcData.id;
        console.log(`\nCancelling GTC order ${oid}...`);
        const cancelBody = JSON.stringify([oid]);
        const cancelHeaders = buildL2Headers('DELETE', '/order', cancelBody);
        const cancelRes = await fetch(`${HOST}/order`, { method: 'DELETE', headers: cancelHeaders, body: cancelBody });
        console.log(`Cancel: ${cancelRes.status} ${await cancelRes.text()}`);
    }
} catch(e) { console.log('Not JSON'); }
