import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = '0x675714560e0dbb61bf4d6b2fe8d33c0e49fbbbf10725bd2714021d2b449a787d';
const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const HOST = 'https://clob.polymarket.com';

const account = privateKeyToAccount(PRIVATE_KEY);

console.log('=== DIAGNOSTIC: Polymarket CLOB 401 Investigation ===\n');

// Check 1: Does our private key derive to the address we think?
console.log('CHECK 1: Address derivation');
console.log('  Private key derives to:', account.address);
console.log('  Address we use in headers:', ADDRESS);
console.log('  Match:', account.address.toLowerCase() === ADDRESS.toLowerCase());
console.log('  Checksummed match:', account.address === ADDRESS);

// Check 2: Geoblock status
console.log('\nCHECK 2: Geoblock status');
try {
    const geoRes = await fetch('https://polymarket.com/api/geoblock');
    const geoData = await geoRes.text();
    console.log('  Geoblock response:', geoData);
} catch (e) {
    console.log('  Geoblock check failed:', e.message);
    console.log('  (Try manually: curl https://polymarket.com/api/geoblock)');
}

// Check 3: L1 auth - get API keys to see what address they're bound to
console.log('\nCHECK 3: L1 Auth - List API keys (GET /auth/api-keys)');
const ts = Math.floor(Date.now() / 1000);
const nonce = 0;

// We need to do L1 auth with EIP-712 signature
const { createWalletClient, http } = await import('viem');
const { polygon } = await import('viem/chains');

const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
});

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
    account,
    domain,
    types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(ts),
        nonce: BigInt(nonce),
        message: 'This message attests that I control the given wallet',
    },
});

const l1Headers = {
    'POLY_ADDRESS': account.address,
    'POLY_SIGNATURE': l1Sig,
    'POLY_TIMESTAMP': String(ts),
    'POLY_NONCE': String(nonce),
};

// GET /auth/api-keys - list all API keys for this wallet
try {
    const res = await fetch(`${HOST}/auth/api-keys`, { method: 'GET', headers: l1Headers });
    const text = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${text}`);
    // Parse and check addresses
    try {
        const keys = JSON.parse(text);
        if (Array.isArray(keys)) {
            console.log(`  Number of API keys: ${keys.length}`);
            keys.forEach((k, i) => {
                console.log(`  Key ${i}:`, JSON.stringify(k, null, 4));
            });
        }
    } catch(e) { /* not JSON */ }
} catch (e) {
    console.log('  Error:', e.message);
}

// Check 4: Derive key (which tells us what the server thinks our key is)
console.log('\nCHECK 4: Derive API key (GET /auth/derive-api-key)');
const ts2 = Math.floor(Date.now() / 1000);
const l1Sig2 = await walletClient.signTypedData({
    account,
    domain,
    types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(ts2),
        nonce: BigInt(nonce),
        message: 'This message attests that I control the given wallet',
    },
});

try {
    const res = await fetch(`${HOST}/auth/derive-api-key`, {
        method: 'GET',
        headers: {
            'POLY_ADDRESS': account.address,
            'POLY_SIGNATURE': l1Sig2,
            'POLY_TIMESTAMP': String(ts2),
            'POLY_NONCE': String(nonce),
        },
    });
    const text = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${text}`);
    try {
        const creds = JSON.parse(text);
        console.log('  Derived API key matches .env key:', creds.apiKey === API_KEY);
        console.log('  Derived secret matches .env secret:', creds.secret === API_SECRET);
        console.log('  Derived passphrase matches .env passphrase:', creds.passphrase === API_PASSPHRASE);
    } catch(e) { /* not JSON */ }
} catch (e) {
    console.log('  Error:', e.message);
}

// Check 5: Try DELETE existing key then CREATE new one
console.log('\nCHECK 5: Delete existing API key, then create fresh one');
const ts3 = Math.floor(Date.now() / 1000);
const l1Sig3 = await walletClient.signTypedData({
    account,
    domain,
    types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(ts3),
        nonce: BigInt(nonce),
        message: 'This message attests that I control the given wallet',
    },
});

// First DELETE existing key
try {
    console.log('  Deleting existing API key...');
    const delRes = await fetch(`${HOST}/auth/api-key`, {
        method: 'DELETE',
        headers: {
            'POLY_ADDRESS': account.address,
            'POLY_SIGNATURE': l1Sig3,
            'POLY_TIMESTAMP': String(ts3),
            'POLY_NONCE': String(nonce),
        },
    });
    const delText = await delRes.text();
    console.log(`  DELETE Status: ${delRes.status}`);
    console.log(`  DELETE Response: ${delText}`);
} catch (e) {
    console.log('  DELETE Error:', e.message);
}

// Wait 3 seconds
console.log('  Waiting 3 seconds...');
await new Promise(r => setTimeout(r, 3000));

// Then CREATE new key
const ts4 = Math.floor(Date.now() / 1000);
const l1Sig4 = await walletClient.signTypedData({
    account,
    domain,
    types,
    primaryType: 'ClobAuth',
    message: {
        address: account.address,
        timestamp: String(ts4),
        nonce: BigInt(nonce),
        message: 'This message attests that I control the given wallet',
    },
});

let newCreds;
try {
    console.log('  Creating new API key...');
    const createRes = await fetch(`${HOST}/auth/api-key`, {
        method: 'POST',
        headers: {
            'POLY_ADDRESS': account.address,
            'POLY_SIGNATURE': l1Sig4,
            'POLY_TIMESTAMP': String(ts4),
            'POLY_NONCE': String(nonce),
        },
    });
    const createText = await createRes.text();
    console.log(`  CREATE Status: ${createRes.status}`);
    console.log(`  CREATE Response: ${createText}`);
    if (createRes.status === 200) {
        newCreds = JSON.parse(createText);
        console.log('\n  === NEW CREDENTIALS ===');
        console.log(`  POLYMARKET_CLOB_API_KEY=${newCreds.apiKey}`);
        console.log(`  POLYMARKET_CLOB_API_SECRET=${newCreds.secret}`);
        console.log(`  POLYMARKET_CLOB_API_PASSPHRASE=${newCreds.passphrase}`);
    }
} catch (e) {
    console.log('  CREATE Error:', e.message);
}

// Check 6: If we got new creds, wait 2 min then test L2 auth
if (newCreds) {
    console.log('\n  Waiting 5 seconds before testing new credentials...');
    await new Promise(r => setTimeout(r, 5000));

    console.log('\nCHECK 6: Test NEW credentials with L2 auth');
    function buildL2(method, path, body, creds) {
        const ts = Math.floor(Date.now() / 1000);
        let msg = `${ts}${method}${path}`;
        if (body) msg += body;
        const sig = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64'))
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

    // Test GET /trades with new creds
    let headers = buildL2('GET', '/trades', undefined, newCreds);
    let res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`  GET /trades: ${res.status} ${await res.text()}`);

    // Test DELETE /cancel-all with new creds
    headers = buildL2('DELETE', '/cancel-all', undefined, newCreds);
    res = await fetch(`${HOST}/cancel-all`, { method: 'DELETE', headers });
    console.log(`  DELETE /cancel-all: ${res.status} ${await res.text()}`);

    // Test GET /balance-allowance with new creds
    headers = buildL2('GET', '/balance-allowance?asset_type=COLLATERAL', undefined, newCreds);
    res = await fetch(`${HOST}/balance-allowance?asset_type=COLLATERAL`, { method: 'GET', headers });
    console.log(`  GET /balance-allowance: ${res.status} ${await res.text()}`);
} else {
    console.log('\nCHECK 6: SKIPPED (no new credentials created)');

    // Still test with existing creds but WITHOUT Content-Type header
    console.log('\nCHECK 6b: Test existing creds WITHOUT Content-Type header');
    function buildL2(method, path, body) {
        const ts = Math.floor(Date.now() / 1000);
        let msg = `${ts}${method}${path}`;
        if (body) msg += body;
        const sig = crypto.createHmac('sha256', Buffer.from(API_SECRET, 'base64'))
            .update(msg).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_');
        return {
            'POLY_ADDRESS': account.address,
            'POLY_API_KEY': API_KEY,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': String(ts),
            'POLY_PASSPHRASE': API_PASSPHRASE,
        };
    }

    // Test WITHOUT Content-Type
    let headers = buildL2('GET', '/trades', undefined);
    let res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`  GET /trades (no Content-Type): ${res.status} ${await res.text()}`);

    // Test with lowercase address
    headers = { ...buildL2('GET', '/trades', undefined), 'POLY_ADDRESS': account.address.toLowerCase() };
    res = await fetch(`${HOST}/trades`, { method: 'GET', headers });
    console.log(`  GET /trades (lowercase addr): ${res.status} ${await res.text()}`);
}

console.log('\n=== DIAGNOSIS COMPLETE ===');
console.log('If ALL L2 auth fails but L1 auth (derive) works:');
console.log('  1. Try deleting + recreating API key (Check 5 above)');
console.log('  2. Wait 2+ minutes after creating new key before using it');
console.log('  3. Check geoblock status');
console.log('  4. Ensure account has traded at least once via Polymarket UI');
