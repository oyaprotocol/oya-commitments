import { assertCanonicalCid } from '@oyaprotocol/utils';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { nodeSendSettings, prepareOutbox } from './local.mjs';
import { getAddress, Wallet } from 'ethers';
import { readBounded } from './config.mjs';
import { inboxUrl } from '../inbox/config.mjs';
import { createInboxClient } from '../inbox/http.mjs';
import { InboxError, signJob, targetName, validateJob } from '../inbox/protocol.mjs';

export class PeerSendError extends Error {
    constructor(code) { super(code); this.name = 'PeerSendError'; this.code = code; }
}
const fail = code => { throw new PeerSendError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join() === expected;

function address(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error();
    const result = getAddress(value).toLowerCase();
    if (/^0x0{40}$/.test(result)) throw new Error();
    return result;
}

function destination(record) {
    if (!object(record) || typeof record.url !== 'string' || record.url.length > 4096 ||
        !/^https?:\/\/[^/\s?#@\\]+\/v1\/jobs$/.test(record.url)) throw new Error();
    const url = new URL(record.url);
    if (url.pathname !== '/v1/jobs' || url.username || url.password || url.search || url.hash) throw new Error();
    return { nodeAddress: address(record.nodeAddress), origin: inboxUrl(url.origin), target: targetName(record.target) };
}

async function selectDestination(registryFile, nodeAddress) {
    const selected = address(nodeAddress);
    const records = JSON.parse(await readBounded(registryFile, 1048576));
    if (!Array.isArray(records) || records.length > 1000) throw new Error();
    // Validate every address before selection; duplicate selected addresses are ambiguous even if identical.
    const matches = records.filter(record => {
        if (!object(record) || !['nodeAddress', 'url', 'target'].every(key =>
            typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 4096)) throw new Error();
        return address(record.nodeAddress) === selected;
    });
    if (matches.length !== 1) throw new Error();
    return destination(matches[0]);
}

function messageText(text) {
    if (typeof text !== 'string' || !/^[\x01-\x7f]+$/.test(text) || Buffer.byteLength(text) > 8192) throw new Error();
    return text;
}

async function validateSaved(saved, checkExpiry) {
    if (!keys(saved, 'destination,job,version') || saved.version !== 1 ||
        !keys(saved.destination, 'nodeAddress,origin,target')) throw new Error();
    const pinned = saved.destination;
    const checked = destination({ nodeAddress: pinned.nodeAddress, url: `${pinned.origin}/v1/jobs`, target: pinned.target });
    if (checked.origin !== pinned.origin || checked.nodeAddress !== pinned.nodeAddress) throw new Error();
    messageText(saved.job?.message?.text);
    await validateJob(saved.job, { target: pinned.target, allowedSigners: [saved.job.message.signer], checkExpiry: false });
    if (checkExpiry && saved.job.expiresAt <= Date.now()) fail('job_expired');
    if (checkExpiry && saved.job.expiresAt > Date.now() + 7 * 86400_000) throw new Error();
    return saved;
}

export async function loadSaved(file, checkExpiry = false) {
    try { return await validateSaved(JSON.parse(await readBounded(file, 65536)), checkExpiry); }
    catch (error) {
        if (error instanceof PeerSendError) throw error;
        fail('invalid_saved_job');
    }
}

async function saveNew(file, saved) {
    // Leave partial output on failure. Never overwrite, unlink, or silently replace evidence.
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(saved, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const parent = await open(dirname(resolve(file)), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
}

async function request(saved, operation, transport = globalThis.fetch, { signal, check, evidence = false } = {}) {
    const { job, destination: pinned } = saved;
    const base = { operation, saved: true, requestId: job.requestId, expiresAt: job.expiresAt,
        nodeAddress: pinned.nodeAddress, target: pinned.target, admission: 'unknown', execution: 'unknown' };
    try {
        signal?.throwIfAborted();
        const result = await createInboxClient(pinned.origin, undefined, (...args) => {
            // Check after request serialization, immediately before the external effect.
            check?.();
            signal?.throwIfAborted();
            return transport(...args);
        })(
            operation === 'status' ? '/v1/status' : '/v1/jobs', job, signal);
        if (!object(result) || result.requestId !== job.requestId ||
            !['queued', 'processing', 'published', 'logged', 'failed', 'expired'].includes(result.status)) throw new Error();
        const identifiers = {};
        if (evidence && operation === 'status' && result.status === 'logged') {
            identifiers.cid = assertCanonicalCid(result.cid, 'cid');
            if (typeof result.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)) throw new Error();
            identifiers.transactionHash = result.transactionHash.toLowerCase();
        }
        // Identifiers remain receiver claims, never proof of publication.
        return { ...base, outcome: operation === 'status' ? 'status' : 'admitted',
            admission: 'reported', execution: result.status, ...identifiers };
    } catch (error) {
        if (error instanceof InboxError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
            return { ...base, outcome: 'http_error', httpStatus: error.status };
        }
        return { ...base, outcome: operation === 'status' ? 'status_unknown' : 'delivery_unknown' };
    }
}

async function prepareJob({ registryFile, nodeAddress, textFile, key }, { signal, check } = {}) {
    const pinned = await selectDestination(registryFile, nodeAddress);
    const text = messageText(await readBounded(textFile, 8192));
    if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error();
    const wallet = new Wallet(key);
    const job = await signJob({ address: wallet.address, signMessage: value => {
        // Both signatures need a synchronous gate, including after the first await.
        check?.();
        signal?.throwIfAborted();
        return wallet.signMessage(value);
    } }, pinned.target, text);
    return validateSaved({ version: 1, destination: pinned, job }, true);
}

/** Send as the selected node, retaining a discoverable recovery file before HTTP. */
export async function sendFromNode(nodeAddress, textFile, { env = process.env, transport, signal, check } = {}) {
    let settings, saved;
    try {
        signal?.throwIfAborted();
        settings = await nodeSendSettings(env);
        saved = await prepareJob({ ...settings, nodeAddress, textFile }, { signal, check });
    } catch { fail('invalid_node_settings_or_input'); }
    const savedFile = join(settings.directory, 'peer-outbox', `${saved.job.requestId}.json`);
    try {
        await prepareOutbox(settings.directory);
        await saveNew(savedFile, saved);
    } catch {
        const error = new PeerSendError('save_failed');
        error.savedFile = savedFile; // May be partial or absent. Preserve it for inspection.
        throw error;
    }
    return { ...await request(saved, 'send', transport, { signal, check }), savedFile };
}

/** Sign, durably save, then submit once. The installed registry is never fetched implicitly. */
export async function sendToPeer({ registryFile, nodeAddress, keyFile, textFile, outputFile }, { transport } = {}) {
    let saved;
    try {
        const key = (await readBounded(keyFile, 256)).trim();
        saved = await prepareJob({ registryFile, nodeAddress, textFile, key });
    } catch { fail('invalid_input'); }
    try { await saveNew(outputFile, saved); }
    catch { fail('save_failed'); }
    return request(saved, 'send', transport);
}

/** Reuse the original destination, signatures, ID and deadline without loading a key. */
export async function retryPeerJob(savedFile, { transport } = {}) {
    return request(await loadSaved(savedFile, true), 'retry', transport);
}

/** Query retained jobs, including expired ones, without loading a key. */
export async function peerJobStatus(savedFile, { transport, signal, check, evidence = false } = {}) {
    return request(await loadSaved(savedFile, false), 'status', transport, { signal, check, evidence });
}
