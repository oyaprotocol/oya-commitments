import http from 'node:http';
import { getAddress } from 'viem';
import { buildSignedMessagePayload } from './message-signing.js';
import { isPlainObject } from './canonical-json.js';
import { readJsonBody, sendJson } from './http-api.js';
import {
    authenticateBearerRequest,
    authenticateSignedRequest,
    buildBearerKeyEntries,
} from './signed-request-auth.js';

function validateMessageBody(body) {
    if (!isPlainObject(body)) {
        return { ok: false, message: 'Request body must be a JSON object.' };
    }

    const allowedFields = new Set([
        'text',
        'chainId',
        'command',
        'args',
        'metadata',
        'requestId',
        'deadline',
        'auth',
    ]);
    for (const field of Object.keys(body)) {
        if (!allowedFields.has(field)) {
            return { ok: false, message: `Unsupported field: ${field}` };
        }
    }

    if (typeof body.text !== 'string') {
        return { ok: false, message: 'text is required and must be a string.' };
    }
    if (body.chainId !== undefined && (!Number.isInteger(body.chainId) || body.chainId < 1)) {
        return { ok: false, message: 'chainId must be a positive integer when provided.' };
    }
    if (body.command !== undefined && typeof body.command !== 'string') {
        return { ok: false, message: 'command must be a string when provided.' };
    }
    if (body.args !== undefined && !isPlainObject(body.args)) {
        return { ok: false, message: 'args must be an object when provided.' };
    }
    if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
        return { ok: false, message: 'metadata must be an object when provided.' };
    }
    if (body.requestId !== undefined && typeof body.requestId !== 'string') {
        return { ok: false, message: 'requestId must be a string when provided.' };
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

function createMessageApiServer({ config, inbox, logger = console } = {}) {
    if (!config) {
        throw new Error('createMessageApiServer requires config.');
    }
    if (!inbox) {
        throw new Error('createMessageApiServer requires inbox.');
    }

    const keyEntries = buildBearerKeyEntries(config.messageApiKeys ?? {});
    const signerAllowlist = new Set(
        (config.messageApiSignerAllowlist ?? []).map((address) => getAddress(address).toLowerCase())
    );
    const requireSignerAllowlist = config.messageApiRequireSignerAllowlist !== false;
    const signatureMaxAgeSeconds = Number(config.messageApiSignatureMaxAgeSeconds ?? 300);
    const expectedChainId =
        config.chainId === undefined || config.chainId === null
            ? undefined
            : Number(config.chainId);
    if (requireSignerAllowlist && signerAllowlist.size === 0) {
        throw new Error(
            'Message API requires messageApi.signerAllowlist when messageApi.requireSignerAllowlist=true. MESSAGE_API_KEYS_JSON is optional additional bearer gating.'
        );
    }

    let server;

    function emitLog(level, message) {
        const method =
            typeof logger?.[level] === 'function'
                ? logger[level].bind(logger)
                : typeof logger?.log === 'function'
                    ? logger.log.bind(logger)
                    : console.log.bind(console);
        method(message);
    }

    function formatRequestContext({ body, senderAddress, senderKeyId, code, statusCode }) {
        const parts = [];
        if (code) parts.push(`code=${code}`);
        if (statusCode !== undefined) parts.push(`status=${statusCode}`);
        const requestId =
            typeof body?.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : null;
        if (requestId) parts.push(`requestId=${requestId}`);
        const command =
            typeof body?.command === 'string' && body.command.trim() ? body.command.trim() : null;
        if (command) parts.push(`command=${command}`);
        const signer =
            typeof senderAddress === 'string' && senderAddress.trim()
                ? senderAddress.trim()
                : typeof body?.auth?.address === 'string' && body.auth.address.trim()
                    ? body.auth.address.trim()
                    : null;
        if (signer) parts.push(`signer=${signer}`);
        if (senderKeyId) parts.push(`senderKeyId=${senderKeyId}`);
        return parts.length > 0 ? ` (${parts.join(' ')})` : '';
    }

    async function start() {
        if (server) {
            return server;
        }

        // Keep the candidate server local until listen succeeds so failed binds
        // do not leave behind stale state that blocks retry-based startup loops.
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

            if (!(req.method === 'POST' && url.pathname === '/v1/messages')) {
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
                body = await readJsonBody(req, { maxBytes: config.messageApiMaxBodyBytes });
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

            const validation = validateMessageBody(body);
            if (!validation.ok) {
                emitLog(
                    'warn',
                    `[agent] Message API rejected request${formatRequestContext({
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
                    `[agent] Message API rejected request${formatRequestContext({
                        body,
                        code: 'missing_bearer_token',
                        statusCode: 401,
                    })}: Bearer token is required.`
                );
                sendJson(
                    res,
                    401,
                    { error: 'Bearer token is required.' },
                    { 'WWW-Authenticate': 'Bearer realm="agent-message-api"' }
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
                buildPayload: ({ declaredAddress }) =>
                    buildSignedMessagePayload({
                        address: declaredAddress,
                        chainId: body.chainId,
                        timestampMs: body.auth.timestampMs,
                        text: body.text,
                        command: body.command,
                        args: body.args,
                        metadata: body.metadata,
                        requestId: body.requestId,
                        deadline: body.deadline,
                    }),
            });
            if (!signedAuth?.ok) {
                emitLog(
                    'warn',
                    `[agent] Message API rejected request${formatRequestContext({
                        body,
                        senderAddress: body?.auth?.address,
                        code: 'signed_auth_failed',
                        statusCode: signedAuth?.statusCode ?? 401,
                    })}: ${signedAuth?.message ?? 'Unauthorized.'}`
                );
                const extraHeaders =
                    keyEntries.length > 0
                        ? { 'WWW-Authenticate': 'Bearer realm="agent-message-api"' }
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

            const result = inbox.submitMessage({
                text: body.text,
                chainId: body.chainId,
                command: body.command,
                args: body.args,
                metadata: body.metadata,
                requestId: body.requestId,
                deadline: body.deadline,
                senderKeyId: signedAuth.senderKeyId,
                sender: signedAuth.sender,
                nowMs,
            });

            if (!result.ok) {
                // Propagate inbox backpressure/rate-limit outcomes with HTTP-compatible semantics.
                if (result.code === 'rate_limited') {
                    emitLog(
                        'warn',
                        `[agent] Message API rejected request${formatRequestContext({
                            body,
                            senderAddress: signedAuth.sender?.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code: result.code,
                            statusCode: 429,
                        })}: ${result.message}`
                    );
                    sendJson(
                        res,
                        429,
                        {
                            error: result.message,
                            code: result.code,
                            retryAfterSeconds: result.retryAfterSeconds,
                            queueDepth: result.queueDepth,
                        },
                        { 'Retry-After': String(result.retryAfterSeconds ?? 1) }
                    );
                    return;
                }
                if (result.code === 'queue_full') {
                    emitLog(
                        'warn',
                        `[agent] Message API rejected request${formatRequestContext({
                            body,
                            senderAddress: signedAuth.sender?.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code: result.code,
                            statusCode: 429,
                        })}: ${result.message}`
                    );
                    sendJson(res, 429, {
                        error: result.message,
                        code: result.code,
                        queueDepth: result.queueDepth,
                    });
                    return;
                }
                if (result.code === 'request_replay_blocked') {
                    emitLog(
                        'warn',
                        `[agent] Message API rejected request${formatRequestContext({
                            body,
                            senderAddress: signedAuth.sender?.address,
                            senderKeyId: signedAuth.senderKeyId,
                            code: result.code,
                            statusCode: 409,
                        })}: ${result.message}`
                    );
                    sendJson(res, 409, {
                        error: result.message,
                        code: result.code,
                        messageId: result.messageId,
                        replayLockedUntilMs: result.replayLockedUntilMs,
                        queueDepth: result.queueDepth,
                    });
                    return;
                }
                emitLog(
                    'warn',
                    `[agent] Message API rejected request${formatRequestContext({
                        body,
                        senderAddress: signedAuth.sender?.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code: result.code ?? 'invalid_request',
                        statusCode: 400,
                    })}: ${result.message ?? 'Invalid request.'}`
                );
                sendJson(res, 400, {
                    error: result.message ?? 'Invalid request.',
                    code: result.code ?? 'invalid_request',
                });
                return;
            }

            if (result.status === 'duplicate') {
                emitLog(
                    'warn',
                    `[agent] Message API ignored duplicate request${formatRequestContext({
                        body,
                        senderAddress: signedAuth.sender?.address,
                        senderKeyId: signedAuth.senderKeyId,
                        code: 'duplicate',
                        statusCode: 200,
                    })}: reusing existing queued message ${result.message.messageId}.`
                );
            }

            sendJson(res, result.status === 'duplicate' ? 200 : 202, {
                messageId: result.message.messageId,
                status: result.status,
                expiresAtMs: result.message.expiresAtMs,
                queueDepth: result.queueDepth,
            });
        });

        try {
            await new Promise((resolve, reject) => {
                nextServer.once('error', reject);
                nextServer.listen(config.messageApiPort, config.messageApiHost, () => {
                    nextServer.off('error', reject);
                    resolve();
                });
            });
        } catch (error) {
            // Ensure callers can retry start() after EADDRINUSE and similar bind errors.
            nextServer.removeAllListeners();
            throw error;
        }

        server = nextServer;

        const address = server.address();
        const boundPort =
            address && typeof address === 'object' && typeof address.port === 'number'
                ? address.port
                : config.messageApiPort;
        logger.log(
            `[agent] Message API listening on http://${config.messageApiHost}:${boundPort}`
        );
        return server;
    }

    async function stop() {
        if (!server) return;
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        server = undefined;
    }

    return {
        start,
        stop,
    };
}

export { createMessageApiServer };
