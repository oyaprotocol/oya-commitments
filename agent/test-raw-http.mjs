import crypto from 'node:crypto';
import https from 'node:https';

const API_KEY = '243da202-71e4-9960-69a5-71f54e97ab12';
const API_SECRET = 'bxT2pLXq271NpRKKTV3QJWLSpDEs8PFkTwSbUPoeSX8=';
const API_PASSPHRASE = '577e94665c602fc70979b1903b5eed20a14e36491f2194bff396de082b79a971';
const ADDRESS = '0x2Ee0F0767af62b7D4C5faFcd3879487AfB229659';

function buildSig(method, path, body, ts) {
    let msg = `${ts}${method}${path}`;
    if (body) msg += body;
    return crypto.createHmac('sha256', Buffer.from(API_SECRET, 'base64'))
        .update(msg).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function rawRequest(method, path, body) {
    return new Promise((resolve) => {
        const ts = Math.floor(Date.now() / 1000);
        const sig = buildSig(method, path, body, ts);

        const headers = {
            'POLY_ADDRESS': ADDRESS,
            'POLY_API_KEY': API_KEY,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': String(ts),
            'POLY_PASSPHRASE': API_PASSPHRASE,
        };
        if (body) headers['Content-Type'] = 'application/json';

        const options = {
            hostname: 'clob.polymarket.com',
            path: path,
            method: method,
            headers: headers,
        };

        console.log(`\n=== ${method} ${path} (raw https) ===`);
        console.log('Headers sent:', JSON.stringify(headers, null, 2));

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`Status: ${res.statusCode}`);
                console.log(`Response: ${data.substring(0, 300)}`);
                console.log('Response headers:', JSON.stringify(res.headers, null, 2));
                resolve();
            });
        });

        req.on('error', (e) => {
            console.log('Error:', e.message);
            resolve();
        });

        if (body) req.write(body);
        req.end();
    });
}

// Test 1: DELETE /cancel-all (no body, no Content-Type)
await rawRequest('DELETE', '/cancel-all');

// Test 2: GET /trades (no body, no Content-Type)
await rawRequest('GET', '/trades');

// Test 3: GET /midpoint (public - should work)
await rawRequest('GET', '/midpoint?token_id=77893140510362582253172593084218413010407941075415081594586195705930819989216');
