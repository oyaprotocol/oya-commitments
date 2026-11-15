import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { validateHealth } from '../src/health.mjs';
import { healthUrl } from './operator-profile.mjs';

const messages = Object.freeze({
    ready: 'Direct node is ready.', busy: 'Direct node is busy.',
    idle: 'Worker is polling and idle.', processing: 'Worker is processing.',
    starting: 'Node is starting. Check again shortly.', retrying: 'Worker is retrying. Inspect local worker logs.',
    inbox_unavailable: 'Worker cannot reach or authenticate to its inbox. Inspect local worker logs.',
    shutting_down: 'Node is shutting down.', stopped: 'Endpoint reports a stopped worker or node.',
    transaction_outcome_unknown: 'Reconcile the prior transaction before restarting or retrying.',
    batch_blocked: 'Batch logging is blocked. Inspect and reconcile durable batch state.',
    legacy_unverified: 'Reachable but unverified. Upgrade the worker image to a release with public health identity.',
    identity_mismatch: 'Health identity does not match the selected profile. Check the local port and public configuration.',
    stale: 'Worker polling is stale. Inspect local worker logs.', future: 'Worker timestamp is ahead. Check host and worker clocks.',
    malformed: 'Health response is malformed or inconsistent.',
    unreachable: 'Health endpoint is unreachable. This does not prove the process is stopped.',
    timeout: 'Health request or body exceeded five seconds. Process state is unknown.',
    oversized: 'Health response exceeds 64 KiB.', redirect: 'Health redirect refused. Select the local health endpoint.',
    http_error: 'Health endpoint returned an unexpected HTTP status.',
    invalid_response: 'Could not read a valid health response.',
    arguments: 'Usage: operator-node.mjs status --profile FILE [--json] (or set OYA_OPERATOR_PROFILE).',
    configuration: 'Invalid profile or public configuration. Check version, fields, identity, loopback URL and owned private profile permissions.',
});

export function result(code, expected = {}, { reachable = false, verified = false, healthy = false } = {}) {
    return {
        version: 1, role: expected.role ?? null, mode: expected.mode ?? null, target: expected.target ?? null,
        chainId: expected.chainId ?? null, ledgerContract: expected.ledgerContract?.toLowerCase() ?? null,
        nodeAddress: expected.nodeAddress ?? null, reachable, verified, healthy, status: code, message: messages[code],
    };
}

// One deadline includes connection, headers and body. No redirects or retry.
async function readHealth(endpoint) {
    return new Promise(resolve => {
        let request, response, settled = false, reachable = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            response?.destroy();
            request?.destroy();
            resolve({ reachable, ...value });
        };
        const timer = setTimeout(() => finish({ code: 'timeout' }), 5000);
        try {
            const url = new URL(healthUrl(endpoint));
            request = (url.protocol === 'http:' ? httpGet : httpsGet)(url,
                { agent: false, maxHeaderSize: 16384, headers: { accept: 'application/json', connection: 'close' } }, incoming => {
                    response = incoming;
                    reachable = true;
                    const httpStatus = response.statusCode;
                    if (httpStatus >= 300 && httpStatus < 400) return finish({ code: 'redirect' });
                    if (![200, 503].includes(httpStatus)) return finish({ code: 'http_error' });
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                        return finish({ code: 'invalid_response' });
                    }
                    if (Number(response.headers['content-length']) > 65536) return finish({ code: 'oversized' });
                    let size = 0;
                    const chunks = [];
                    response.on('data', chunk => {
                        size += chunk.length;
                        if (size > 65536) return finish({ code: 'oversized' });
                        chunks.push(chunk);
                    });
                    response.on('error', () => finish({ code: 'invalid_response' }));
                    response.on('aborted', () => finish({ code: 'invalid_response' }));
                    response.on('end', () => {
                        try {
                            const health = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
                            finish({ health, httpStatus });
                        } catch { finish({ code: 'invalid_response' }); }
                    });
                });
            request.on('error', () => finish({ code: reachable ? 'invalid_response' : 'unreachable' }));
        } catch { finish({ code: 'unreachable' }); }
    });
}

export async function operatorStatus(expected) {
    const response = await readHealth(expected.healthUrl);
    const observation = response.code ? { code: response.code } : validateHealth(response.health, response.httpStatus, expected);
    return result(observation.code, expected, { reachable: response.reachable, ...observation });
}

export function formatStatus(value) {
    const identity = value.role ? `${value.role} ${value.mode}${value.target ? ` target ${value.target}` : ''}` : 'operator';
    const ledger = value.nodeAddress ? `; node ${value.nodeAddress}; chain ${value.chainId}; Ledger ${value.ledgerContract}` : '';
    return `${value.healthy ? 'OK' : 'FAIL'} ${identity}: ${value.status}${ledger}\n${value.message}`;
}
