import { ethers } from 'ethers';

let ClobClient;
try {
    const mod = await import('@polymarket/clob-client');
    ClobClient = mod.ClobClient;
} catch (e) {
    console.error('Failed to import:', e.message);
    process.exit(1);
}

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const PRIVATE_KEY = '0x675714560e0dbb61bf4d6b2fe8d33c0e49fbbbf10725bd2714021d2b449a787d';
const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';

const wallet = new ethers.Wallet(PRIVATE_KEY);
console.log('Wallet address:', wallet.address);

const client = new ClobClient(
    HOST,
    CHAIN_ID,
    wallet,              // signer
    {                    // creds
        key: API_KEY,
        secret: API_SECRET,
        passphrase: API_PASSPHRASE,
    },
);

// Test 1: cancel-all (DELETE with L2 auth)
console.log('\n=== TEST: Cancel all orders ===');
try {
    const result = await client.cancelAll();
    console.log('Result:', JSON.stringify(result));
} catch (e) {
    console.log('Error:', e.message?.substring(0, 500));
}

// Test 2: Get open orders
console.log('\n=== TEST: Get open orders ===');
try {
    const result = await client.getOpenOrders();
    console.log('Result:', JSON.stringify(result)?.substring(0, 500));
} catch (e) {
    console.log('Error:', e.message?.substring(0, 500));
}
