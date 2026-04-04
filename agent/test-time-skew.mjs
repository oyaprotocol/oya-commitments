import crypto from 'node:crypto';

const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const HOST = 'https://clob.polymarket.com';

// Step 1: Get server time
console.log('=== Checking server time ===');
const res = await fetch(`${HOST}/time`);
const serverData = await res.json();
console.log('Server time response:', serverData);
const serverTime = Math.floor(Number(serverData) || Date.now() / 1000);
const localTime = Math.floor(Date.now() / 1000);
console.log('Server time:', serverTime);
console.log('Local time:', localTime);
console.log('Skew (seconds):', localTime - serverTime);

// Step 2: Try using SERVER time instead of local time for HMAC
function buildL2WithTime(method, path, body, ts) {
    let msg = `${ts}${method}${path}`;
    if (body) msg += body;
    const secretBytes = Buffer.from(API_SECRET, 'base64');
    const sig = crypto.createHmac('sha256', secretBytes).update(msg).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_');
    return {
        'POLY_ADDRESS': ADDRESS,
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_PASSPHRASE': API_PASSPHRASE,
    };
}

// Test with local time
console.log('\n=== Test with LOCAL time ===');
let headers = { 'Content-Type': 'application/json', ...buildL2WithTime('DELETE', '/cancel-all', undefined, localTime) };
let r = await fetch(`${HOST}/cancel-all`, { method: 'DELETE', headers });
console.log(`DELETE /cancel-all: ${r.status} ${await r.text()}`);

// Test with server time
const freshServerRes = await fetch(`${HOST}/time`);
const freshServerTime = Math.floor(Number(await freshServerRes.json()));
console.log('\n=== Test with SERVER time ===');
headers = { 'Content-Type': 'application/json', ...buildL2WithTime('DELETE', '/cancel-all', undefined, freshServerTime) };
r = await fetch(`${HOST}/cancel-all`, { method: 'DELETE', headers });
console.log(`DELETE /cancel-all: ${r.status} ${await r.text()}`);

// Also test GET /trades with server time
const freshServerRes2 = await fetch(`${HOST}/time`);
const freshServerTime2 = Math.floor(Number(await freshServerRes2.json()));
console.log('\n=== Test GET /trades with SERVER time ===');
headers = { 'Content-Type': 'application/json', ...buildL2WithTime('GET', '/trades', undefined, freshServerTime2) };
r = await fetch(`${HOST}/trades`, { method: 'GET', headers });
console.log(`GET /trades: ${r.status} ${await r.text()}`);
