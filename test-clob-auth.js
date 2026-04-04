import crypto from 'node:crypto';

// Credentials from .env
const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const HOST = 'https://clob.polymarket.com';

function buildHmacSignature(secret, timestamp, method, requestPath, body) {
    let message = `${timestamp}${method}${requestPath}`;
    if (body !== undefined && body !== '') {
        message += body;
    }
    const secretBytes = Buffer.from(secret, 'base64');
    const sig = crypto.createHmac('sha256', secretBytes).update(message).digest('base64');
    return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

function buildHeaders(method, path, body) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildHmacSignature(API_SECRET, timestamp, method, path, body);
    return {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': ADDRESS,
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': String(timestamp),
        'POLY_PASSPHRASE': API_PASSPHRASE,
    };
}

// Test 1: Authenticated GET (should work - like fee-rate)
async function testGet() {
    const path = '/midpoint?token_id=77893140510362582253172593084218413010407941075415081594586195705930819989216';
    const headers = buildHeaders('GET', path);
    console.log('\n=== TEST 1: Authenticated GET /midpoint ===');
    try {
        const res = await fetch(`${HOST}${path}`, { method: 'GET', headers });
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Body: ${text}`);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

// Test 2: Authenticated POST with EMPTY body to /cancel-all
async function testPostCancelAll() {
    const path = '/cancel-all';
    const body = undefined;
    const headers = buildHeaders('DELETE', path, '');
    console.log('\n=== TEST 2: Authenticated DELETE /cancel-all ===');
    try {
        const res = await fetch(`${HOST}${path}`, { method: 'DELETE', headers });
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Body: ${text}`);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

// Test 3: Authenticated POST with a simple JSON body
async function testPostOrder() {
    const path = '/order';
    // Minimal fake order body - will fail validation but should pass auth
    const bodyObj = {
        deferExec: false,
        order: {
            salt: 1234567890,
            maker: ADDRESS,
            signer: ADDRESS,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: '77893140510362582253172593084218413010407941075415081594586195705930819989216',
            makerAmount: '1000000',
            takerAmount: '10000000',
            side: 'BUY',
            expiration: '0',
            nonce: '0',
            feeRateBps: '0',
            signatureType: 0,
            signature: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        },
        owner: API_KEY,
        orderType: 'FOK',
        postOnly: false,
    };
    const bodyText = JSON.stringify(bodyObj);
    const headers = buildHeaders('POST', path, bodyText);

    console.log('\n=== TEST 3: Authenticated POST /order (fake order) ===');
    console.log('Body length:', bodyText.length);
    console.log('Body first 200:', bodyText.substring(0, 200));

    const ts = headers['POLY_TIMESTAMP'];
    const hmacInput = `${ts}POST/order${bodyText}`;
    console.log('HMAC input first 200:', hmacInput.substring(0, 200));
    console.log('HMAC signature:', headers['POLY_SIGNATURE']);

    try {
        const res = await fetch(`${HOST}${path}`, {
            method: 'POST',
            headers,
            body: bodyText,
        });
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Body: ${text}`);
        if (res.status === 401) {
            console.log('>>> AUTH FAILED - POST auth is broken');
        } else if (res.status === 400) {
            console.log('>>> AUTH PASSED but payload invalid (expected with fake order)');
        } else {
            console.log('>>> Unexpected status');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

// Test 4: Same POST /order but WITHOUT body in HMAC
async function testPostOrderNoBodyHmac() {
    const path = '/order';
    const bodyObj = {
        deferExec: false,
        order: {
            salt: 9876543210,
            maker: ADDRESS,
            signer: ADDRESS,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: '77893140510362582253172593084218413010407941075415081594586195705930819989216',
            makerAmount: '1000000',
            takerAmount: '10000000',
            side: 'BUY',
            expiration: '0',
            nonce: '0',
            feeRateBps: '0',
            signatureType: 0,
            signature: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        },
        owner: API_KEY,
        orderType: 'FOK',
        postOnly: false,
    };
    const bodyText = JSON.stringify(bodyObj);
    // Sign WITHOUT body (like a GET request)
    const headers = buildHeaders('POST', path, '');

    console.log('\n=== TEST 4: POST /order with HMAC signed WITHOUT body ===');
    try {
        const res = await fetch(`${HOST}${path}`, {
            method: 'POST',
            headers,
            body: bodyText,
        });
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Body: ${text}`);
        if (res.status === 401) {
            console.log('>>> AUTH FAILED without body in HMAC too');
        } else if (res.status === 400) {
            console.log('>>> AUTH PASSED when body excluded from HMAC!');
        } else {
            console.log('>>> Unexpected status');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

await testGet();
await testPostCancelAll();
await testPostOrder();
await testPostOrderNoBodyHmac();
