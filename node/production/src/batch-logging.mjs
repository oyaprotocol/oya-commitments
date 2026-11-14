import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishSignedMessage, verifySignedMessage } from '@oyaprotocol/messages';
import { publishToIpfs } from '@oyaprotocol/ipfs';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { digest, executionIdentity, validateTransaction, validId } from './inbox/protocol.mjs';
import { logCheckpointedCid } from './inbox/processor.mjs';

export function parseBatch(input, mode) {
    if (input === undefined) return undefined;
    if (mode !== 'ledger' || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join() !== 'maxMessages,maxWaitMs,stateDirectory' ||
        typeof input.stateDirectory !== 'string' || !input.stateDirectory.trim() || input.stateDirectory.includes('\0') ||
        !Number.isSafeInteger(input.maxMessages) || input.maxMessages < 2 || input.maxMessages > 100 ||
        !Number.isSafeInteger(input.maxWaitMs) || input.maxWaitMs < 1000 || input.maxWaitMs > 86400000) {
        throw new Error('batchLogging requires Ledger mode, stateDirectory, maxMessages (2..100), maxWaitMs (1000..86400000).');
    }
    return Object.freeze({ ...input });
}

export class BatchUnavailable extends Error {
    constructor(code = 'batch_unavailable') { super(code); this.code = code; }
}

// One process, one pending batch, 100 recent summaries. A private local filesystem is required.
export async function createBatchLogger({ config, signer, fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
    const policy = config.batchLogging;
    const identity = executionIdentity(config, signer.address);
    const directory = policy.stateDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, 'batch.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    const path = join(directory, 'batch.json');
    let state, active, timer, closed = false, fault = false, diskFault = false;
    const emit = record => { try { log(record); } catch {} };
    const unlock = async () => { await lock.close(); await unlink(lockPath); };
    const persist = async next => {
        const temporary = join(directory, 'batch.next');
        try {
            const file = await open(temporary, 'w', 0o600);
            try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
            await rename(temporary, path);
            const dir = await open(directory, 'r');
            try { await dir.sync(); } finally { await dir.close(); }
            state = next;
        } catch (error) {
            // A rename may have committed despite a lost acknowledgement. Restart must reload disk.
            diskFault = true;
            throw error;
        }
    };
    const summary = batch => ({ batchId: batch.id, status: batch.result?.status ?? (batch.transaction ? 'pending_transaction' : 'pending'),
        messageCids: batch.entries.map(entry => entry.cid), ...(batch.cid ? { manifestCid: batch.cid } : {}),
        ...(batch.transaction ? { transactionHash: batch.transaction.transactionHash } : {}),
        ...(batch.result?.error ? { error: batch.result.error } : {}) });
    try {
        try {
            if ((await stat(path)).size > 8_000_000) throw new Error('Batch journal too large.');
            state = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await persist({ version: 1, identity, lastLoggedAt: now(), pending: null, recent: [] });
        }
        if (state.version !== 1 || digest(state.identity) !== digest(identity) ||
            !Number.isSafeInteger(state.lastLoggedAt) || !Array.isArray(state.recent) || state.recent.length > 100) {
            throw new Error('Invalid batch journal or execution identity.');
        }
        for (const result of state.recent) {
            if (!result || Object.keys(result).some(key => !['batchId', 'status', 'messageCids', 'manifestCid', 'transactionHash', 'error'].includes(key)) ||
                !validId(result.batchId) || !['logged', 'failed'].includes(result.status) ||
                !Array.isArray(result.messageCids) || !result.messageCids.length || result.messageCids.length > 100 ||
                !/^0x[0-9a-f]{64}$/i.test(result.transactionHash) ||
                (result.status === 'failed' ? result.error !== 'transaction_reverted' : result.error !== undefined)) {
                throw new Error('Invalid batch result journal.');
            }
            assertCanonicalCid(result.manifestCid);
            result.messageCids.forEach(cid => assertCanonicalCid(cid));
        }
        if (state.pending) {
            const batch = state.pending;
            if (!validId(batch.id) || !Array.isArray(batch.entries) || !batch.entries.length || batch.entries.length > 100 ||
                Object.keys(batch).some(key => !['id', 'entries', 'sealed', 'cid', 'transaction'].includes(key)) ||
                (batch.sealed !== undefined && batch.sealed !== true) || (batch.cid && !batch.sealed)) {
                throw new Error('Invalid pending batch.');
            }
            for (const entry of batch.entries) {
                assertCanonicalCid(entry.cid);
                verifySignedMessage(entry.message);
                if (entry.message.text.includes('\0') || Buffer.byteLength(entry.message.text) > 8192) throw new Error('Invalid stored message.');
                if (digest(entry.message) !== entry.messageDigest) throw new Error('Invalid message checkpoint.');
            }
            if (batch.cid) assertCanonicalCid(batch.cid);
            if (batch.transaction) validateTransaction(batch.transaction, batch.cid, identity, config.limits);
        }
    } catch (error) { await unlock(); throw error; }

    const run = operation => {
        if (active || closed || diskFault) throw new BatchUnavailable();
        const promise = operation();
        active = promise;
        return promise.finally(() => { active = null; });
    };
    const due = () => state.pending && (state.pending.cid || state.pending.sealed ||
        state.pending.entries.length >= policy.maxMessages || now() - state.lastLoggedAt >= policy.maxWaitMs);
    const flush = async () => run(async () => {
        if (!state.pending) return;
        const signal = AbortSignal.timeout(config.operationTimeoutMs);
        try {
            // Freeze membership durably before publishing the manifest.
            if (!state.pending.sealed) await persist({ ...state, pending: { ...state.pending, sealed: true } });
            let batch = state.pending;
            if (!batch.transaction) {
                for (const entry of batch.entries) await config.authorize(entry.message);
            }
            if (!batch.cid) {
                const manifest = { type: 'oya-message-batch', version: 1, batchId: batch.id, execution: identity,
                    messages: batch.entries.map(({ cid, messageDigest }) => ({ cid, messageDigest })) };
                const publication = await publishToIpfs({ config: config.ipfs, fetch, signal,
                    content: JSON.stringify(manifest), filename: 'oya-message-batch.json', mediaType: 'application/json' });
                await persist({ ...state, pending: { ...batch, cid: publication.cid } });
                batch = state.pending;
            }
            const result = await logCheckpointedCid({ cid: batch.cid, transaction: batch.transaction, config, signer, fetch, signal,
                save: async checkpoint => persist({ ...state, pending: { ...state.pending, ...checkpoint } }) });
            const completed = summary({ ...state.pending, result });
            await persist({ ...state, pending: null, recent: [...state.recent, completed].slice(-100),
                lastLoggedAt: result.status === 'logged' ? now() : state.lastLoggedAt });
            fault = false;
            emit({ event: 'batch_result', ...completed });
        } catch (error) {
            fault = true;
            emit({ event: 'batch_retry', batchId: state.pending?.id, code: diskFault ? 'journal_failure' : 'publication_or_logging_failed' });
            throw error;
        }
    });
    const tick = () => {
        if (!active && !closed && !diskFault && due()) flush().catch(() => {});
    };
    timer = setInterval(tick, Math.min(1000, policy.maxWaitMs));
    timer.unref();
    return {
        status() { return { enabled: true, busy: Boolean(active), blocked: fault || diskFault,
            pending: state.pending ? summary(state.pending) : null, recent: state.recent }; },
        async accept(message, signal) {
            return run(async () => {
                message = await config.authorize(message);
                if (message.text.includes('\0')) throw new BatchUnavailable('invalid_text');
                if (Buffer.byteLength(message.text) > Math.min(config.maxTextBytes, 8192)) throw new BatchUnavailable('batch_text_too_large');
                const messageDigest = digest(message);
                const existing = state.pending?.entries.find(entry => entry.messageDigest === messageDigest);
                if (existing) return { status: 'pending', cid: existing.cid, batchId: state.pending.id };
                if (fault || state.pending?.sealed || state.pending?.entries.length >= policy.maxMessages) throw new BatchUnavailable();
                const publication = await publishSignedMessage(message, { config: config.ipfs, fetch, signal });
                const batch = state.pending ?? { id: randomUUID(), entries: [] };
                await persist({ ...state, pending: { ...batch, entries: [...batch.entries,
                    { cid: publication.cid, messageDigest, message }] } });
                return { status: 'pending', cid: publication.cid, uri: publication.uri, batchId: batch.id };
            });
        },
        flush,
        async close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            try { await active; } catch {}
            // Underfilled batches remain durable; shutdown never initiates a new transaction.
            await unlock();
        },
    };
}
