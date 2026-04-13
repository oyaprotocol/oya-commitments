import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { canonicalizeJson, isPlainObject } from './canonical-json.js';

const STORE_VERSION = 'oya-proposal-publication-store-v1';
const storeOperationTails = new Map();
const SUBMISSION_STATUSES = new Set(['not_started', 'submitted', 'resolved', 'failed', 'uncertain']);

function cloneJson(value) {
    return value === undefined
        ? undefined
        : JSON.parse(
              JSON.stringify(value, (_key, item) =>
                  typeof item === 'bigint' ? item.toString() : item
              )
          );
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

function normalizeOptionalHash(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${label} must be a 32-byte hex string when provided.`);
    }
    return value.toLowerCase();
}

function normalizeOptionalObject(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object when provided.`);
    }
    return cloneJson(value);
}

function createEmptySubmissionState() {
    return {
        status: 'not_started',
        submittedAtMs: null,
        transactionHash: null,
        ogProposalHash: null,
        result: null,
        error: null,
        sideEffectsLikelyCommitted: false,
    };
}

function normalizeSubmissionState(value, label) {
    if (value === undefined || value === null) {
        return createEmptySubmissionState();
    }
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object.`);
    }

    const statusRaw = value.status ?? 'not_started';
    const status =
        typeof statusRaw === 'string' && SUBMISSION_STATUSES.has(statusRaw.trim().toLowerCase())
            ? statusRaw.trim().toLowerCase()
            : (() => {
                  throw new Error(
                      `${label}.status must be one of: ${Array.from(SUBMISSION_STATUSES).join(', ')}.`
                  );
              })();

    const normalized = {
        status,
        submittedAtMs: normalizeOptionalTimestamp(value.submittedAtMs, `${label}.submittedAtMs`),
        transactionHash: normalizeOptionalHash(value.transactionHash, `${label}.transactionHash`),
        ogProposalHash: normalizeOptionalHash(value.ogProposalHash, `${label}.ogProposalHash`),
        result: value.result === undefined ? null : cloneJson(value.result),
        error: value.error === undefined ? null : cloneJson(value.error),
        sideEffectsLikelyCommitted: Boolean(value.sideEffectsLikelyCommitted),
    };

    if (normalized.ogProposalHash !== null && normalized.transactionHash === null) {
        throw new Error(`${label}.transactionHash must be set when ogProposalHash exists.`);
    }
    if (
        (normalized.status === 'submitted' || normalized.status === 'resolved') &&
        normalized.submittedAtMs === null &&
        normalized.transactionHash !== null
    ) {
        throw new Error(`${label}.submittedAtMs must be set once transactionHash exists.`);
    }

    return normalized;
}

function deriveStoredRecordChainId(record, label = 'record') {
    if (record.chainId !== undefined && record.chainId !== null) {
        return normalizeChainId(record.chainId, `${label}.chainId`);
    }

    const artifactChainId = record.artifact?.signedProposal?.envelope?.chainId;
    if (artifactChainId !== undefined && artifactChainId !== null) {
        return normalizeChainId(artifactChainId, `${label}.artifact.signedProposal.envelope.chainId`);
    }

    if (typeof record.canonicalMessage === 'string' && record.canonicalMessage) {
        try {
            const parsed = JSON.parse(record.canonicalMessage);
            if (parsed?.chainId !== undefined && parsed?.chainId !== null) {
                return normalizeChainId(parsed.chainId, `${label}.canonicalMessage.chainId`);
            }
        } catch (error) {
            // Fall through to the explicit error below.
        }
    }

    throw new Error(`${label}.chainId must be present or derivable from canonicalMessage/artifact.`);
}

function buildPublicationKey({ signer, chainId, requestId }) {
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
        verification: normalizeOptionalObject(record.verification, `${label}.verification`),
        submission: normalizeSubmissionState(record.submission, `${label}.submission`),
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
            throw new Error(`Unsupported proposal publication store version in ${stateFile}.`);
        }
        if (!isPlainObject(parsed.records)) {
            throw new Error(`State file ${stateFile} records must be a JSON object.`);
        }
        const records = {};
        for (const [key, value] of Object.entries(parsed.records)) {
            const normalized = normalizeStoredRecord(value, `records["${key}"]`);
            const normalizedKey = buildPublicationKey({
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

function createProposalPublicationStore({ stateFile }) {
    if (typeof stateFile !== 'string' || !stateFile.trim()) {
        throw new Error('createProposalPublicationStore requires a non-empty stateFile path.');
    }
    const resolvedStateFile = path.resolve(stateFile.trim());
    const queueKey = resolvedStateFile;

    async function getRecord({ signer, chainId, requestId }) {
        return enqueueStoreOperation(queueKey, async () => {
            const key = buildPublicationKey({ signer, chainId, requestId });
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
            const key = buildPublicationKey({ signer, chainId, requestId });
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
                    verification: null,
                    submission: createEmptySubmissionState(),
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
            const key = buildPublicationKey({
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

    async function listRecords() {
        return enqueueStoreOperation(queueKey, async () => {
            const state = await readStoreState(resolvedStateFile);
            return Object.values(state.records).map((record) => cloneJson(record));
        });
    }

    return {
        stateFile: resolvedStateFile,
        getRecord,
        listRecords,
        prepareRecord,
        saveRecord,
    };
}

export { buildPublicationKey, createProposalPublicationStore };
