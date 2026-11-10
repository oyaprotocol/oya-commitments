import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getAddress } from 'ethers';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { decodeLedgerEvent, ethGetTransactionReceipt } from '@oyaprotocol/ethereum';
import { inboxUrl, positive } from './config.mjs';
import { targetName, validateJob } from './protocol.mjs';

const FILE_LIMIT = 65536;
const BODY_LIMIT = 131072;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const quantity = value => {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) throw new Error();
    return BigInt(value);
};
class EvidenceError extends Error {
    constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
const unavailable = reason => { throw new EvidenceError('unavailable', reason); };
const requireMatch = (condition, reason) => { if (!condition) throw new EvidenceError('mismatch', reason); };

export async function readEvidenceJson(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await file.stat()).isFile()) throw new Error();
        const buffer = Buffer.alloc(FILE_LIMIT + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size > FILE_LIMIT) throw new Error();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } finally { await file.close(); }
}

function endpoint(value, authorization, kubo = false) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
        (kubo && url.search) || url.href.length > 4096) throw new Error();
    if (authorization !== undefined && (typeof authorization !== 'string' ||
        !/^[\x20-\x7e]{1,4096}$/.test(authorization))) throw new Error();
    return { url: kubo ? url.href.replace(/\/$/, '') : url.href, authorization };
}
function settings(input) {
    const allowed = ['target', 'inboxUrl', 'chainId', 'ledgerContract', 'nodeAddress', 'rpcUrl', 'ipfsUrl',
        'rpcAuthorization', 'ipfsAuthorization', 'timeoutMs', 'requestTimeoutMs'];
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error();
    const result = { target: targetName(input.target), inbox: { url: inboxUrl(input.inboxUrl) },
        chainId: positive(input.chainId, undefined, Number.MAX_SAFE_INTEGER),
        rpc: endpoint(input.rpcUrl, input.rpcAuthorization), ipfs: endpoint(input.ipfsUrl, input.ipfsAuthorization, true),
        timeoutMs: positive(input.timeoutMs, 30000, 120000), requestTimeoutMs: positive(input.requestTimeoutMs, 10000, 30000) };
    for (const key of ['ledgerContract', 'nodeAddress']) {
        result[key] = getAddress(input[key]).toLowerCase();
        if (/^0x0{40}$/.test(result[key])) throw new Error();
    }
    return result;
}

// One bounded read, including streaming; never follows redirects or retries.
async function readJson(endpoint, suffix, body, signal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response;
    try {
        if (signal.aborted) unavailable('deadline');
        response = await fetch(endpoint.url + suffix, { method: 'POST', redirect: 'error',
            signal: controller.signal, headers: { 'content-type': 'application/json',
                ...(endpoint.authorization === undefined ? {} : { authorization: endpoint.authorization }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) unavailable('http_failure');
        if (Number(response.headers.get('content-length')) > BODY_LIMIT) unavailable('body_limit');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > BODY_LIMIT) unavailable('body_limit');
            chunks.push(chunk);
        }
        let result;
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
        catch { throw new EvidenceError('mismatch', 'malformed_json'); }
        return result;
    } catch (error) {
        if (error instanceof EvidenceError) throw error;
        unavailable(controller.signal.aborted ? 'deadline' : 'transport_failure');
    } finally {
        controller.abort();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
}

export const evidenceExitCode = report => ({ verified: 0, mismatch: 2, unavailable: 3 })[report.status];
export const evidenceInputFailure = () => ({ version: 1, status: 'unavailable', reason: 'input_unreadable',
    stage: 'input', observedAt: new Date().toISOString() });

export async function verifyLedgerEvidence(job, input) {
    const report = { version: 1, status: 'unavailable', reason: 'incomplete', stage: 'input', observedAt: new Date().toISOString() };
    const controller = new AbortController();
    let timer;
    try {
        let config;
        try { config = settings(input); }
        catch { throw new EvidenceError('mismatch', 'invalid_settings'); }
        timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            requireMatch(Buffer.byteLength(JSON.stringify(job)) <= FILE_LIMIT, 'invalid_job');
            await validateJob(job, { target: config.target, allowedSigners: [job?.message?.signer], checkExpiry: false });
        } catch { throw new EvidenceError('mismatch', 'invalid_job'); }
        report.requestId = job.requestId;
        report.target = config.target;
        report.expected = { chainId: config.chainId, ledgerContract: config.ledgerContract, nodeAddress: config.nodeAddress };
        const read = (endpoint, suffix, body) => readJson(endpoint, suffix, body, controller.signal, config.requestTimeoutMs);
        let id = 0;
        const rpc = async (method, params) => {
            const request = { jsonrpc: '2.0', id: ++id, method, params };
            const reply = await read(config.rpc, '', request);
            requireMatch(object(reply) && reply.jsonrpc === '2.0' && reply.id === request.id &&
                (Object.hasOwn(reply, 'result') !== Object.hasOwn(reply, 'error')), 'malformed_rpc');
            if (Object.hasOwn(reply, 'error')) unavailable('rpc_error');
            return reply.result;
        };
        report.stage = 'status';
        const status = await read(config.inbox, '/v1/status', job);
        requireMatch(object(status) && status.requestId === job.requestId &&
            ['queued', 'processing', 'published', 'logged', 'failed', 'expired'].includes(status.status), 'status_identity');
        // v1 status is scoped by the signed target; check an explicit target if a server supplies it.
        requireMatch(status.target === undefined || status.target === job.target, 'status_target');
        requireMatch(status.result === undefined || (object(status.result) && status.result.status === status.status), 'status_result');
        if (status.status !== 'logged') unavailable('not_logged');
        const result = status.result;
        requireMatch(object(result) && result.status === 'logged' && typeof status.cid === 'string' &&
            status.cid === result.cid && hash(status.transactionHash) && same(status.transactionHash, result.transactionHash), 'status_result');
        try { assertCanonicalCid(result.cid); } catch { throw new EvidenceError('mismatch', 'invalid_cid'); }
        report.cid = result.cid;
        report.transactionHash = result.transactionHash.toLowerCase();
        report.stage = 'chain';
        requireMatch(quantity(await rpc('eth_chainId', [])) === BigInt(config.chainId), 'chain_identity');
        report.stage = 'receipt';
        const raw = await rpc('eth_getTransactionReceipt', [report.transactionHash]);
        if (raw === null) unavailable('receipt_missing');
        // Reuse the kernel parser through its read-only public export. This adapter
        // parses the already bounded RPC result and performs no additional I/O.
        quantity(raw?.blockNumber);
        const { receipt } = await ethGetTransactionReceipt({ transactionHash: report.transactionHash,
            signal: controller.signal,
            config: { url: config.rpc.url, maxRetries: 0, retryDelayMs: 0, timeoutMs: config.requestTimeoutMs },
            fetch: async (_url, request) => ({ ok: true, status: 200,
                text: async () => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(request.body).id, result: raw }) }) });
        requireMatch(receipt.status === 'success' && same(receipt.from, config.nodeAddress) &&
            same(receipt.to, config.ledgerContract) && receipt.contractAddress === null, 'receipt_identity');
        report.block = { number: receipt.blockNumber.toString(), hash: receipt.blockHash.toLowerCase() };
        report.stage = 'event';
        const events = receipt.logs.map(log => decodeLedgerEvent(log, config.ledgerContract));
        requireMatch(events.some(event => event && event.removed !== true &&
            same(event.node, config.nodeAddress) && event.cid === report.cid), 'ledger_event');
        report.stage = 'block';
        const block = await rpc('eth_getBlockByNumber', [raw.blockNumber, false]);
        if (block === null) unavailable('block_missing');
        requireMatch(object(block) && same(block.hash, receipt.blockHash) &&
            quantity(block.number) === receipt.blockNumber, 'block_identity');
        report.block.timestamp = quantity(block.timestamp).toString();
        report.stage = 'content';
        const content = await read(config.ipfs, `/api/v0/cat?arg=${encodeURIComponent(report.cid)}`, undefined);
        requireMatch(object(content) && Object.keys(content).sort().join() === 'signature,signer,text' &&
            ['text', 'signer', 'signature'].every(key => content[key] === job.message[key]), 'signed_content');
        // The exact fields already passed both original signature checks.
        if (controller.signal.aborted) unavailable('deadline');
        report.status = 'verified';
        report.reason = 'snapshot_consistent';
        report.stage = 'complete';
    } catch (error) {
        report.status = error instanceof EvidenceError ? error.status : controller.signal.aborted ? 'unavailable' : 'mismatch';
        report.reason = error instanceof EvidenceError ? error.reason : controller.signal.aborted ? 'deadline' : 'malformed_evidence';
    } finally {
        clearTimeout(timer);
        controller.abort();
        report.observedAt = new Date().toISOString();
    }
    return report;
}
