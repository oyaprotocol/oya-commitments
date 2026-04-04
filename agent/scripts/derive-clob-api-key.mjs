/**
 * Derive Polymarket CLOB API credentials for the agent wallet.
 *
 * Usage:
 *   ENV_FILE=agent/.env.multi node agent/scripts/derive-clob-api-key.mjs
 *
 * The script signs a registration request with the wallet's private key,
 * sends it to the CLOB API, and prints the resulting API key, secret, and passphrase.
 */

import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Load env
import { loadScriptEnv } from './lib/cli-runtime.mjs';
loadScriptEnv();

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error('PRIVATE_KEY is required. Set it in your .env file.');
    process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Wallet address: ${account.address}`);

async function deriveApiKey() {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 0;

    // The CLOB API expects an EIP-712 typed signature for API key derivation
    const domain = {
        name: 'ClobAuthDomain',
        version: '1',
        chainId: 137,
    };

    const types = {
        ClobAuth: [
            { name: 'address', type: 'address' },
            { name: 'timestamp', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'message', type: 'string' },
        ],
    };

    const message = {
        address: account.address,
        timestamp: String(timestamp),
        nonce: nonce,
        message: 'This message attests that I control the given wallet',
    };

    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(),
    });

    const signature = await walletClient.signTypedData({
        domain,
        types,
        primaryType: 'ClobAuth',
        message,
    });

    // Derive API key via GET with auth headers (Polymarket CLOB convention)
    const response = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
        method: 'GET',
        headers: {
            'POLY_ADDRESS': account.address,
            'POLY_SIGNATURE': signature,
            'POLY_TIMESTAMP': String(timestamp),
            'POLY_NONCE': String(nonce),
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const text = await response.text();
        console.error(`CLOB API error (${response.status}): ${text}`);
        process.exit(1);
    }

    const data = await response.json();
    console.log('\n=== CLOB API Credentials ===');
    console.log(`POLYMARKET_CLOB_API_KEY=${data.apiKey}`);
    console.log(`POLYMARKET_CLOB_API_SECRET=${data.secret}`);
    console.log(`POLYMARKET_CLOB_API_PASSPHRASE=${data.passphrase}`);
    console.log('\nAdd these to your .env.multi file.');
}

deriveApiKey().catch((err) => {
    console.error('Failed to derive API key:', err?.message ?? err);
    process.exit(1);
});
