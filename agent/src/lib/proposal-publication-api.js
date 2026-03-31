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
    buildProposalPublicationArtifact,
    buildProposalPublicationFilename,
    buildSignedProposalEnvelope,
    buildSignedProposalPayload,
} from './signed-proposal.js';
import { buildPublicationKey } from './proposal-publication-store.js';

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
    return buildSignedProposalEnvelope(parsed);
}

function buildEnvelopeIdentityIgnoringTimestamp(envelope) {
    const normalized = buildSignedProposalEnvelope(envelope);
    const { timestampMs: _ignoredTimestamp, ...rest } = normalized;
    return JSON.stringify(rest);
}

function canRefreshPendingRecord({ existingRecord, envelope }) {
    if (!existingRecord || existingRecord.cid !== null || existingRecord.pinned) {
        return false;
    }

    try {
        const existingEnvelope = parseEnvelopeFromCanonicalMessage(existingRecord.canonicalMessage);
        return (
            buildEnvelopeIdentityIgnoringTimestamp(existingEnvelope) ===
            buildEnvelopeIdentityIgnoringTimestamp(envelope)
        );
    } catch (error) {
        return false;
    }
}

function validateProposalPublishBody(body) {
    if (!isPlainObject(body)) {
        return { ok: false, message: 'Request body must be a JSON object.' };
    }

    const allowedFields = new Set([
        'chainId',
        'requestId',
        'commitmentSafe',
        'ogModule',
        'transactions',
        'explanation',
        'metadata',
        'deadline',
        'auth',
    ]);
    for (const field of Object.keys(body)) {
        if (!allowedFields.has(field)) {
            return { ok: false, message: `Unsupported field: ${field}` };
        }
    }

    if (!Number.isInteger(body.chainId) || body.chainId < 1) {
        return { ok: false, message: 'chainId is required and must be a positive integer.' };
    }
    if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
        return { ok: false, message: 'requestId is required and must be a string.' };
    }
    if (typeof body.commitmentSafe !== 'string' || !body.commitmentSafe.trim()) {
        return { ok: false, message: 'commitmentSafe is required and must be a string.' };
    }
    if (typeof body.ogModule !== 'string' || !body.ogModule.trim()) {
        return { ok: false, message: 'ogModule is required and must be a string.' };
    }
    if (!Array.isArray(body.transactions) || body.transactions.length === 0) {
        return { ok: false, message: 'transactions is required and must be a non-empty array.' };
    }
    if (typeof body.explanation !== 'string' || !body.explanation.trim()) {
        return { ok: false, message: 'explanation is required and must be a non-empty string.' };
    }
    if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
        return { ok: false, message: 'metadata must be an object when provided.' };
    }
    if (body.deadline !== undefined && !Number.isInteger(body.deadline)) {
        return {
            ok: false,
            message: 'deadline must be an integer Unix timestamp in milliseconds when provided.',
        };
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
    if (typeof body?.requestId === 'string' && body.requestId.trim()) {
        parts.push(`requestId=${body.requestId.trim()}`);
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

function createProposalPublicationApiServer({ config, store, logger = console } = {}) {
    if (!config) {
        throw new Error('createProposalPublicationApiServer requires config.');
    }
    if (!store) {
        throw new Error('createProposalPublicationApiServer requires store.');
    }
    if (!config.ipfsEnabled) {
        throw new Error('Proposal publication API requires ipfsEnabled=true.');
    }

    const keyEntries = buildBearerKeyEntries(config.proposalPublishApiKeys ?? {});
    const signerAllowlist = new Set(
        (config.proposalPublishApiSignerAllowlist ?? []).map((address) =>
            getAddress(address).toLowerCase()
        )
    );
    const requireSignerAllowlist = config.proposalPublishApiRequireSignerAllowlist !== false;
    const signatureMaxAgeSeconds = Number(config.proposalPublishApiSignatureMaxAgeSeconds ?? 300);
    const expectedChainId =
        config.chainId === undefined || config.chainId === null
            ? undefined
            : Number(config.chainId);
    if (requireSignerAllowlist && signerAllowlist.size === 0) {
        throw new Error(
            'Proposal publication API requires proposalPublishApi.signerAllowlist when proposalPublishApi.requireSignerAllowlist=true. PROPOSAL_PUBLISH_API_KEYS_JSON is optional additional bearer gating.'
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
        let nextRecord = { ...record };
        if (!nextRecord.cid) {
            const envelope = parseEnvelopeFromCanonicalMessage(nextRecord.canonicalMessage);
            const publishedAtMs = Date.now();
            const artifact = buildProposalPublicationArtifact({
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
            const publishResponse = await publishIpfsContent({
                config,
                json: artifact,
                filename: buildProposalPublicationFilename({
                    requestId: nextRecord.requestId,
                    signer: nextRecord.signer,
                }),
                pin: false,
            });
            nextRecord = await store.saveRecord({
                ...nextRecord,
                artifact,
                publishedAtMs,
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

            if (!(req.method === 'POST' && url.pathname === '/v1/proposals/publish')) {
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
                body = await readJsonBody(req, { maxBytes: config.proposalPublishApiMaxBodyBytes });
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

            const validation = validateProposalPublishBody(body);
            if (!validation.ok) {
                emitLog(
                    'warn',
                    `[oya-node] Proposal publish API rejected request${formatRequestContext({
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
                    `[oya-node] Proposal publish API rejected request${formatRequestContext({
                        body,
                        code: 'missing_bearer_token',
                        statusCode: 401,
                    })}: Bearer token is required.`
                );
                sendJson(
                    res,
                    401,
                    { error: 'Bearer token is required.' },
                    { 'WWW-Authenticate': 'Bearer realm="oya-proposal-publish-api"' }
                );
                return;
            }

            const signedAuth = await authenticateSignedRequest({
                body,
                signerAllowlist,
                requireSignerAllowlist,
                signatureMaxAgeSeconds,
                expectedChainId,
                nowMs,
                allowExpired: true,
                buildPayload: ({ declaredAddress }) =>
                    buildSignedProposalPayload({
                        address: declaredAddress,
                        chainId: body.chainId,
                        timestampMs: body.auth.timestampMs,
                        requestId: body.requestId,
                        commitmentSafe: body.commitmentSafe,
                        ogModule: body.ogModule,
                        transactions: body.transactions,
                        explanation: body.explanation,
                        metadata: body.metadata,
                        deadline: body.deadline,
                    }),
            });
            if (!signedAuth?.ok) {
                emitLog(
                    'warn',
                    `[oya-node] Proposal publish API rejected request${formatRequestContext({
                        body,
                        signer: body?.auth?.address,
                        code: 'signed_auth_failed',
                        statusCode: signedAuth?.statusCode ?? 401,
                    })}: ${signedAuth?.message ?? 'Unauthorized.'}`
                );
                const extraHeaders =
                    keyEntries.length > 0
                        ? { 'WWW-Authenticate': 'Bearer realm="oya-proposal-publish-api"' }
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

            const envelope = buildSignedProposalEnvelope({
                address: signedAuth.sender.address,
                chainId: body.chainId,
                timestampMs: signedAuth.sender.signedAtMs,
                requestId: body.requestId,
                commitmentSafe: body.commitmentSafe,
                ogModule: body.ogModule,
                transactions: body.transactions,
                explanation: body.explanation,
                metadata: body.metadata,
                deadline: body.deadline,
            });
            const signerAllowlistMode = requireSignerAllowlist ? 'explicit' : 'open';
            const existingRecord = await store.getRecord({
                signer: signedAuth.sender.address,
                chainId: body.chainId,
                requestId: body.requestId,
            });
            const exactExistingMatch =
                existingRecord?.signature === signedAuth.sender.signature &&
                existingRecord?.canonicalMessage === signedAuth.payload;
            const refreshablePendingRecord =
                !exactExistingMatch &&
                canRefreshPendingRecord({
                    existingRecord,
                    envelope,
                });

            if (signedAuth.isExpired && !exactExistingMatch && !refreshablePendingRecord) {
                emitLog(
                    'warn',
                    `[oya-node] Proposal publish API rejected request${formatRequestContext({
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
                            ? { 'WWW-Authenticate': 'Bearer realm="oya-proposal-publish-api"' }
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

            let prepared;
            if (exactExistingMatch) {
                prepared = {
                    status: 'existing',
                    record: existingRecord,
                };
            } else if (refreshablePendingRecord) {
                prepared = {
                    status: 'existing',
                    record: await store.saveRecord({
                        ...existingRecord,
                        signature: signedAuth.sender.signature,
                        canonicalMessage: signedAuth.payload,
                        publishedAtMs: null,
                        artifact: null,
                        cid: null,
                        uri: null,
                        pinned: false,
                        publishResult: null,
                        pinResult: null,
                        lastError: null,
                    }),
                };
            } else {
                prepared = await store.prepareRecord({
                    signer: signedAuth.sender.address,
                    chainId: body.chainId,
                    requestId: body.requestId,
                    signature: signedAuth.sender.signature,
                    canonicalMessage: signedAuth.payload,
                    artifact: null,
                    receivedAtMs: nowMs,
                    publishedAtMs: null,
                });
            }

            if (prepared.status === 'conflict') {
                emitLog(
                    'warn',
                    `[oya-node] Proposal publish API rejected request${formatRequestContext({
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
            let wasAlreadyPinned = false;
            try {
                const publicationKey = buildPublicationKey({
                    signer: signedAuth.sender.address,
                    chainId: body.chainId,
                    requestId: body.requestId,
                });
                ({ record, wasAlreadyPinned } = await enqueuePublicationOperation(
                    publishOperationTails,
                    publicationKey,
                    async () => {
                        const latestRecord = await store.getRecord({
                            signer: signedAuth.sender.address,
                            chainId: body.chainId,
                            requestId: body.requestId,
                        });
                        if (!latestRecord) {
                            throw new Error('Publication record disappeared before publish.');
                        }

                        const latestWasAlreadyPinned =
                            Boolean(latestRecord.cid) && Boolean(latestRecord.pinned);
                        const nextRecord = latestWasAlreadyPinned
                            ? latestRecord
                            : await publishRecord(latestRecord, {
                                  signerAllowlistMode,
                                  nodeName: config.proposalPublishApiNodeName,
                              });
                        return {
                            record: nextRecord,
                            wasAlreadyPinned: latestWasAlreadyPinned,
                        };
                    }
                ));
            } catch (error) {
                const latestRecord = await store.getRecord({
                    signer: signedAuth.sender.address,
                    chainId: body.chainId,
                    requestId: body.requestId,
                });
                if (latestRecord) {
                    record = latestRecord;
                }
                const code = record?.cid ? 'pin_failed' : 'publish_failed';
                if (record) {
                    record = await store.saveRecord({
                        ...record,
                        lastError: {
                            code,
                            message: error?.message ?? String(error),
                            atMs: Date.now(),
                        },
                    });
                }
                emitLog(
                    'warn',
                    `[oya-node] Proposal publish API failed${formatRequestContext({
                        body,
                        signer: signedAuth.sender.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code,
                        statusCode: 502,
                    })}: ${error?.message ?? error}`
                );
                sendJson(res, 502, {
                    error: error?.message ?? 'Proposal publication failed.',
                    code,
                    cid: record?.cid ?? null,
                    uri: record?.uri ?? null,
                    pinned: Boolean(record?.pinned),
                    publishedAtMs: record?.publishedAtMs ?? null,
                });
                return;
            }

            const status = wasAlreadyPinned ? 'duplicate' : 'published';
            sendJson(res, wasAlreadyPinned ? 200 : 202, {
                status,
                requestId: record.requestId,
                signer: record.signer,
                cid: record.cid,
                uri: record.uri,
                pinned: record.pinned,
                receivedAtMs: record.receivedAtMs,
                publishedAtMs: record.publishedAtMs,
            });
        });

        try {
            await new Promise((resolve, reject) => {
                nextServer.once('error', reject);
                nextServer.listen(config.proposalPublishApiPort, config.proposalPublishApiHost, () => {
                    nextServer.off('error', reject);
                    resolve();
                });
            });
        } catch (error) {
            nextServer.removeAllListeners();
            throw error;
        }

        server = nextServer;
        const address = server.address();
        const boundPort =
            address && typeof address === 'object' && typeof address.port === 'number'
                ? address.port
                : config.proposalPublishApiPort;
        emitLog(
            'info',
            `[oya-node] Proposal publish API listening on http://${config.proposalPublishApiHost}:${boundPort}`
        );
        return server;
    }

    async function stop() {
        if (!server) {
            return;
        }
        const current = server;
        server = undefined;
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

export { createProposalPublicationApiServer };
