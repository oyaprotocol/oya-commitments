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

// EIP-712 domain and types for ClobAuth (from official Polymarket SDK)
const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CHAIN_ID,
};

const types = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
    ],
};

const MSG_TO_SIGN = 'This message attests that I control the given wallet';

async function signClobAuth(nonce = 0) {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = {
        address: account.address,
        timestamp: String(timestamp),
        nonce: BigInt(nonce),
        message: MSG_TO_SIGN,
    };

    const signature = await walletClient.signTypedData({
        account,
        domain,
        types,
        primaryType: 'ClobAuth',
        message,
    });

    return { signature, timestamp, nonce };
}

// Step 1: Try to derive existing API key
async function deriveApiKey(nonce = 0) {
    const { signature, timestamp } = await signClobAuth(nonce);
    const headers = {
        'POLY_ADDRESS': account.address,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': String(timestamp),
        'POLY_NONCE': String(nonce),
    };

    console.log('\n=== Trying DERIVE API key (GET /auth/derive-api-key) ===');
    const res = await fetch(`${HOST}/auth/derive-api-key`, {
        method: 'GET',
        headers,
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text}`);
    return { status: res.status, text };
}

// Step 2: Create new API key if derive fails
async function createApiKey(nonce = 0) {
    const { signature, timestamp } = await signClobAuth(nonce);
    const headers = {
        'POLY_ADDRESS': account.address,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': String(timestamp),
        'POLY_NONCE': String(nonce),
    };

    console.log('\n=== Trying CREATE API key (POST /auth/api-key) ===');
    const res = await fetch(`${HOST}/auth/api-key`, {
        method: 'POST',
        headers,
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text}`);
    return { status: res.status, text };
}

// Run both approaches
try {
    // Try derive first (retrieves existing key)
    const deriveResult = await deriveApiKey(0);

    if (deriveResult.status !== 200) {
        console.log('\nDerive failed, trying create...');
        const createResult = await createApiKey(0);

        if (createResult.status !== 200) {
            console.log('\nBoth failed. Trying with nonce=1...');
            await deriveApiKey(1);
            await createApiKey(1);
        }
    }
} catch (e) {
    console.error('Error:', e.message);
}

console.log('\n=== IMPORTANT ===');
console.log('If you get new credentials, update agent/.env with:');
console.log('  POLYMARKET_CLOB_API_KEY=<apiKey>');
console.log('  POLYMARKET_CLOB_API_SECRET=<secret>');
console.log('  POLYMARKET_CLOB_API_PASSPHRASE=<passphrase>');
