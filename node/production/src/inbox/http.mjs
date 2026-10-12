import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { InboxError, reject, validateJob } from './protocol.mjs';

export function json(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
}
export async function readBody(request, limit = 65536) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) reject(415, 'json_required');
    if (Number(request.headers['content-length']) > limit) reject(413, 'body_too_large');
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => request.destroy(), 10000);
    try {
        for await (const chunk of request) {
            size += chunk.length;
            if (size > limit) reject(413, 'body_too_large');
            chunks.push(chunk);
        }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(400, 'invalid_json'); }
    } finally { clearTimeout(timeout); }
}
export function createInboxServer({ config, workerToken, store, log = () => {} }) {
    const credential = Buffer.from(`Bearer ${workerToken}`);
    let active = 0;
    // Bound even rejected signature checks without storing attacker-controlled map keys.
    let windowStart = 0;
    let requests = 0;
    const server = createServer(async (request, response) => {
        if (active >= 32) { json(response, 503, { error: 'inbox_busy' }); request.resume(); return; }
        active++;
        try {
            if (request.method === 'GET' && request.url === '/healthz') {
                await store.pool.query('SELECT 1');
                json(response, 200, { status: 'ready', role: 'inbox', target: config.target });
                return;
            }
            if (request.method !== 'POST') reject(405, 'post_required');
            const worker = request.url.startsWith('/v1/worker/');
            if (worker) {
                const supplied = Buffer.from(request.headers.authorization ?? '');
                if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) reject(401, 'worker_auth_required');
            } else {
                if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
                if (++requests > 240) reject(429, 'request_limit');
            }
            const body = await readBody(request);
            let result;
            switch (request.url) {
                case '/v1/jobs':
                    await validateJob(body, config);
                    result = await store.enqueue(body);
                    json(response, 202, result);
                    try { log({ event: 'job_accepted', requestId: result.requestId, status: result.status }); } catch {}
                    return;
                case '/v1/status':
                    await validateJob(body, { ...config, checkExpiry: false });
                    result = await store.status(body); break;
                case '/v1/worker/claim':
                    if (body.target !== config.target) reject(409, 'target_mismatch');
                    result = { work: await store.claim(body.execution), leaseMs: config.leaseMs }; break;
                case '/v1/worker/renew': result = await store.renew(body.requestId, body.lease); break;
                case '/v1/worker/checkpoint': result = await store.checkpoint(body.requestId, body.lease, body.checkpoint); break;
                case '/v1/worker/complete': result = await store.complete(body.requestId, body.lease, body.result); break;
                case '/v1/worker/retry': result = await store.retry(body.requestId, body.lease); break;
                default: reject(404, 'not_found');
            }
            json(response, 200, result);
        } catch (error) {
            const known = error instanceof InboxError;
            if (!response.headersSent) json(response, known ? error.status : 503, { error: known ? error.code : 'inbox_unavailable' });
        } finally { active--; request.resume(); }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxConnections = 128;
    return server;
}

export function createInboxClient(url, workerToken, transport = globalThis.fetch) {
    return async (path, body, signal) => {
        const response = await transport(`${url}${path}`, { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json', ...(workerToken ? { authorization: `Bearer ${workerToken}` } : {}) },
            body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 131072) throw new Error('Inbox response exceeds limit.');
            chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok) throw new InboxError(response.status, 'inbox_request_failed');
        return result;
    };
}
