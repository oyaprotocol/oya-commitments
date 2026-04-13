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
import { verifyProposal as verifyProposalCandidate } from './proposal-verification.js';
import { hasCommittedToolSideEffects } from './tool-execution-error.js';
import { postBondAndPropose, resolveProposalHashFromReceipt } from './tx.js';

class ApiResponseError extends Error {
    constructor(message, { statusCode, code, body } = {}) {
        super(message);
        this.name = 'ApiResponseError';
        this.statusCode = statusCode ?? 500;
        this.code = code ?? 'internal_error';
        this.body = body ?? { error: message, code: this.code };
    }
}

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
    return buildSignedProposalEnvelope(parsed);
}

function buildEnvelopeIdentityIgnoringTimestamp(envelope) {
    const normalized = buildSignedProposalEnvelope(envelope);
    const { timestampMs: _ignoredTimestamp, ...rest } = normalized;
    return JSON.stringify(rest);
}

function canRefreshPendingRecord({ existingRecord, envelope }) {
    if (
        !existingRecord ||
        existingRecord.cid !== null ||
        existingRecord.pinned ||
        existingRecord.artifact !== null ||
        existingRecord.publishedAtMs !== null
    ) {
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

function validateProposalRequestBody(body, { allowRulesText = false } = {}) {
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
        ...(allowRulesText ? ['rulesText'] : []),
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
    if (allowRulesText && body.rulesText !== undefined && typeof body.rulesText !== 'string') {
        return { ok: false, message: 'rulesText must be a string when provided.' };
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

function buildSubmissionErrorPayload({
    code,
    message,
    atMs = Date.now(),
}) {
    return {
        code,
        message,
        atMs,
    };
}

function buildSubmissionResponse(submission) {
    return {
        status: submission?.status ?? 'not_started',
        submittedAtMs: submission?.submittedAtMs ?? null,
        transactionHash: submission?.transactionHash ?? null,
        ogProposalHash: submission?.ogProposalHash ?? null,
        sideEffectsLikelyCommitted: Boolean(submission?.sideEffectsLikelyCommitted),
        ...(submission?.result?.skipped
            ? {
                  skipped: true,
                  skipReason: submission.result.skipReason ?? null,
              }
            : {}),
    };
}

function buildVerificationResponse(verification) {
    return verification && isPlainObject(verification) ? verification : null;
}

function canBypassProposalRuntimeForDuplicate(record, exactExistingMatch) {
    if (!exactExistingMatch || !record) {
        return false;
    }

    const submission = record.submission ?? { status: 'not_started' };
    return (
        submission.status === 'resolved' ||
        submission.status === 'uncertain' ||
        (submission.status === 'submitted' && Boolean(submission.transactionHash))
    );
}

function shouldVerifyBeforeSubmissionAttempt(record) {
    const submission = record?.submission ?? { status: 'not_started' };
    if (submission.status === 'resolved') {
        return false;
    }
    if (submission.status === 'submitted' && Boolean(submission.transactionHash)) {
        return false;
    }
    if (
        submission.status === 'uncertain' ||
        (submission.sideEffectsLikelyCommitted && !submission.transactionHash)
    ) {
        return false;
    }
    return true;
}

function canReuseVolatilePublicationState(record, publicationState) {
    return Boolean(
        record &&
            publicationState &&
            publicationState.signature === record.signature &&
            publicationState.canonicalMessage === record.canonicalMessage
    );
}

function hasDurablePendingPublicationArtifact(record) {
    return Boolean(
        record &&
            record.cid === null &&
            record.artifact !== null &&
            Number.isInteger(record.publishedAtMs) &&
            record.publishedAtMs >= 0
    );
}

function createProposalPublicationApiServer({
    config,
    store,
    logger = console,
    resolveProposalRuntime = undefined,
    resolveVerificationRuntime = undefined,
    submitProposal = postBondAndPropose,
    resolveProposalHash = resolveProposalHashFromReceipt,
    verifyProposal = verifyProposalCandidate,
} = {}) {
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
    const apiMode = config.proposalPublishApiMode ?? 'publish';
    const proposalVerificationMode = String(config.proposalVerificationMode ?? 'off')
        .trim()
        .toLowerCase();
    const expectedChainId =
        config.chainId === undefined || config.chainId === null
            ? undefined
            : Number(config.chainId);
    if (requireSignerAllowlist && signerAllowlist.size === 0) {
        throw new Error(
            'Proposal publication API requires proposalPublishApi.signerAllowlist when proposalPublishApi.requireSignerAllowlist=true. PROPOSAL_PUBLISH_API_KEYS_JSON is optional additional bearer gating.'
        );
    }
    if (apiMode === 'propose' && typeof resolveProposalRuntime !== 'function') {
        throw new Error(
            'Proposal publication API in propose mode requires resolveProposalRuntime(chainId).'
        );
    }
    if (!['off', 'advisory', 'enforce'].includes(proposalVerificationMode)) {
        throw new Error('proposalVerificationMode must be one of: off, advisory, enforce.');
    }

    let server;
    const publishOperationTails = new Map();
    const submissionOperationTails = new Map();
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
            'Published proposal artifact could not be persisted to the node store.',
            {
                partialPublicationState: publicationState,
                cause: persistError,
            }
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

        if (!nextRecord.cid) {
            if (!hasDurablePendingPublicationArtifact(nextRecord)) {
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
                nextRecord = await store.saveRecord({
                    ...nextRecord,
                    artifact,
                    publishedAtMs,
                    lastError: null,
                });
            }
            const publishResponse = await publishIpfsContent({
                config,
                json: nextRecord.artifact,
                filename: buildProposalPublicationFilename({
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

    async function saveSubmission(record, patch) {
        return store.saveRecord({
            ...record,
            submission: {
                ...(record.submission ?? {}),
                ...patch,
            },
        });
    }

    async function saveVerification(record, verification) {
        return store.saveRecord({
            ...record,
            verification,
        });
    }

    async function resolveVerificationRuntimeForChain(chainId, proposalRuntime = undefined) {
        if (proposalRuntime) {
            return proposalRuntime;
        }
        if (typeof resolveVerificationRuntime !== 'function') {
            return null;
        }
        return resolveVerificationRuntime({ chainId });
    }

    async function runVerification({
        record = null,
        envelope,
        rulesText = undefined,
        proposalRuntime = undefined,
    }) {
        const verificationRuntime = await resolveVerificationRuntimeForChain(
            envelope.chainId,
            proposalRuntime
        );
        const publicationKey = buildPublicationKey({
            signer: envelope.address,
            chainId: envelope.chainId,
            requestId: envelope.requestId,
        });
        const storeRecords =
            typeof store.listRecords === 'function' ? await store.listRecords() : [];
        const verification = await verifyProposal({
            envelope,
            rulesText,
            publicClient: verificationRuntime?.publicClient,
            storeRecords,
            currentPublicationKey: publicationKey,
        });
        if (record) {
            return {
                record: await saveVerification(record, verification),
                verification,
            };
        }
        return {
            record,
            verification,
        };
    }

    async function reconcileSubmittedRecord(record, { runtime, envelope }) {
        const transactionHash = record.submission?.transactionHash;
        if (!transactionHash || record.submission?.ogProposalHash) {
            return record;
        }

        const ogProposalHash = await resolveProposalHash({
            publicClient: runtime.publicClient,
            proposalTxHash: transactionHash,
            ogModule: envelope.ogModule,
            timeoutMs: runtime.runtimeConfig.proposalHashResolveTimeoutMs,
            pollIntervalMs: runtime.runtimeConfig.proposalHashResolvePollIntervalMs,
        });
        if (!ogProposalHash) {
            return record;
        }

        return saveSubmission(record, {
            status: 'resolved',
            ogProposalHash,
            result: {
                ...(record.submission?.result ?? {}),
                ogProposalHash,
            },
            error: null,
            sideEffectsLikelyCommitted: true,
        });
    }

    async function submitPublishedRecord(record, { runtime, envelope }) {
        const existingSubmission = record.submission ?? { status: 'not_started' };
        const observedSubmission = {
            submittedAtMs: existingSubmission.submittedAtMs ?? null,
            transactionHash: existingSubmission.transactionHash ?? null,
            ogProposalHash: existingSubmission.ogProposalHash ?? null,
            result: existingSubmission.result ?? null,
            sideEffectsLikelyCommitted: Boolean(existingSubmission.sideEffectsLikelyCommitted),
        };
        if (existingSubmission.status === 'resolved') {
            return {
                record,
                submissionAttempted: false,
            };
        }
        if (existingSubmission.status === 'submitted' && existingSubmission.transactionHash) {
            if (!runtime) {
                return {
                    record,
                    submissionAttempted: false,
                };
            }

            try {
                const reconciledRecord = await reconcileSubmittedRecord(record, { runtime, envelope });
                return {
                    record: reconciledRecord,
                    submissionAttempted: false,
                };
            } catch (error) {
                return {
                    record,
                    submissionAttempted: false,
                };
            }
        }
        if (
            existingSubmission.status === 'uncertain' ||
            (existingSubmission.sideEffectsLikelyCommitted &&
                !existingSubmission.transactionHash)
        ) {
            throw new ApiResponseError(
                'Proposal submission is in an uncertain state for this request. Inspect node logs and chain state before retrying.',
                {
                    statusCode: 409,
                    code: 'submission_uncertain',
                    body: {
                        error:
                            'Proposal submission is in an uncertain state for this request. Inspect node logs and chain state before retrying.',
                        code: 'submission_uncertain',
                        submission: buildSubmissionResponse(existingSubmission),
                    },
                }
            );
        }
        if (!runtime) {
            throw new Error('Proposal runtime unavailable for submission attempt.');
        }

        const submittedAtMs = Date.now();
        let latestRecord = record;

        try {
            const result = await submitProposal({
                publicClient: runtime.publicClient,
                walletClient: runtime.walletClient,
                account: runtime.account,
                config: runtime.runtimeConfig,
                ogModule: envelope.ogModule,
                transactions: envelope.transactions,
                explanation: envelope.explanation,
                onProposalTxSubmitted: async (transactionHash) => {
                    observedSubmission.submittedAtMs = submittedAtMs;
                    observedSubmission.transactionHash = transactionHash;
                    observedSubmission.sideEffectsLikelyCommitted = true;
                    latestRecord = await saveSubmission(latestRecord, {
                        status: 'submitted',
                        submittedAtMs,
                        transactionHash,
                        ogProposalHash: null,
                        result: {
                            ...(latestRecord.submission?.result ?? {}),
                            transactionHash,
                        },
                        error: null,
                        sideEffectsLikelyCommitted: true,
                    });
                },
            });

            if (result?.transactionHash) {
                observedSubmission.submittedAtMs = observedSubmission.submittedAtMs ?? submittedAtMs;
                observedSubmission.transactionHash = result.transactionHash;
                observedSubmission.ogProposalHash = result.ogProposalHash ?? null;
                observedSubmission.result = result;
                observedSubmission.sideEffectsLikelyCommitted = true;
                latestRecord = await saveSubmission(latestRecord, {
                    status: result.ogProposalHash ? 'resolved' : 'submitted',
                    submittedAtMs:
                        latestRecord.submission?.submittedAtMs ?? submittedAtMs,
                    transactionHash: result.transactionHash,
                    ogProposalHash: result.ogProposalHash ?? null,
                    result,
                    error: null,
                    sideEffectsLikelyCommitted: true,
                });
                return {
                    record: latestRecord,
                    submissionAttempted: true,
                };
            }

            if (result?.skipped) {
                observedSubmission.result = result;
                observedSubmission.sideEffectsLikelyCommitted = Boolean(
                    result.sideEffectsLikelyCommitted
                );
                latestRecord = await saveSubmission(latestRecord, {
                    status: 'resolved',
                    result,
                    error: null,
                    sideEffectsLikelyCommitted: Boolean(result.sideEffectsLikelyCommitted),
                });
                return {
                    record: latestRecord,
                    submissionAttempted: false,
                };
            }

            const sideEffectsLikelyCommitted = Boolean(result?.sideEffectsLikelyCommitted);
            observedSubmission.result = result ?? null;
            observedSubmission.sideEffectsLikelyCommitted =
                observedSubmission.sideEffectsLikelyCommitted || sideEffectsLikelyCommitted;
            const nextStatus = sideEffectsLikelyCommitted ? 'uncertain' : 'failed';
            latestRecord = await saveSubmission(latestRecord, {
                status: nextStatus,
                result: result ?? null,
                error: buildSubmissionErrorPayload({
                    code:
                        nextStatus === 'uncertain'
                            ? 'submission_uncertain'
                            : 'submission_failed',
                    message:
                        result?.submissionError?.message ??
                        'Proposal submission failed before a transaction hash was obtained.',
                }),
                sideEffectsLikelyCommitted,
            });
            throw new ApiResponseError(
                nextStatus === 'uncertain'
                    ? 'Proposal submission may already have side effects onchain. Automatic retry has been blocked.'
                    : result?.submissionError?.message ??
                          'Proposal submission failed before a transaction hash was obtained.',
                {
                    statusCode: nextStatus === 'uncertain' ? 409 : 502,
                    code:
                        nextStatus === 'uncertain'
                            ? 'submission_uncertain'
                            : 'submission_failed',
                    body: {
                        error:
                            nextStatus === 'uncertain'
                                ? 'Proposal submission may already have side effects onchain. Automatic retry has been blocked.'
                                : result?.submissionError?.message ??
                                  'Proposal submission failed before a transaction hash was obtained.',
                        code:
                            nextStatus === 'uncertain'
                                ? 'submission_uncertain'
                                : 'submission_failed',
                        submission: buildSubmissionResponse(latestRecord.submission),
                    },
                }
            );
        } catch (error) {
            const refreshedRecord = await store.getRecord({
                signer: latestRecord.signer,
                chainId: latestRecord.chainId,
                requestId: latestRecord.requestId,
            });
            if (refreshedRecord) {
                latestRecord = refreshedRecord;
            }
            if (error instanceof ApiResponseError) {
                throw error;
            }

            if (latestRecord.submission?.transactionHash) {
                let reconciledRecord = latestRecord;
                try {
                    reconciledRecord = await reconcileSubmittedRecord(latestRecord, {
                        runtime,
                        envelope,
                    });
                } catch (reconcileError) {
                    emitLog(
                        'warn',
                        `[oya-node] Proposal submission reconciliation failed (requestId=${latestRecord.requestId} signer=${latestRecord.signer} txHash=${latestRecord.submission.transactionHash}): ${reconcileError?.message ?? reconcileError}`
                    );
                }
                return {
                    record: reconciledRecord,
                    submissionAttempted: true,
                };
            }

            const sideEffectsLikelyCommitted =
                Boolean(observedSubmission.transactionHash) ||
                observedSubmission.sideEffectsLikelyCommitted ||
                hasCommittedToolSideEffects(error);
            const nextStatus = sideEffectsLikelyCommitted ? 'uncertain' : 'failed';
            const fallbackSubmission = {
                status: nextStatus,
                ...(observedSubmission.submittedAtMs !== null
                    ? { submittedAtMs: observedSubmission.submittedAtMs }
                    : {}),
                ...(observedSubmission.transactionHash
                    ? { transactionHash: observedSubmission.transactionHash }
                    : {}),
                ...(observedSubmission.ogProposalHash
                    ? { ogProposalHash: observedSubmission.ogProposalHash }
                    : {}),
                result:
                    observedSubmission.result ??
                    (sideEffectsLikelyCommitted ? latestRecord.submission?.result ?? null : null),
                error: buildSubmissionErrorPayload({
                    code:
                        nextStatus === 'uncertain'
                            ? 'submission_uncertain'
                            : 'submission_failed',
                    message: error?.message ?? String(error),
                }),
                sideEffectsLikelyCommitted,
            };
            try {
                latestRecord = await saveSubmission(latestRecord, fallbackSubmission);
            } catch (_persistError) {
                latestRecord = {
                    ...latestRecord,
                    submission: {
                        ...(latestRecord.submission ?? {}),
                        ...fallbackSubmission,
                    },
                };
            }
            throw new ApiResponseError(
                nextStatus === 'uncertain'
                    ? 'Proposal submission may already have side effects onchain. Automatic retry has been blocked.'
                    : error?.message ?? 'Proposal submission failed.',
                {
                    statusCode: nextStatus === 'uncertain' ? 409 : 502,
                    code:
                        nextStatus === 'uncertain'
                            ? 'submission_uncertain'
                            : 'submission_failed',
                    body: {
                        error:
                            nextStatus === 'uncertain'
                                ? 'Proposal submission may already have side effects onchain. Automatic retry has been blocked.'
                                : error?.message ?? 'Proposal submission failed.',
                        code:
                            nextStatus === 'uncertain'
                                ? 'submission_uncertain'
                                : 'submission_failed',
                        submission: buildSubmissionResponse(latestRecord.submission),
                    },
                }
            );
        }
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

            const isPublishRoute =
                req.method === 'POST' && url.pathname === '/v1/proposals/publish';
            const isVerifyRoute =
                req.method === 'POST' && url.pathname === '/v1/proposals/verify';
            if (!(isPublishRoute || isVerifyRoute)) {
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

            const validation = validateProposalRequestBody(body, {
                allowRulesText: isVerifyRoute,
            });
            if (!validation.ok) {
                emitLog(
                    'warn',
                    `[oya-node] Proposal ${isVerifyRoute ? 'verify' : 'publish'} API rejected request${formatRequestContext({
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
            const canBypassProposalRuntime = canBypassProposalRuntimeForDuplicate(
                existingRecord,
                exactExistingMatch
            );

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

            if (isVerifyRoute) {
                let verification;
                try {
                    ({ verification } = await runVerification({
                        record: exactExistingMatch ? existingRecord : null,
                        envelope,
                        rulesText: body.rulesText,
                    }));
                } catch (error) {
                    const statusCode = error?.statusCode ?? 502;
                    const code = error?.code ?? 'verification_failed';
                    emitLog(
                        'warn',
                        `[oya-node] Proposal verify API failed${formatRequestContext({
                            body,
                            signer: signedAuth.sender.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code,
                            statusCode,
                        })}: ${error?.message ?? error}`
                    );
                    sendJson(res, statusCode, {
                        error: error?.message ?? 'Proposal verification failed.',
                        code,
                    });
                    return;
                }

                sendJson(res, 200, verification);
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

            let proposalRuntime;
            if (apiMode === 'propose' && !canBypassProposalRuntime) {
                try {
                    proposalRuntime = await resolveProposalRuntime({
                        chainId: body.chainId,
                    });
                } catch (error) {
                    const statusCode = error?.statusCode ?? 502;
                    const code = error?.code ?? 'proposal_runtime_unavailable';
                    emitLog(
                        'warn',
                        `[oya-node] Proposal publish API rejected request${formatRequestContext({
                            body,
                            signer: signedAuth.sender.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code,
                            statusCode,
                        })}: ${error?.message ?? error}`
                    );
                    sendJson(res, statusCode, {
                        error: error?.message ?? 'Proposal runtime unavailable.',
                        code,
                    });
                    return;
                }
            }

            let record = prepared.record;
            let wasAlreadyPinned = false;
            let submissionAttempted = false;
            const publicationKey = buildPublicationKey({
                signer: signedAuth.sender.address,
                chainId: body.chainId,
                requestId: body.requestId,
            });
            try {
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
                                  publicationKey,
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
                const partialPublicationState =
                    error instanceof PublicationPersistenceError
                        ? error.partialPublicationState
                        : null;
                if (partialPublicationState) {
                    record = {
                        ...(record ?? {}),
                        ...partialPublicationState,
                    };
                }
                const code = partialPublicationState
                    ? 'publish_persist_failed'
                    : record?.cid
                        ? 'pin_failed'
                        : 'publish_failed';
                if (record) {
                    const shouldClearDurablePendingPublication =
                        code === 'publish_failed' && record.cid === null;
                    try {
                        record = await store.saveRecord({
                            ...record,
                            ...(shouldClearDurablePendingPublication
                                ? {
                                      artifact: null,
                                      publishedAtMs: null,
                                  }
                                : {}),
                            lastError: {
                                code,
                                message: error?.message ?? String(error),
                                atMs: Date.now(),
                            },
                        });
                        if (partialPublicationState && record.cid) {
                            volatilePublicationStates.delete(publicationKey);
                        }
                    } catch (_persistError) {
                        record = {
                            ...record,
                            ...(shouldClearDurablePendingPublication
                                ? {
                                      artifact: null,
                                      publishedAtMs: null,
                                  }
                                : {}),
                            lastError: {
                                code,
                                message: error?.message ?? String(error),
                                atMs: Date.now(),
                            },
                        };
                    }
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

            if (apiMode === 'propose') {
                try {
                    const publicationKey = buildPublicationKey({
                        signer: signedAuth.sender.address,
                        chainId: body.chainId,
                        requestId: body.requestId,
                    });
                    ({ record, submissionAttempted } = await enqueuePublicationOperation(
                        submissionOperationTails,
                        publicationKey,
                        async () => {
                            let latestRecord = await store.getRecord({
                                signer: signedAuth.sender.address,
                                chainId: body.chainId,
                                requestId: body.requestId,
                            });
                            if (!latestRecord) {
                                throw new Error(
                                    'Publication record disappeared before proposal submission.'
                                );
                            }
                            let runtime = proposalRuntime;
                            if (
                                !runtime &&
                                latestRecord.submission?.status === 'submitted' &&
                                latestRecord.submission?.transactionHash
                            ) {
                                try {
                                    runtime = await resolveProposalRuntime({
                                        chainId: body.chainId,
                                    });
                                } catch (error) {
                                    runtime = undefined;
                                }
                            }
                            if (
                                proposalVerificationMode !== 'off' &&
                                shouldVerifyBeforeSubmissionAttempt(latestRecord)
                            ) {
                                ({ record: latestRecord } = await runVerification({
                                    record: latestRecord,
                                    envelope,
                                    proposalRuntime: runtime,
                                }));
                                const verification = buildVerificationResponse(
                                    latestRecord.verification
                                );
                                if (
                                    proposalVerificationMode === 'enforce' &&
                                    verification?.status !== 'valid'
                                ) {
                                    const code =
                                        verification?.status === 'invalid'
                                            ? 'verification_invalid'
                                            : 'verification_unknown';
                                    throw new ApiResponseError(
                                        verification?.status === 'invalid'
                                            ? 'Proposal verification failed. The node refused to submit this proposal onchain.'
                                            : 'Proposal verification was inconclusive. The node refused to submit this proposal onchain.',
                                        {
                                            statusCode: 409,
                                            code,
                                            body: {
                                                error:
                                                    verification?.status === 'invalid'
                                                        ? 'Proposal verification failed. The node refused to submit this proposal onchain.'
                                                        : 'Proposal verification was inconclusive. The node refused to submit this proposal onchain.',
                                                code,
                                                verification,
                                            },
                                        }
                                    );
                                }
                            }
                            return submitPublishedRecord(latestRecord, {
                                runtime,
                                envelope,
                            });
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
                    const statusCode = error?.statusCode ?? 502;
                    const code = error?.code ?? 'submission_failed';
                    emitLog(
                        'warn',
                        `[oya-node] Proposal submit API failed${formatRequestContext({
                            body,
                            signer: signedAuth.sender.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code,
                            statusCode,
                        })}: ${error?.message ?? error}`
                    );
                    sendJson(res, statusCode, {
                        status: wasAlreadyPinned ? 'duplicate' : 'published',
                        mode: apiMode,
                        requestId: record?.requestId ?? body.requestId,
                        signer: record?.signer ?? signedAuth.sender.address.toLowerCase(),
                        cid: record?.cid ?? null,
                        uri: record?.uri ?? null,
                        pinned: Boolean(record?.pinned),
                        receivedAtMs: record?.receivedAtMs ?? null,
                        publishedAtMs: record?.publishedAtMs ?? null,
                        error: error?.body?.error ?? error?.message ?? 'Proposal submission failed.',
                        code,
                        verification: buildVerificationResponse(record?.verification),
                        submission: buildSubmissionResponse(record?.submission),
                    });
                    return;
                }
            }

            const status = wasAlreadyPinned && !submissionAttempted ? 'duplicate' : 'published';
            sendJson(res, wasAlreadyPinned && !submissionAttempted ? 200 : 202, {
                status,
                mode: apiMode,
                requestId: record.requestId,
                signer: record.signer,
                cid: record.cid,
                uri: record.uri,
                pinned: record.pinned,
                receivedAtMs: record.receivedAtMs,
                publishedAtMs: record.publishedAtMs,
                verification: buildVerificationResponse(record.verification),
                ...(apiMode === 'propose'
                    ? { submission: buildSubmissionResponse(record.submission) }
                    : {}),
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
            `[oya-node] Proposal publish API (${apiMode}) listening on http://${config.proposalPublishApiHost}:${boundPort}`
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
