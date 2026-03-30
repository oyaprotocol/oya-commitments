import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { canonicalizeJson, isPlainObject } from './canonical-json.js';

const STORE_VERSION = 'oya-proposal-publication-store-v1';

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRequestId(requestId, label = 'requestId') {
    if (typeof requestId !== 'string' || !requestId.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return requestId.trim();
}

function normalizeTimestamp(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
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

function buildPublicationKey({ signer, requestId }) {
    return `${getAddress(signer).toLowerCase()}:${normalizeRequestId(requestId)}`;
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
        publishedAtMs: normalizeTimestamp(record.publishedAtMs, `${label}.publishedAtMs`),
        artifact: canonicalizeJson(cloneJson(record.artifact)),
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
    if (!isPlainObject(normalized.artifact)) {
        throw new Error(`${label}.artifact must be a JSON object.`);
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
            records[key] = normalizeStoredRecord(value, `records["${key}"]`);
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
    const tempPath = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
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

function createProposalPublicationStore({ stateFile }) {
    if (typeof stateFile !== 'string' || !stateFile.trim()) {
        throw new Error('createProposalPublicationStore requires a non-empty stateFile path.');
    }

    async function getRecord({ signer, requestId }) {
        const key = buildPublicationKey({ signer, requestId });
        const state = await readStoreState(stateFile);
        const record = state.records[key];
        return record ? cloneJson(record) : null;
    }

    async function prepareRecord({
        signer,
        requestId,
        signature,
        canonicalMessage,
        artifact,
        receivedAtMs,
        publishedAtMs,
    }) {
        const key = buildPublicationKey({ signer, requestId });
        const state = await readStoreState(stateFile);
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
        await writeStoreState(stateFile, state);
        return {
            status: 'created',
            record: cloneJson(record),
        };
    }

    async function saveRecord(record) {
        const normalized = normalizeStoredRecord(record, 'record');
        const key = buildPublicationKey({
            signer: normalized.signer,
            requestId: normalized.requestId,
        });
        const state = await readStoreState(stateFile);
        state.records[key] = {
            ...normalized,
            updatedAtMs: Date.now(),
        };
        await writeStoreState(stateFile, state);
        return cloneJson(state.records[key]);
    }

    return {
        stateFile,
        getRecord,
        prepareRecord,
        saveRecord,
    };
}

export { buildPublicationKey, createProposalPublicationStore };
