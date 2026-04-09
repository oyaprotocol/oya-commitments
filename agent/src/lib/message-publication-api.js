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
    buildSignedPublishedMessageEnvelope,
    buildSignedPublishedMessagePayload,
} from './signed-published-message.js';
import { buildMessagePublicationKey } from './message-publication-store.js';

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

function buildLastErrorPayload(error) {
    return {
        message: error?.message ?? String(error),
        atMs: Date.now(),
    };
}

function createMessagePublicationApiServer({
    config,
    store,
    logger = console,
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

    function emitLog(level, message) {
        const method =
            typeof logger?.[level] === 'function'
                ? logger[level].bind(logger)
                : typeof logger?.log === 'function'
                    ? logger.log.bind(logger)
                    : console.log.bind(console);
        method(message);
    }

    async function publishRecord(record, { signerAllowlistMode, nodeName }) {
        let nextRecord = record;
        if (!nextRecord.artifact || nextRecord.publishedAtMs === null) {
            const envelope = parseEnvelopeFromCanonicalMessage(nextRecord.canonicalMessage);
            const publishedAtMs = Date.now();
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
            nextRecord = await store.saveRecord({
                ...nextRecord,
                cid: publishResponse.cid,
                uri: publishResponse.uri,
                publishResult: publishResponse.publishResult,
                lastError: null,
            });
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
                    chainId: body.message?.chainId,
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
            try {
                record = await enqueuePublicationOperation(
                    publishOperationTails,
                    publicationKey,
                    async () => {
                        const latestRecord = await store.getRecord({
                            signer: signedAuth.sender.address,
                            chainId: identity.chainId,
                            requestId: identity.requestId,
                        });
                        if (!latestRecord) {
                            throw new Error('Publication record disappeared before publish.');
                        }
                        if (latestRecord.cid && latestRecord.pinned) {
                            return latestRecord;
                        }
                        return publishRecord(latestRecord, {
                            signerAllowlistMode: requireSignerAllowlist ? 'explicit' : 'open',
                            nodeName: config.messagePublishApiNodeName,
                        });
                    }
                );
            } catch (error) {
                try {
                    if (record) {
                        record = await store.saveRecord({
                            ...record,
                            lastError: buildLastErrorPayload(error),
                        });
                    }
                } catch (_saveError) {
                    // Best-effort only.
                }
                emitLog(
                    'warn',
                    `[oya-node] Message publish API failed request${formatRequestContext({
                        body,
                        signer: signedAuth.sender.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code: 'publish_failed',
                        statusCode: 502,
                    })}: ${error?.message ?? error}`
                );
                sendJson(res, 502, {
                    error: error?.message ?? 'Unable to publish signed message artifact.',
                    code: 'publish_failed',
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
            });
        });

        await new Promise((resolve) => {
            nextServer.listen(
                config.messagePublishApiPort,
                config.messagePublishApiHost,
                resolve
            );
        });
        server = nextServer;
        emitLog(
            'info',
            `[oya-node] Message publish API listening on http://${config.messagePublishApiHost}:${config.messagePublishApiPort}`
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
