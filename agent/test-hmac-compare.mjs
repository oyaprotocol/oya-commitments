import crypto from 'node:crypto';

const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const timestamp = 1775248829;  // from our debug log
const method = 'POST';
const path = '/order';
const testBody = '{"test":"hello"}';

// === METHOD 1: Node.js crypto (what we use) ===
function hmacNodeCrypto(secret, message) {
    const secretBytes = Buffer.from(secret, 'base64');
    const sig = crypto.createHmac('sha256', secretBytes).update(message).digest('base64');
    return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

// === METHOD 2: Web Crypto API (what official TS client uses) ===
async function hmacWebCrypto(secret, message) {
    // Decode base64 secret (same as official client's base64ToArrayBuffer)
    const sanitized = secret.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(sanitized);
    const keyData = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        keyData[i] = binaryStr.charCodeAt(i);
    }

    const cryptoKey = await globalThis.crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );

    const messageBuffer = new TextEncoder().encode(message);
    const signatureBuffer = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);

    // arrayBufferToBase64 (same as official client)
    const bytes = new Uint8Array(signatureBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const sig = btoa(binary);
    return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

// Test with no body (like GET or DELETE)
const msgNoBody = `${timestamp}DELETE/cancel-all`;
const nodeNoBody = hmacNodeCrypto(API_SECRET, msgNoBody);
const webNoBody = await hmacWebCrypto(API_SECRET, msgNoBody);
console.log('=== DELETE /cancel-all (no body) ===');
console.log('Input:', msgNoBody);
console.log('Node crypto:', nodeNoBody);
console.log('Web crypto: ', webNoBody);
console.log('Match:', nodeNoBody === webNoBody);

// Test with body (like POST /order)
const msgWithBody = `${timestamp}${method}${path}${testBody}`;
const nodeWithBody = hmacNodeCrypto(API_SECRET, msgWithBody);
const webWithBody = await hmacWebCrypto(API_SECRET, msgWithBody);
console.log('\n=== POST /order (with body) ===');
console.log('Input:', msgWithBody);
console.log('Node crypto:', nodeWithBody);
console.log('Web crypto: ', webWithBody);
console.log('Match:', nodeWithBody === webWithBody);

// Now test: what does the CLOB actually expect?
// Let's try calling DELETE /cancel-all with Web Crypto HMAC
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';
const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';

async function testAuthRequest(method, path, body) {
    const ts = Math.floor(Date.now() / 1000);
    let message = `${ts}${method}${path}`;
    if (body !== undefined) {
        message += body;
    }
    const sig = await hmacWebCrypto(API_SECRET, message);

    const headers = {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': ADDRESS,
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': String(ts),
        'POLY_PASSPHRASE': API_PASSPHRASE,
    };

    console.log(`\n=== LIVE: ${method} ${path} (Web Crypto HMAC) ===`);
    console.log('HMAC input:', `${ts}${method}${path}${body ? body.substring(0, 50) + '...' : ''}`);
    console.log('Signature:', sig);

    try {
        const res = await fetch(`https://clob.polymarket.com${path}`, {
            method,
            headers,
            body: body,
        });
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Body: ${text}`);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

// Test authenticated DELETE (no body)
await testAuthRequest('DELETE', '/cancel-all', undefined);

// Test authenticated GET (should work)
await testAuthRequest('GET', '/open-orders', undefined);
