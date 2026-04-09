import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { canonicalizeJson, isPlainObject } from './canonical-json.js';

const STORE_VERSION = 'oya-message-publication-store-v1';
const storeOperationTails = new Map();

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRequestId(requestId, label = 'requestId') {
    if (typeof requestId !== 'string' || !requestId.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return requestId.trim();
}

function normalizeChainId(value, label = 'chainId') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function normalizeTimestamp(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
}

function normalizeOptionalTimestamp(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeTimestamp(value, label);
}

function normalizeOptionalString(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string when provided.`);
    }
    return value.trim();
}

function deriveStoredRecordChainId(record, label = 'record') {
    if (record.chainId !== undefined && record.chainId !== null) {
        return normalizeChainId(record.chainId, `${label}.chainId`);
    }

    const artifactChainId = record.artifact?.signedMessage?.envelope?.message?.chainId;
    if (artifactChainId !== undefined && artifactChainId !== null) {
        return normalizeChainId(artifactChainId, `${label}.artifact.signedMessage.envelope.message.chainId`);
    }

    if (typeof record.canonicalMessage === 'string' && record.canonicalMessage) {
        try {
            const parsed = JSON.parse(record.canonicalMessage);
            if (parsed?.message?.chainId !== undefined && parsed?.message?.chainId !== null) {
                return normalizeChainId(parsed.message.chainId, `${label}.canonicalMessage.message.chainId`);
            }
        } catch (error) {
            // Fall through to the explicit error below.
        }
    }

    throw new Error(`${label}.chainId must be present or derivable from canonicalMessage/artifact.`);
}

function buildMessagePublicationKey({ signer, chainId, requestId }) {
    return `${getAddress(signer).toLowerCase()}:${normalizeChainId(chainId)}:${normalizeRequestId(requestId)}`;
}

function createEmptyStoreState() {
    return {
        version: STORE_VERSION,
        records: {},
    };
}

function normalizeStoredRecord(record, label = 'record') {
    if (!isPlainObject(record)) {
        throw new Error(`${label} must be an object.`);
    }

    const normalized = {
        signer: getAddress(record.signer).toLowerCase(),
        chainId: deriveStoredRecordChainId(record, label),
        requestId: normalizeRequestId(record.requestId, `${label}.requestId`),
        signature:
            typeof record.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(record.signature)
                ? record.signature
                : (() => {
                      throw new Error(`${label}.signature must be a 65-byte hex string.`);
                  })(),
        canonicalMessage:
            typeof record.canonicalMessage === 'string' && record.canonicalMessage
                ? record.canonicalMessage
                : (() => {
                      throw new Error(`${label}.canonicalMessage must be a non-empty string.`);
                  })(),
        receivedAtMs: normalizeTimestamp(record.receivedAtMs, `${label}.receivedAtMs`),
        publishedAtMs: normalizeOptionalTimestamp(record.publishedAtMs, `${label}.publishedAtMs`),
        artifact:
            record.artifact === undefined || record.artifact === null
                ? null
                : canonicalizeJson(cloneJson(record.artifact)),
        cid: normalizeOptionalString(record.cid, `${label}.cid`),
        uri: normalizeOptionalString(record.uri, `${label}.uri`),
        pinned: Boolean(record.pinned),
        publishResult: record.publishResult === undefined ? null : cloneJson(record.publishResult),
        pinResult: record.pinResult === undefined ? null : cloneJson(record.pinResult),
        lastError: record.lastError === undefined ? null : cloneJson(record.lastError),
        createdAtMs: normalizeTimestamp(
            record.createdAtMs ?? record.receivedAtMs,
            `${label}.createdAtMs`
        ),
        updatedAtMs: normalizeTimestamp(
            record.updatedAtMs ?? record.receivedAtMs,
            `${label}.updatedAtMs`
        ),
    };

    if (normalized.artifact !== null && !isPlainObject(normalized.artifact)) {
        throw new Error(`${label}.artifact must be a JSON object.`);
    }
    if (normalized.cid !== null && normalized.artifact === null) {
        throw new Error(`${label}.artifact must be set once cid exists.`);
    }
    if (normalized.cid !== null && normalized.publishedAtMs === null) {
        throw new Error(`${label}.publishedAtMs must be set once cid exists.`);
    }
    if (normalized.pinned && normalized.cid === null) {
        throw new Error(`${label}.cid must be set when pinned=true.`);
    }

    return normalized;
}

async function readStoreState(stateFile) {
    try {
        const raw = await readFile(stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
            throw new Error(`State file ${stateFile} must contain a JSON object.`);
        }
        if (parsed.version !== STORE_VERSION) {
            throw new Error(`Unsupported message publication store version in ${stateFile}.`);
        }
        if (!isPlainObject(parsed.records)) {
            throw new Error(`State file ${stateFile} records must be a JSON object.`);
        }

        const records = {};
        for (const [key, value] of Object.entries(parsed.records)) {
            const normalized = normalizeStoredRecord(value, `records["${key}"]`);
            const normalizedKey = buildMessagePublicationKey({
                signer: normalized.signer,
                chainId: normalized.chainId,
                requestId: normalized.requestId,
            });
            records[normalizedKey] = normalized;
        }

        return {
            version: STORE_VERSION,
            records,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return createEmptyStoreState();
        }
        throw error;
    }
}

async function writeStoreState(stateFile, state) {
    const dir = path.dirname(stateFile);
    await mkdir(dir, { recursive: true });
    const tempPath = `${stateFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(
        tempPath,
        `${JSON.stringify(
            {
                version: STORE_VERSION,
                records: state.records,
            },
            null,
            2
        )}\n`,
        'utf8'
    );
    await rename(tempPath, stateFile);
}

function enqueueStoreOperation(queueKey, operation) {
    const prior = storeOperationTails.get(queueKey) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.catch(() => {});
    storeOperationTails.set(queueKey, tail);
    return run.finally(() => {
        if (storeOperationTails.get(queueKey) === tail) {
            storeOperationTails.delete(queueKey);
        }
    });
}

function createMessagePublicationStore({ stateFile }) {
    if (typeof stateFile !== 'string' || !stateFile.trim()) {
        throw new Error('createMessagePublicationStore requires a non-empty stateFile path.');
    }
    const resolvedStateFile = path.resolve(stateFile.trim());
    const queueKey = resolvedStateFile;

    async function getRecord({ signer, chainId, requestId }) {
        return enqueueStoreOperation(queueKey, async () => {
            const key = buildMessagePublicationKey({ signer, chainId, requestId });
            const state = await readStoreState(resolvedStateFile);
            const record = state.records[key];
            return record ? cloneJson(record) : null;
        });
    }

    async function prepareRecord({
        signer,
        chainId,
        requestId,
        signature,
        canonicalMessage,
        artifact,
        receivedAtMs,
        publishedAtMs,
    }) {
        return enqueueStoreOperation(queueKey, async () => {
            const key = buildMessagePublicationKey({ signer, chainId, requestId });
            const state = await readStoreState(resolvedStateFile);
            const existing = state.records[key];
            if (existing) {
                if (
                    existing.signature === signature &&
                    existing.canonicalMessage === canonicalMessage
                ) {
                    return {
                        status: 'existing',
                        record: cloneJson(existing),
                    };
                }
                return {
                    status: 'conflict',
                    record: cloneJson(existing),
                };
            }

            const nowMs = Date.now();
            const record = normalizeStoredRecord(
                {
                    signer,
                    chainId,
                    requestId,
                    signature,
                    canonicalMessage,
                    artifact,
                    receivedAtMs,
                    publishedAtMs,
                    cid: null,
                    uri: null,
                    pinned: false,
                    publishResult: null,
                    pinResult: null,
                    lastError: null,
                    createdAtMs: nowMs,
                    updatedAtMs: nowMs,
                },
                'record'
            );
            state.records[key] = record;
            await writeStoreState(resolvedStateFile, state);
            return {
                status: 'created',
                record: cloneJson(record),
            };
        });
    }

    async function saveRecord(record) {
        return enqueueStoreOperation(queueKey, async () => {
            const normalized = normalizeStoredRecord(record, 'record');
            const key = buildMessagePublicationKey({
                signer: normalized.signer,
                chainId: normalized.chainId,
                requestId: normalized.requestId,
            });
            const state = await readStoreState(resolvedStateFile);
            state.records[key] = {
                ...normalized,
                updatedAtMs: Date.now(),
            };
            await writeStoreState(resolvedStateFile, state);
            return cloneJson(state.records[key]);
        });
    }

    return {
        stateFile: resolvedStateFile,
        getRecord,
        prepareRecord,
        saveRecord,
    };
}

export { buildMessagePublicationKey, createMessagePublicationStore };
