import { createServer } from 'node:http';
import { loadProfile } from './operator-profile.mjs';
import { operatorStatus } from './operator-status.mjs';

const refreshSeconds = 5;
const labels = { role: 'Node role', mode: 'Mode', target: 'Inbox queue (target)', nodeAddress: 'Selected node',
    chainId: 'Chain', ledgerContract: 'Ledger', status: 'Status', reachable: 'Reachable', verified: 'Identity matches', healthy: 'Healthy' };

function text(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function observe(profile) {
    const status = await operatorStatus(profile);
    const rows = Object.entries(labels).filter(([key]) => status[key] !== null).map(([key, label]) =>
        `<tr><th scope="row">${label}</th><td>${typeof status[key] === 'boolean'
            ? (status[key] ? '<span aria-hidden="true">✅</span> Yes' : 'No') : text(status[key])}</td></tr>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local node health</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${refreshSeconds}"></head>
<body><main><h1>Local node health</h1><p>${text(status.message)}</p><table><tbody>${rows}</tbody></table>
<p>Checked at ${new Date().toISOString()}. Refreshes every ${refreshSeconds} seconds.</p></main></body></html>`;
}

function serve(profile) {
    let page, expires = 0;
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers['sec-fetch-site'] === 'cross-site') {
            return res.writeHead(403).end();
        }
        if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
        if (req.url !== '/') return res.writeHead(404).end();
        try {
            if (!page || performance.now() >= expires) {
                expires = Infinity; // Share one bounded health read across simultaneous requests.
                page = observe(profile).finally(() => { expires = performance.now() + refreshSeconds * 1000; });
            }
            const html = await page;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        } catch { res.writeHead(503).end('Health view unavailable. Reload to retry.'); }
    });
    server.on('error', () => { console.error('Cannot start local health view.'); process.exitCode = 1; });
    server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--profile' || !args[1]) {
    console.error('Usage: operator-view.mjs --profile FILE');
    process.exitCode = 2;
} else {
    try { serve(await loadProfile(args[1], 'status')); }
    catch { console.error('Invalid operator profile or public configuration.'); process.exitCode = 2; }
}
