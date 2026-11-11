import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
// Keep ethers until the staged kernel getAddress is published and the pin upgraded.
import { getAddress } from 'ethers';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { decodeLedgerEvent, ethGetTransactionReceipt } from '@oyaprotocol/ethereum';

const FILE_LIMIT = 65536;
const BODY_LIMIT = 131072;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const quantity = value => {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) throw new Error();
    return BigInt(value);
};
const positive = (value, fallback, max) => {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result <= 0 || result > max) throw new Error();
    return result;
};
const address = value => {
    const result = getAddress(value).toLowerCase();
    if (/^0x0{40}$/.test(result)) throw new Error();
    return result;
};
class EvidenceError extends Error {
    constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
const unavailable = reason => { throw new EvidenceError('unavailable', reason); };
const requireMatch = (condition, reason) => { if (!condition) throw new EvidenceError('mismatch', reason); };
const keys = (input, allowed) => {
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error();
};
const json = bytes => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new EvidenceError('mismatch', 'malformed_json'); }
};

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
        try { return json(buffer.subarray(0, size)); }
        catch { throw new EvidenceError('mismatch', 'invalid_input_json'); }
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
    keys(input, ['chainId', 'ledgerContract', 'rpcUrl', 'ipfsUrl',
        'rpcAuthorization', 'ipfsAuthorization', 'timeoutMs', 'requestTimeoutMs']);
    return { chainId: positive(input.chainId, undefined, Number.MAX_SAFE_INTEGER),
        ledgerContract: address(input.ledgerContract),
        rpc: endpoint(input.rpcUrl, input.rpcAuthorization), ipfs: endpoint(input.ipfsUrl, input.ipfsAuthorization, true),
        timeoutMs: positive(input.timeoutMs, 30000, 120000), requestTimeoutMs: positive(input.requestTimeoutMs, 10000, 30000) };
}
function record(input) {
    keys(input, ['transactionHash', 'logIndex', 'cid', 'nodeAddress', 'contentSha256']);
    if (!hash(input.transactionHash) || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error();
    const result = { transactionHash: input.transactionHash.toLowerCase(), logIndex: input.logIndex };
    if (input.cid !== undefined) result.cid = assertCanonicalCid(input.cid, 'cid');
    if (input.nodeAddress !== undefined) result.nodeAddress = address(input.nodeAddress);
    if (input.contentSha256 !== undefined) {
        if (!digest(input.contentSha256)) throw new Error();
        result.contentSha256 = input.contentSha256;
    }
    return result;
}

// One bounded read, including streaming; never follows redirects or retries.
async function readBytes(endpoint, suffix, body, signal, timeoutMs) {
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
        return Buffer.concat(chunks);
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

// The kernel has already checked canonical Base32, CIDv1 and SHA-256/32.
// Only the raw codec hashes cat bytes directly; UnixFS cat is a DAG projection.
function rawCidDigest(cid) {
    const bytes = [];
    let accumulator = 0, bits = 0;
    for (const character of cid.slice(1)) {
        accumulator = (accumulator << 5) | 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(character);
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push(accumulator >> bits); accumulator &= (1 << bits) - 1; }
    }
    return bytes[1] === 0x55 ? Buffer.from(bytes.slice(4)).toString('hex') : null;
}

export const evidenceExitCode = report => ({ verified: 0, mismatch: 2, unavailable: 3, partial: 4 })[report.status];
const initialReport = () => ({ version: 2, status: 'unavailable', reason: 'incomplete', stage: 'input',
    observedAt: new Date().toISOString(),
    checks: { ledger: 'not_checked', availability: 'not_checked', content: 'not_checked',
        cidBinding: 'not_checked', semantics: 'not_assessed' } });
export const evidenceInputFailure = error => ({ ...initialReport(),
    status: error instanceof EvidenceError ? error.status : 'unavailable',
    reason: error instanceof EvidenceError ? error.reason : 'input_unreadable' });

export async function verifyLedgerEvidence(identity, input) {
    const report = initialReport();
    const controller = new AbortController();
    let timer;
    try {
        let config, expected;
        try { config = settings(input); }
        catch { throw new EvidenceError('mismatch', 'invalid_settings'); }
        try { expected = record(identity); }
        catch { throw new EvidenceError('mismatch', 'invalid_record'); }
        timer = setTimeout(() => controller.abort(), config.timeoutMs);
        report.expected = { chainId: config.chainId, ledgerContract: config.ledgerContract,
            ...(expected.nodeAddress ? { nodeAddress: expected.nodeAddress } : {}),
            ...(expected.cid ? { cid: expected.cid } : {}) };
        report.transactionHash = expected.transactionHash;
        report.logIndex = expected.logIndex;
        const read = (endpoint, suffix, body) => readBytes(endpoint, suffix, body, controller.signal, config.requestTimeoutMs);
        let id = 0;
        const rpc = async (method, params) => {
            const request = { jsonrpc: '2.0', id: ++id, method, params };
            const reply = json(await read(config.rpc, '', request));
            requireMatch(object(reply) && reply.jsonrpc === '2.0' && reply.id === request.id &&
                (Object.hasOwn(reply, 'result') !== Object.hasOwn(reply, 'error')), 'malformed_rpc');
            if (Object.hasOwn(reply, 'error')) unavailable('rpc_error');
            return reply.result;
        };
        report.stage = 'chain';
        requireMatch(quantity(await rpc('eth_chainId', [])) === BigInt(config.chainId), 'chain_identity');
        report.stage = 'receipt';
        const raw = await rpc('eth_getTransactionReceipt', [report.transactionHash]);
        if (raw === null) unavailable('receipt_missing');
        // Parse the already bounded RPC result through the public kernel; no additional I/O.
        quantity(raw?.blockNumber);
        const { receipt } = await ethGetTransactionReceipt({ transactionHash: report.transactionHash,
            signal: controller.signal,
            config: { url: config.rpc.url, maxRetries: 0, retryDelayMs: 0, timeoutMs: config.requestTimeoutMs },
            fetch: async (_url, request) => ({ ok: true, status: 200,
                text: async () => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(request.body).id, result: raw }) }) });
        requireMatch(receipt.status === 'success', 'receipt_status');
        report.block = { number: receipt.blockNumber.toString(), hash: receipt.blockHash.toLowerCase() };
        report.stage = 'event';
        const indexes = receipt.logs.map(log => log.logIndex.toString());
        requireMatch(new Set(indexes).size === indexes.length, 'duplicate_log_index');
        const log = receipt.logs.find(log => log.logIndex === BigInt(expected.logIndex));
        requireMatch(log !== undefined, 'log_missing');
        const event = decodeLedgerEvent(log, config.ledgerContract);
        requireMatch(event && event.removed !== true, 'ledger_event');
        requireMatch(expected.nodeAddress === undefined || same(event.node, expected.nodeAddress), 'node_identity');
        requireMatch(expected.cid === undefined || event.cid === expected.cid, 'cid_identity');
        report.nodeAddress = event.node.toLowerCase();
        report.cid = event.cid;
        report.stage = 'block';
        const block = await rpc('eth_getBlockByNumber', [raw.blockNumber, false]);
        if (block === null) unavailable('block_missing');
        requireMatch(object(block) && same(block.hash, receipt.blockHash) &&
            quantity(block.number) === receipt.blockNumber, 'block_identity');
        report.block.timestamp = quantity(block.timestamp).toString();
        report.checks.ledger = 'verified';
        report.stage = 'content';
        const bytes = await read(config.ipfs, `/api/v0/cat?arg=${encodeURIComponent(report.cid)}`, undefined);
        report.checks.availability = 'available';
        report.contentBytes = bytes.length;
        const actual = createHash('sha256').update(bytes).digest('hex');
        const cidDigest = rawCidDigest(report.cid);
        if (cidDigest !== null) {
            requireMatch(actual === cidDigest, 'cid_content');
            report.checks.cidBinding = 'verified';
        }
        if (expected.contentSha256 !== undefined) requireMatch(actual === expected.contentSha256, 'expected_content');
        if (controller.signal.aborted) unavailable('deadline');
        const checked = cidDigest !== null || expected.contentSha256 !== undefined;
        report.checks.content = checked ? 'verified' : 'unsupported';
        report.contentVerification = cidDigest !== null
            ? (expected.contentSha256 === undefined ? 'cid_sha256' : 'cid_sha256_and_expected_sha256')
            : (checked ? 'expected_sha256' : null);
        report.status = checked ? 'verified' : 'partial';
        report.reason = checked ? 'snapshot_consistent' : 'content_integrity_unsupported';
        report.stage = 'complete';
    } catch (error) {
        report.status = error instanceof EvidenceError ? error.status : controller.signal.aborted ? 'unavailable' : 'mismatch';
        report.reason = error instanceof EvidenceError ? error.reason : controller.signal.aborted ? 'deadline' : 'malformed_evidence';
        if (report.stage === 'content') {
            if (report.status === 'mismatch') {
                report.checks.content = 'mismatch';
                if (report.reason === 'cid_content') report.checks.cidBinding = 'mismatch';
            } else if (report.checks.availability !== 'available') report.checks.availability = 'unavailable';
        } else if (report.stage !== 'input') report.checks.ledger = report.status;
    } finally {
        clearTimeout(timer);
        controller.abort();
        report.observedAt = new Date().toISOString();
    }
    return report;
}
