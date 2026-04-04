import crypto from 'node:crypto';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = '0x675714560e0dbb61bf4d6b2fe8d33c0e49fbbbf10725bd2714021d2b449a787d';
const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const account = privateKeyToAccount(PRIVATE_KEY);
console.log('Wallet address:', account.address);

const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
});

// Step 1: Create a BRAND NEW API key (not derive existing)
const domain = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
const types = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
    ],
};

const timestamp = Math.floor(Date.now() / 1000);
const nonce = 0;

const signature = await walletClient.signTypedData({
    account,
    domain,
    types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(timestamp),
        nonce: BigInt(nonce),
        message: 'This message attests that I control the given wallet',
    },
});

const l1Headers = {
    'POLY_ADDRESS': account.address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': String(timestamp),
    'POLY_NONCE': String(nonce),
};

console.log('\n=== Creating NEW API key (POST /auth/api-key) ===');
let newCreds;
try {
    const res = await fetch(`${HOST}/auth/api-key`, { method: 'POST', headers: l1Headers });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text}`);
    if (res.status === 200) {
        newCreds = JSON.parse(text);
    }
} catch (e) {
    console.log('Error:', e.message);
}

// If we got new creds, test them immediately
if (newCreds) {
    console.log('\n=== Testing NEW credentials ===');
    console.log('New API Key:', newCreds.apiKey);
    console.log('New Secret:', newCreds.secret);
    console.log('New Passphrase:', newCreds.passphrase);

    function buildL2(method, path, body, creds, address) {
        const ts = Math.floor(Date.now() / 1000);
        let msg = `${ts}${method}${path}`;
        if (body) msg += body;
        const secretBytes = Buffer.from(creds.secret, 'base64');
        const sig = crypto.createHmac('sha256', secretBytes).update(msg).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_');
        return {
            'POLY_ADDRESS': address,
            'POLY_API_KEY': creds.apiKey || creds.key,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': String(ts),
            'POLY_PASSPHRASE': creds.passphrase,
        };
    }

    // Test with checksummed address
    console.log('\n--- Test with checksummed address ---');
    let headers = { 'Content-Type': 'application/json', ...buildL2('GET', '/trades', undefined, newCreds, account.address) };
    let res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`GET /trades: ${res.status} ${await res.text()}`);

    // Test with lowercase address
    console.log('\n--- Test with lowercase address ---');
    headers = { 'Content-Type': 'application/json', ...buildL2('GET', '/trades', undefined, newCreds, account.address.toLowerCase()) };
    res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`GET /trades: ${res.status} ${await res.text()}`);

    // Test DELETE /cancel-all
    console.log('\n--- Test DELETE /cancel-all ---');
    headers = { 'Content-Type': 'application/json', ...buildL2('DELETE', '/cancel-all', undefined, newCreds, account.address) };
    res = await fetch(`${HOST}/cancel-all`, { method: 'DELETE', headers });
    console.log(`DELETE /cancel-all: ${res.status} ${await res.text()}`);

    console.log('\n=== UPDATE .env with these new credentials ===');
    console.log(`POLYMARKET_CLOB_API_KEY=${newCreds.apiKey}`);
    console.log(`POLYMARKET_CLOB_API_SECRET=${newCreds.secret}`);
    console.log(`POLYMARKET_CLOB_API_PASSPHRASE=${newCreds.passphrase}`);
} else {
    console.log('\nFailed to create new key. Trying with existing creds and lowercase address...');
    const creds = {
        key: '243da202-71e4-9960-69a5-71f54e97ab12',
        secret: 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=',
        passphrase: '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971',
    };

    function buildL2(method, path, body, creds, address) {
        const ts = Math.floor(Date.now() / 1000);
        let msg = `${ts}${method}${path}`;
        if (body) msg += body;
        const secretBytes = Buffer.from(creds.secret, 'base64');
        const sig = crypto.createHmac('sha256', secretBytes).update(msg).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_');
        return {
            'POLY_ADDRESS': address,
            'POLY_API_KEY': creds.key,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': String(ts),
            'POLY_PASSPHRASE': creds.passphrase,
        };
    }

    // Try lowercase
    console.log('\n--- Lowercase address ---');
    let headers = { 'Content-Type': 'application/json', ...buildL2('GET', '/trades', undefined, creds, account.address.toLowerCase()) };
    let res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`GET /trades: ${res.status} ${await res.text()}`);
}
