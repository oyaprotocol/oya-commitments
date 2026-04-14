import http from 'node:http';
import { getAddress } from 'viem';
import { isPlainObject } from './canonical-json.js';
import { readJsonBody, sendJson } from './http-api.js';
import { pinIpfsCid, publishIpfsContent } from './ipfs.js';
import {
    buildBearerKeyEntries,
    authenticateBearerRequest,
    authenticateSignedRequest,
} from './signed-request-auth.js';
import {
    buildMessagePublicationArtifact,
    buildMessagePublicationFilename,
    buildMessagePublicationNodeAttestationEnvelope,
    buildMessagePublicationNodeAttestationPayload,
    buildSignedPublishedMessageEnvelope,
    buildSignedPublishedMessagePayload,
} from './signed-published-message.js';
import {
    MessagePublicationValidationError,
    normalizeMessagePublicationValidation,
} from './message-publication-validation.js';
import { buildMessagePublicationKey } from './message-publication-store.js';

class PublicationPersistenceError extends Error {
    constructor(message, { partialPublicationState = null, cause = undefined } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'PublicationPersistenceError';
        this.code = 'publish_persist_failed';
        this.partialPublicationState = partialPublicationState;
    }
}

function parseEnvelopeFromCanonicalMessage(canonicalMessage) {
    if (typeof canonicalMessage !== 'string' || !canonicalMessage.trim()) {
        throw new Error('canonicalMessage must be a non-empty string.');
    }

    let parsed;
    try {
        parsed = JSON.parse(canonicalMessage);
    } catch (error) {
        throw new Error('canonicalMessage must be valid JSON.');
    }
    return buildSignedPublishedMessageEnvelope(parsed);
}

function validateMessagePublishBody(body) {
    if (!isPlainObject(body)) {
        return { ok: false, message: 'Request body must be a JSON object.' };
    }

    const allowedFields = new Set(['message', 'auth']);
    for (const field of Object.keys(body)) {
        if (!allowedFields.has(field)) {
            return { ok: false, message: `Unsupported field: ${field}` };
        }
    }

    if (!isPlainObject(body.message)) {
        return { ok: false, message: 'message is required and must be a JSON object.' };
    }
    if (body.auth !== undefined && !isPlainObject(body.auth)) {
        return { ok: false, message: 'auth must be an object when provided.' };
    }

    return { ok: true };
}

function formatRequestContext({ body, signer, senderKeyId, code, statusCode }) {
    const parts = [];
    if (code) parts.push(`code=${code}`);
    if (statusCode !== undefined) parts.push(`status=${statusCode}`);
    if (typeof body?.message?.requestId === 'string' && body.message.requestId.trim()) {
        parts.push(`requestId=${body.message.requestId.trim()}`);
    }
    const loggedSigner =
        typeof signer === 'string' && signer.trim()
            ? signer.trim()
            : typeof body?.auth?.address === 'string' && body.auth.address.trim()
                ? body.auth.address.trim()
                : null;
    if (loggedSigner) parts.push(`signer=${loggedSigner}`);
    if (senderKeyId) parts.push(`senderKeyId=${senderKeyId}`);
    return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

function enqueuePublicationOperation(queueMap, queueKey, operation) {
    const prior = queueMap.get(queueKey) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.catch(() => {});
    queueMap.set(queueKey, tail);
    return run.finally(() => {
        if (queueMap.get(queueKey) === tail) {
            queueMap.delete(queueKey);
        }
    });
}

function enqueueMultiKeyOperation(queueMap, queueKeys, operation) {
    const normalizedQueueKeys = Array.from(
        new Set(
            (Array.isArray(queueKeys) ? queueKeys : [])
                .filter((queueKey) => typeof queueKey === 'string' && queueKey.trim())
                .map((queueKey) => queueKey.trim())
        )
    ).sort();
    if (normalizedQueueKeys.length === 0) {
        return operation();
    }

    const prior = Promise.all(
        normalizedQueueKeys.map((queueKey) => queueMap.get(queueKey) ?? Promise.resolve())
    );
    const run = prior.then(operation, operation);
    const tail = run.catch(() => {});
    for (const queueKey of normalizedQueueKeys) {
        queueMap.set(queueKey, tail);
    }
    return run.finally(() => {
        for (const queueKey of normalizedQueueKeys) {
            if (queueMap.get(queueKey) === tail) {
                queueMap.delete(queueKey);
            }
        }
    });
}

function normalizeMessagePublicationLockKeys(value) {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error('Message publication lock key hook must return an array when provided.');
    }
    return Array.from(
        new Set(
            value
                .filter((item) => typeof item === 'string' && item.trim())
                .map((item) => item.trim())
        )
    ).sort();
}

function buildLastErrorPayload(error) {
    const payload = {
        message: error?.message ?? String(error),
        atMs: Date.now(),
    };
    if (typeof error?.code === 'string' && error.code) {
        payload.code = error.code;
    }
    if (error?.details !== undefined && error?.details !== null) {
        payload.details = error.details;
    }
    return payload;
}

function normalizeOptionalChainIdForSignedAuth(value) {
    if (value === undefined || value === null) {
        return value;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return value;
    }
    return parsed;
}

function canReuseVolatilePublicationState(record, publicationState) {
    return Boolean(
        record &&
            publicationState &&
            publicationState.signature === record.signature &&
            publicationState.canonicalMessage === record.canonicalMessage
    );
}

function createMessagePublicationApiServer({
    config,
    store,
    logger = console,
    nodeSigner,
    validateMessagePublication,
    deriveMessagePublicationLockKeys,
} = {}) {
    if (!config) {
        throw new Error('createMessagePublicationApiServer requires config.');
    }
    if (!store) {
        throw new Error('createMessagePublicationApiServer requires store.');
    }
    if (!config.ipfsEnabled) {
        throw new Error('Message publication API requires ipfsEnabled=true.');
    }
    if (!nodeSigner || typeof nodeSigner !== 'object') {
        throw new Error('Message publication API requires a nodeSigner.');
    }
    if (typeof nodeSigner.address !== 'string' || !nodeSigner.address.trim()) {
        throw new Error('Message publication API nodeSigner.address must be a non-empty string.');
    }
    if (typeof nodeSigner.signMessage !== 'function') {
        throw new Error('Message publication API nodeSigner.signMessage(message) is required.');
    }
    if (
        validateMessagePublication !== undefined &&
        typeof validateMessagePublication !== 'function'
    ) {
        throw new Error(
            'Message publication API validateMessagePublication must be a function when provided.'
        );
    }
    if (
        deriveMessagePublicationLockKeys !== undefined &&
        typeof deriveMessagePublicationLockKeys !== 'function'
    ) {
        throw new Error(
            'Message publication API deriveMessagePublicationLockKeys must be a function when provided.'
        );
    }

    const keyEntries = buildBearerKeyEntries(config.messagePublishApiKeys ?? {});
    const signerAllowlist = new Set(
        (config.messagePublishApiSignerAllowlist ?? []).map((address) =>
            getAddress(address).toLowerCase()
        )
    );
    const requireSignerAllowlist = config.messagePublishApiRequireSignerAllowlist !== false;
    const signatureMaxAgeSeconds = Number(config.messagePublishApiSignatureMaxAgeSeconds ?? 300);
    const expectedChainId =
        config.chainId === undefined || config.chainId === null ? undefined : Number(config.chainId);
    if (requireSignerAllowlist && signerAllowlist.size === 0) {
        throw new Error(
            'Message publication API requires messagePublishApi.signerAllowlist when messagePublishApi.requireSignerAllowlist=true. MESSAGE_PUBLISH_API_KEYS_JSON is optional additional bearer gating.'
        );
    }

    let server;
    const publishOperationTails = new Map();
    const publicationConflictTails = new Map();
    const volatilePublicationStates = new Map();

    function emitLog(level, message) {
        const method =
            typeof logger?.[level] === 'function'
                ? logger[level].bind(logger)
                : typeof logger?.log === 'function'
                    ? logger.log.bind(logger)
                    : console.log.bind(console);
        method(message);
    }

    async function persistPublishedRecord(record, publicationKey, publicationState) {
        let persistError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const nextRecord = await store.saveRecord({
                    ...record,
                    signature: publicationState.signature,
                    canonicalMessage: publicationState.canonicalMessage,
                    artifact: publicationState.artifact,
                    publishedAtMs: publicationState.publishedAtMs,
                    cid: publicationState.cid,
                    uri: publicationState.uri,
                    publishResult: publicationState.publishResult,
                    lastError: null,
                });
                volatilePublicationStates.delete(publicationKey);
                return nextRecord;
            } catch (error) {
                persistError = error;
            }
        }

        throw new PublicationPersistenceError(
            'Published signed message artifact could not be persisted to the node store.',
            {
                partialPublicationState: publicationState,
                cause: persistError,
            }
        );
    }

    async function resolvePublicationValidation({
        record,
        envelope,
        publishedAtMs,
        publicationKey,
    }) {
        if (typeof validateMessagePublication !== 'function') {
            return null;
        }
        const validation = await validateMessagePublication({
            config,
            store,
            currentPublicationKey: publicationKey,
            currentRecord: record,
            envelope,
            message: envelope.message,
            receivedAtMs: record.receivedAtMs,
            publishedAtMs,
            getRecord: ({ signer, chainId, requestId }) =>
                store.getRecord({ signer, chainId, requestId }),
            listRecords:
                typeof store.listRecords === 'function'
                    ? () => store.listRecords()
                    : undefined,
        });
        return normalizeMessagePublicationValidation(validation, 'validation');
    }

    async function resolvePublicationLockKeys({
        envelope,
        record = null,
        publicationKey = null,
    }) {
        if (typeof deriveMessagePublicationLockKeys !== 'function') {
            return [];
        }
        return normalizeMessagePublicationLockKeys(
            await deriveMessagePublicationLockKeys({
                config,
                store,
                currentPublicationKey: publicationKey,
                currentRecord: record,
                envelope,
                message: envelope.message,
            })
        );
    }

    async function publishRecord(record, { signerAllowlistMode, nodeName, publicationKey }) {
        let nextRecord = { ...record };
        const volatilePublicationState = volatilePublicationStates.get(publicationKey);
        if (!nextRecord.cid && volatilePublicationState) {
            if (canReuseVolatilePublicationState(nextRecord, volatilePublicationState)) {
                nextRecord = await persistPublishedRecord(
                    nextRecord,
                    publicationKey,
                    volatilePublicationState
                );
            } else {
                volatilePublicationStates.delete(publicationKey);
            }
        }

        if (!nextRecord.artifact || nextRecord.publishedAtMs === null) {
            const envelope = parseEnvelopeFromCanonicalMessage(nextRecord.canonicalMessage);
            const publishedAtMs = Date.now();
            const validation = await resolvePublicationValidation({
                record: nextRecord,
                envelope,
                publishedAtMs,
                publicationKey,
            });
            const nodeAttestationEnvelope = buildMessagePublicationNodeAttestationEnvelope({
                address: nodeSigner.address,
                timestampMs: publishedAtMs,
                publication: {
                    receivedAtMs: nextRecord.receivedAtMs,
                    publishedAtMs,
                    signerAllowlistMode,
                    nodeName,
                    validation,
                },
                signedMessage: {
                    signer: nextRecord.signer,
                    signature: nextRecord.signature,
                    canonicalMessage: nextRecord.canonicalMessage,
                },
            });
            const nodeAttestationCanonicalMessage =
                buildMessagePublicationNodeAttestationPayload(nodeAttestationEnvelope);
            const nodeAttestationSignature = await nodeSigner.signMessage(
                nodeAttestationCanonicalMessage
            );
            const artifact = buildMessagePublicationArtifact({
                signer: nextRecord.signer,
                signature: nextRecord.signature,
                signedAtMs: envelope.timestampMs,
                canonicalMessage: nextRecord.canonicalMessage,
                envelope,
                receivedAtMs: nextRecord.receivedAtMs,
                publishedAtMs,
                signerAllowlistMode,
                nodeName,
                validation,
                nodeAttestation: {
                    signer: nodeSigner.address,
                    signature: nodeAttestationSignature,
                    signedAtMs: publishedAtMs,
                    canonicalMessage: nodeAttestationCanonicalMessage,
                    envelope: nodeAttestationEnvelope,
                },
            });
            nextRecord = await store.saveRecord({
                ...nextRecord,
                artifact,
                publishedAtMs,
                lastError: null,
            });
        }

        if (!nextRecord.cid) {
            const publishResponse = await publishIpfsContent({
                config,
                json: nextRecord.artifact,
                filename: buildMessagePublicationFilename({
                    requestId: nextRecord.requestId,
                    signer: nextRecord.signer,
                }),
                pin: false,
            });
            const publicationState = {
                signature: nextRecord.signature,
                canonicalMessage: nextRecord.canonicalMessage,
                artifact: nextRecord.artifact,
                publishedAtMs: nextRecord.publishedAtMs,
                cid: publishResponse.cid,
                uri: publishResponse.uri,
                publishResult: publishResponse.publishResult,
            };
            volatilePublicationStates.set(publicationKey, publicationState);
            nextRecord = await persistPublishedRecord(
                nextRecord,
                publicationKey,
                publicationState
            );
        }

        if (!nextRecord.pinned) {
            const pinResult = await pinIpfsCid({
                config,
                cid: nextRecord.cid,
            });
            nextRecord = await store.saveRecord({
                ...nextRecord,
                pinned: true,
                pinResult,
                lastError: null,
            });
        }

        return nextRecord;
    }

    async function start() {
        if (server) {
            return server;
        }

        const nextServer = http.createServer(async (req, res) => {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://localhost');
            } catch (error) {
                sendJson(res, 400, { error: 'Invalid request URL.' });
                return;
            }

            if (req.method === 'GET' && url.pathname === '/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (!(req.method === 'POST' && url.pathname === '/v1/messages/publish')) {
                sendJson(res, 404, { error: 'Not found.' });
                return;
            }

            const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
            if (contentType && !contentType.includes('application/json')) {
                sendJson(res, 415, { error: 'Content-Type must be application/json.' });
                return;
            }

            let body;
            try {
                body = await readJsonBody(req, { maxBytes: config.messagePublishApiMaxBodyBytes });
            } catch (error) {
                if (error?.code === 'body_too_large') {
                    sendJson(res, 413, { error: error.message });
                    return;
                }
                if (error?.code === 'invalid_json') {
                    sendJson(res, 400, { error: error.message });
                    return;
                }
                sendJson(res, 400, { error: 'Invalid request body.' });
                return;
            }

            const validation = validateMessagePublishBody(body);
            if (!validation.ok) {
                emitLog(
                    'warn',
                    `[oya-node] Message publish API rejected request${formatRequestContext({
                        body,
                        code: 'invalid_request',
                        statusCode: 400,
                    })}: ${validation.message}`
                );
                sendJson(res, 400, { error: validation.message });
                return;
            }

            const nowMs = Date.now();
            const bearerKeyId =
                keyEntries.length > 0
                    ? authenticateBearerRequest({
                          authorizationHeader: req.headers.authorization,
                          keyEntries,
                      })
                    : null;
            if (keyEntries.length > 0 && !bearerKeyId) {
                emitLog(
                    'warn',
                    `[oya-node] Message publish API rejected request${formatRequestContext({
                        body,
                        code: 'missing_bearer_token',
                        statusCode: 401,
                    })}: Bearer token is required.`
                );
                sendJson(
                    res,
                    401,
                    { error: 'Bearer token is required.' },
                    { 'WWW-Authenticate': 'Bearer realm="oya-message-publish-api"' }
                );
                return;
            }

            const signedAuth = await authenticateSignedRequest({
                body: {
                    chainId: normalizeOptionalChainIdForSignedAuth(body.message?.chainId),
                    requestId: body.message?.requestId,
                    auth: body.auth,
                },
                signerAllowlist,
                requireSignerAllowlist,
                signatureMaxAgeSeconds,
                expectedChainId,
                nowMs,
                allowExpired: true,
                buildPayload: ({ declaredAddress }) =>
                    buildSignedPublishedMessagePayload({
                        address: declaredAddress,
                        timestampMs: body.auth.timestampMs,
                        message: body.message,
                    }),
            });
            if (!signedAuth?.ok) {
                emitLog(
                    'warn',
                    `[oya-node] Message publish API rejected request${formatRequestContext({
                        body,
                        signer: body?.auth?.address,
                        code: 'signed_auth_failed',
                        statusCode: signedAuth?.statusCode ?? 401,
                    })}: ${signedAuth?.message ?? 'Unauthorized.'}`
                );
                const extraHeaders =
                    keyEntries.length > 0
                        ? { 'WWW-Authenticate': 'Bearer realm="oya-message-publish-api"' }
                        : {};
                sendJson(
                    res,
                    signedAuth?.statusCode ?? 401,
                    {
                        error: signedAuth?.message ?? 'Unauthorized.',
                    },
                    extraHeaders
                );
                return;
            }

            const envelope = buildSignedPublishedMessageEnvelope({
                address: signedAuth.sender.address,
                timestampMs: signedAuth.sender.signedAtMs,
                message: body.message,
            });
            const identity = envelope.message;
            const existingRecord = await store.getRecord({
                signer: signedAuth.sender.address,
                chainId: identity.chainId,
                requestId: identity.requestId,
            });
            const exactExistingMatch =
                existingRecord?.signature === signedAuth.sender.signature &&
                existingRecord?.canonicalMessage === signedAuth.payload;

            if (signedAuth.isExpired && !exactExistingMatch) {
                emitLog(
                    'warn',
                    `[oya-node] Message publish API rejected request${formatRequestContext({
                        body,
                        signer: signedAuth.sender.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code: existingRecord ? 'request_conflict' : 'signed_auth_failed',
                        statusCode: existingRecord ? 409 : 401,
                    })}: ${
                        existingRecord
                            ? 'requestId already exists for this signer with different signed contents.'
                            : 'Signed request expired or has an invalid timestamp.'
                    }`
                );
                if (existingRecord) {
                    sendJson(res, 409, {
                        error: 'requestId already exists for this signer with different signed contents.',
                        code: 'request_conflict',
                        cid: existingRecord.cid ?? null,
                        uri: existingRecord.uri ?? null,
                    });
                } else {
                    const extraHeaders =
                        keyEntries.length > 0
                            ? { 'WWW-Authenticate': 'Bearer realm="oya-message-publish-api"' }
                            : {};
                    sendJson(
                        res,
                        401,
                        {
                            error: 'Signed request expired or has an invalid timestamp.',
                        },
                        extraHeaders
                    );
                }
                return;
            }

            const prepared = exactExistingMatch
                ? {
                      status: 'existing',
                      record: existingRecord,
                  }
                : await store.prepareRecord({
                      signer: signedAuth.sender.address,
                      chainId: identity.chainId,
                      requestId: identity.requestId,
                      signature: signedAuth.sender.signature,
                      canonicalMessage: signedAuth.payload,
                      artifact: null,
                      receivedAtMs: nowMs,
                      publishedAtMs: null,
                  });

            if (prepared.status === 'conflict') {
                emitLog(
                    'warn',
                    `[oya-node] Message publish API rejected request${formatRequestContext({
                        body,
                        signer: signedAuth.sender.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code: 'request_conflict',
                        statusCode: 409,
                    })}: requestId already exists with different signed contents.`
                );
                sendJson(res, 409, {
                    error: 'requestId already exists for this signer with different signed contents.',
                    code: 'request_conflict',
                    cid: prepared.record?.cid ?? null,
                    uri: prepared.record?.uri ?? null,
                });
                return;
            }

            let record = prepared.record;
            const publicationKey = buildMessagePublicationKey({
                signer: signedAuth.sender.address,
                chainId: identity.chainId,
                requestId: identity.requestId,
            });
            let publicationLockKeys;
            try {
                publicationLockKeys = await resolvePublicationLockKeys({
                    envelope,
                    record,
                    publicationKey,
                });
                record = await enqueuePublicationOperation(
                    publishOperationTails,
                    publicationKey,
                    async () => {
                        const loadLatestRecord = async () => {
                            const latestRecord = await store.getRecord({
                                signer: signedAuth.sender.address,
                                chainId: identity.chainId,
                                requestId: identity.requestId,
                            });
                            if (!latestRecord) {
                                throw new Error('Publication record disappeared before publish.');
                            }
                            return latestRecord;
                        };
                        const performPublish = async (latestRecord) => {
                            if (latestRecord.cid && latestRecord.pinned) {
                                return latestRecord;
                            }
                            return publishRecord(latestRecord, {
                                signerAllowlistMode: requireSignerAllowlist ? 'explicit' : 'open',
                                nodeName: config.messagePublishApiNodeName,
                                publicationKey,
                            });
                        };

                        let latestRecord = await loadLatestRecord();
                        if (publicationLockKeys.length === 0) {
                            return performPublish(latestRecord);
                        }

                        return enqueueMultiKeyOperation(
                            publicationConflictTails,
                            publicationLockKeys,
                            async () => {
                                latestRecord = await loadLatestRecord();
                                return performPublish(latestRecord);
                            }
                        );
                    }
                );
            } catch (error) {
                const partialPublicationState =
                    error instanceof PublicationPersistenceError
                        ? error.partialPublicationState
                        : null;
                try {
                    const latestRecord = await store.getRecord({
                        signer: signedAuth.sender.address,
                        chainId: identity.chainId,
                        requestId: identity.requestId,
                    });
                    if (latestRecord) {
                        record = latestRecord;
                    }
                    if (partialPublicationState) {
                        record = {
                            ...(record ?? {}),
                            ...partialPublicationState,
                        };
                    }
                    if (record) {
                        record = await store.saveRecord({
                            ...record,
                            lastError: buildLastErrorPayload(error),
                        });
                        if (partialPublicationState && record.cid) {
                            volatilePublicationStates.delete(publicationKey);
                        }
                    }
                } catch (_saveError) {
                    if (partialPublicationState) {
                        record = {
                            ...(record ?? {}),
                            ...partialPublicationState,
                            lastError: buildLastErrorPayload(error),
                        };
                    }
                }
                const errorCode = partialPublicationState
                    ? 'publish_persist_failed'
                    : 'publish_failed';
                emitLog(
                    'warn',
                    `[oya-node] Message publish API failed request${formatRequestContext({
                        body,
                        signer: signedAuth.sender.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code:
                            error instanceof MessagePublicationValidationError
                                ? error.code
                                : errorCode,
                        statusCode:
                            error instanceof MessagePublicationValidationError
                                ? error.statusCode
                                : 502,
                    })}: ${error?.message ?? error}`
                );
                if (error instanceof MessagePublicationValidationError) {
                    sendJson(res, error.statusCode, {
                        error: error.message,
                        code: error.code,
                        details: error.details,
                        cid: record?.cid ?? null,
                        uri: record?.uri ?? null,
                    });
                    return;
                }
                sendJson(res, 502, {
                    error: error?.message ?? 'Unable to publish signed message artifact.',
                    code: errorCode,
                    cid: record?.cid ?? null,
                    uri: record?.uri ?? null,
                });
                return;
            }

            sendJson(res, prepared.status === 'created' ? 202 : 200, {
                status: prepared.status === 'created' ? 'published' : 'duplicate',
                signer: record.signer,
                chainId: record.chainId,
                requestId: record.requestId,
                cid: record.cid,
                uri: record.uri,
                pinned: Boolean(record.pinned),
                validation: record.artifact?.publication?.validation ?? null,
                nodeSigner:
                    record.artifact?.publication?.nodeAttestation?.signer ?? null,
            });
        });

        await new Promise((resolve, reject) => {
            function handleError(error) {
                nextServer.off('listening', handleListening);
                reject(error);
            }
            function handleListening() {
                nextServer.off('error', handleError);
                resolve();
            }

            nextServer.once('error', handleError);
            nextServer.once('listening', handleListening);
            nextServer.listen(
                config.messagePublishApiPort,
                config.messagePublishApiHost
            );
        });
        server = nextServer;
        emitLog(
            'info',
            `[oya-node] Message publish API listening on http://${config.messagePublishApiHost}:${config.messagePublishApiPort} (nodeSigner=${getAddress(nodeSigner.address).toLowerCase()})`
        );
        return server;
    }

    async function stop() {
        if (!server) {
            return;
        }
        const current = server;
        server = null;
        await new Promise((resolve, reject) => {
            current.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    return {
        start,
        stop,
    };
}

export { createMessagePublicationApiServer };
