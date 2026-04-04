import crypto from 'node:crypto';

const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const HOST = 'https://clob.polymarket.com';

function buildL2Headers(method, path, body) {
    const ts = Math.floor(Date.now() / 1000);
    let message = `${ts}${method}${path}`;
    if (body !== undefined && body !== '') message += body;
    const secretBytes = Buffer.from(API_SECRET, 'base64');
    const sig = crypto.createHmac('sha256', secretBytes).update(message).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_');
    return {
        'POLY_ADDRESS': ADDRESS,
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_PASSPHRASE': API_PASSPHRASE,
    };
}

async function testEndpoint(method, path, body, label) {
    const headers = { 'Content-Type': 'application/json', ...buildL2Headers(method, path, body) };
    console.log(`\n=== ${label}: ${method} ${path} ===`);
    try {
        const res = await fetch(`${HOST}${path}`, { method, headers, body });
        const text = await res.text();
        console.log(`Status: ${res.status}`);
        console.log(`Body: ${text.substring(0, 300)}`);
    } catch (e) {
        console.log('Error:', e.message);
    }
}

// Test various endpoints to determine what works with L2 auth

// Public endpoints (should work without auth)
await testEndpoint('GET', '/midpoint?token_id=77893140510362582253172593084218413010407941075415081594586195705930819989216', undefined, 'PUBLIC: midpoint');

// Authenticated GET endpoints
await testEndpoint('GET', '/api-keys', undefined, 'AUTH GET: api-keys');
await testEndpoint('GET', '/orders', undefined, 'AUTH GET: orders');
await testEndpoint('GET', '/trades', undefined, 'AUTH GET: trades');
await testEndpoint('GET', '/balance-allowance?asset_type=COLLATERAL', undefined, 'AUTH GET: balance-allowance');

// Authenticated DELETE
await testEndpoint('DELETE', '/cancel-all', undefined, 'AUTH DELETE: cancel-all');

// Simple POST
await testEndpoint('POST', '/cancel-all', undefined, 'AUTH POST: cancel-all via POST');
