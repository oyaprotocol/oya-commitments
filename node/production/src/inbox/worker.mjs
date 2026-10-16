import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '../config.mjs';
import { loadSecrets } from '../secrets.mjs';
import { createLocalSigner } from '../signer.mjs';
import { readJson, inboxUrl, positive, token } from './config.mjs';
import { targetName, executionIdentity, validId } from './protocol.mjs';
import { createInboxClient, json } from './http.mjs';
import { processWork } from './processor.mjs';

export async function runOne({ api, config, target, allowedSigners, signer, fetch, signal, log = () => {}, state = {} }) {
    const claimed = await api('/v1/worker/claim', { target, execution: executionIdentity(config, signer?.address) }, signal);
    state.lastPollAt = new Date().toISOString();
    const work = claimed.work;
    if (!work) { state.status = 'idle'; return false; }
    if (!validId(work.requestId) || work.requestId !== work.job?.requestId || !validId(work.lease) ||
        !Number.isSafeInteger(claimed.leaseMs) || claimed.leaseMs < 3000 || claimed.leaseMs > 300000) throw new Error('Invalid claim.');
    const operation = new AbortController();
    const operationSignal = AbortSignal.any([operation.signal, AbortSignal.timeout(config.operationTimeoutMs), ...(signal ? [signal] : [])]);
    const lease = { requestId: work.requestId, lease: work.lease };
    let renewal;
    let renewing = false;
    const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        renewal = api('/v1/worker/renew', lease, operationSignal).catch(() => operation.abort())
            .finally(() => { renewing = false; });
    }, Math.floor(claimed.leaseMs / 3));
    state.status = 'processing';
    state.requestId = work.requestId;
    log({ event: 'job_claimed', requestId: work.requestId, attempt: work.attempts });
    try {
        const result = await processWork({ work, config, target, allowedSigners, signer, fetch, signal: operationSignal, log,
            save: checkpoint => api('/v1/worker/checkpoint', { ...lease, checkpoint }, operationSignal) });
        clearInterval(timer);
        await renewal;
        operationSignal.throwIfAborted();
        await api('/v1/worker/complete', { ...lease, result }, operationSignal);
        state.completed = (state.completed ?? 0) + 1;
        state.lastResult = result;
        state.status = 'idle';
        log({ event: 'job_result', requestId: work.requestId, ...result });
    } catch {
        clearInterval(timer);
        await renewal;
        state.status = 'retrying';
        // The database may already contain a checkpoint whose HTTP acknowledgement was lost.
        // Always let it decide whether this job can fail or must await transaction reconciliation.
        let result;
        try { result = await api('/v1/worker/retry', lease); } catch {}
        log({ event: 'job_retry', requestId: work.requestId, error: result?.error ?? 'lease_or_connection_lost' });
    } finally {
        clearInterval(timer);
        operation.abort();
        await renewal;
        delete state.requestId;
    }
    return true;
}

export async function runWorker(options) {
    const { signal, state = {}, log = () => {}, pollIntervalMs = 5000 } = options;
    let lastIdleLog = 0;
    log({ event: 'worker_started', target: options.target, mode: options.config.mode });
    while (!signal?.aborted) {
        try {
            const didWork = await runOne({ ...options, state, log });
            if (didWork) continue;
            if (Date.now() - lastIdleLog >= 60000) {
                log({ event: 'worker_idle', target: options.target, completed: state.completed ?? 0 });
                lastIdleLog = Date.now();
            }
        } catch {
            state.status = 'inbox_unavailable';
            log({ event: 'inbox_unavailable', message: 'Retrying inbox connection; check service, token and execution identity.' });
        }
        try { await delay(pollIntervalMs, undefined, { signal }); } catch {}
    }
    state.status = 'stopped';
    log({ event: 'worker_stopped' });
}

async function main() {
    const [nodeFile, nodeSecretsFile, workerFile, workerSecretsFile, ...extra] = process.argv.slice(2);
    if (!workerSecretsFile || extra.length) throw new Error('Usage: worker NODE_JSON NODE_SECRETS WORKER_JSON WORKER_SECRETS_JSON');
    const secrets = await loadSecrets(nodeSecretsFile);
    const input = await readJson(nodeFile);
    const config = parseConfig(input, { env: secrets });
    const { allowedSigners } = input;
    const worker = await readJson(workerFile);
    if (Object.keys(worker).some(key => !['url', 'target', 'pollIntervalMs'].includes(key))) throw new Error('Unknown worker field.');
    const target = targetName(worker.target);
    const api = createInboxClient(inboxUrl(worker.url), token((await readJson(workerSecretsFile)).workerToken));
    const pollIntervalMs = positive(worker.pollIntervalMs, 5000, 60000);
    if (pollIntervalMs < 1000) throw new Error('Polling interval must be at least one second.');
    const signer = config.mode === 'ledger' ? createLocalSigner(secrets.OYA_NODE_PRIVATE_KEY) : undefined;
    const controller = new AbortController();
    const state = { status: 'starting', target, mode: config.mode, completed: 0 };
    const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/healthz') { json(response, 404, { error: 'not_found' }); return; }
        const healthy = ['idle', 'processing'].includes(state.status) && Date.now() - Date.parse(state.lastPollAt) < config.operationTimeoutMs + 60000;
        json(response, healthy ? 200 : 503, { role: 'worker', ...state });
    });
    await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolveListening); });
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try { await runWorker({ api, config, target, allowedSigners, signer, signal: controller.signal,
        pollIntervalMs, state, log: record => { try { console.log(JSON.stringify(record)); } catch {} } }); }
    finally {
        await new Promise(resolveClosed => server.close(resolveClosed));
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => { console.error('Worker startup failed. Check node and inbox configuration and secrets.'); process.exitCode = 1; });
}
