import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import fs from 'node:fs';

const PRIVATE_KEY = '0x675714560e0dbb61bf4d6b2fe8d33c0e49fbbbf10725bd2714021d2b449a787d';
const ENV_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const HOST = 'https://clob.polymarket.com';

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
    account, chain: polygon, transport: http(),
});

// Step 1: Derive the API key to get the REAL secret from the server
console.log('=== Step 1: Get real secret from server ===');
const ts = Math.floor(Date.now() / 1000);
const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
const types = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
    ],
};

const l1Sig = await walletClient.signTypedData({
    account, domain, types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(ts),
        nonce: BigInt(0),
        message: 'This message attests that I control the given wallet',
    },
});

const res = await fetch(`${HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
        'POLY_ADDRESS': account.address,
        'POLY_SIGNATURE': l1Sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_NONCE': '0',
    },
});
const creds = await res.json();
console.log('Server returned:', JSON.stringify(creds, null, 2));

const serverSecret = creds.secret;
console.log('\n=== Step 2: Compare secrets byte-by-byte ===');
console.log('ENV secret length:', ENV_SECRET.length);
console.log('Server secret length:', serverSecret.length);
console.log('ENV secret   :', JSON.stringify(ENV_SECRET));
console.log('Server secret:', JSON.stringify(serverSecret));

// Byte-by-byte comparison
for (let i = 0; i < Math.max(ENV_SECRET.length, serverSecret.length); i++) {
    const a = ENV_SECRET.charCodeAt(i);
    const b = serverSecret.charCodeAt(i);
    if (a !== b) {
        console.log(`DIFFERENCE at index ${i}: env=0x${a?.toString(16)} ('${ENV_SECRET[i]}') vs server=0x${b?.toString(16)} ('${serverSecret[i]}')`);
    }
}

if (ENV_SECRET === serverSecret) {
    console.log('Secrets are IDENTICAL (the earlier false may have been a different run)');
} else {
    console.log('\n*** SECRETS ARE DIFFERENT! The .env file has the WRONG secret ***');
}

// Step 3: Test L2 auth with the SERVER's secret
console.log('\n=== Step 3: Test L2 auth with SERVER secret ===');
function buildL2Headers(method, path, body, secret) {
    const ts = Math.floor(Date.now() / 1000);
    let msg = `${ts}${method}${path}`;
    if (body) msg += body;
    const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(msg).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_');
    return {
        'POLY_ADDRESS': account.address,
        'POLY_API_KEY': creds.apiKey,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_PASSPHRASE': creds.passphrase,
    };
}

// Test with server secret
let headers = buildL2Headers('GET', '/trades', undefined, serverSecret);
let r = await fetch(`${HOST}/trades`, { method: 'GET', headers });
console.log(`GET /trades (server secret): ${r.status} ${await r.text()}`);

// Test balance
headers = buildL2Headers('GET', '/balance-allowance?asset_type=COLLATERAL', undefined, serverSecret);
r = await fetch(`${HOST}/balance-allowance?asset_type=COLLATERAL`, { method: 'GET', headers });
console.log(`GET /balance-allowance (server secret): ${r.status} ${await r.text()}`);

// Test cancel-all
headers = buildL2Headers('DELETE', '/cancel-all', undefined, serverSecret);
r = await fetch(`${HOST}/cancel-all`, { method: 'DELETE', headers });
console.log(`DELETE /cancel-all (server secret): ${r.status} ${await r.text()}`);

// If server secret worked, update the .env file
if (serverSecret !== ENV_SECRET) {
    console.log('\n=== Step 4: Update .env file with correct secret ===');
    const envPath = new URL('.env', import.meta.url).pathname;
    let envContent = fs.readFileSync(envPath, 'utf-8');
    const updated = envContent.replace(
        `POLYMARKET_CLOB_API_SECRET=${ENV_SECRET}`,
        `POLYMARKET_CLOB_API_SECRET=${serverSecret}`
    );
    if (updated !== envContent) {
        fs.writeFileSync(envPath, updated);
        console.log('Updated .env with correct secret!');
        console.log(`Old: ${ENV_SECRET}`);
        console.log(`New: ${serverSecret}`);
    } else {
        console.log('Could not find old secret in .env to replace.');
        console.log(`Please manually update POLYMARKET_CLOB_API_SECRET to: ${serverSecret}`);
    }
}
