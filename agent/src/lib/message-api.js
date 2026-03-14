import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getAddress, recoverMessageAddress } from 'viem';
import { buildSignedMessagePayload } from './message-signing.js';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeTokenEquals(leftRaw, rightRaw) {
    // Constant-time equality avoids leaking token prefix matches.
    const left = Buffer.from(String(leftRaw));
    const right = Buffer.from(String(rightRaw));
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function authenticateRequest({ authorizationHeader, keyEntries }) {
    if (typeof authorizationHeader !== 'string') return null;
    const [scheme, ...tokenParts] = authorizationHeader.trim().split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
    const token = tokenParts.join(' ').trim();
    if (!token) return null;

    let matchedKeyId = null;
    for (const entry of keyEntries) {
        if (safeTokenEquals(token, entry.token)) {
            matchedKeyId = matchedKeyId ?? entry.keyId;
        }
    }
    return matchedKeyId;
}

async function authenticateSignedRequest({
    body,
    signerAllowlist,
    signatureMaxAgeSeconds,
    nowMs,
}) {
    if (!body?.auth) {
        return {
            ok: false,
            statusCode: 401,
            message: 'Signed auth is required.',
        };
    }
    if (!isPlainObject(body.auth)) {
        return { ok: false, statusCode: 400, message: 'auth must be an object when provided.' };
    }

    const auth = body.auth;
    if (auth.type !== 'eip191') {
        return { ok: false, statusCode: 400, message: 'auth.type must be "eip191".' };
    }
    if (typeof auth.address !== 'string') {
        return { ok: false, statusCode: 400, message: 'auth.address must be a string.' };
    }
    if (typeof auth.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(auth.signature)) {
        return { ok: false, statusCode: 400, message: 'auth.signature must be a 65-byte hex string.' };
    }
    if (!Number.isInteger(auth.timestampMs)) {
        return { ok: false, statusCode: 400, message: 'auth.timestampMs must be an integer.' };
    }
    if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
        return {
            ok: false,
            statusCode: 400,
            message: 'requestId is required when using signed auth.',
        };
    }

    let declaredAddress;
    try {
        declaredAddress = getAddress(auth.address);
    } catch (error) {
        return { ok: false, statusCode: 400, message: 'auth.address must be a valid EVM address.' };
    }
    const normalizedDeclared = declaredAddress.toLowerCase();
    if (!signerAllowlist.has(normalizedDeclared)) {
        return { ok: false, statusCode: 401, message: 'Signer is not allowlisted.' };
    }

    const maxAgeMs = signatureMaxAgeSeconds * 1000;
    const maxFutureSkewMs = 30_000;
    const ageMs = nowMs - auth.timestampMs;
    if (ageMs < -maxFutureSkewMs || ageMs > maxAgeMs) {
        return {
            ok: false,
            statusCode: 401,
            message: 'Signed request expired or has an invalid timestamp.',
        };
    }

    const payload = buildSignedMessagePayload({
        address: declaredAddress,
        timestampMs: auth.timestampMs,
        text: body.text,
        command: body.command,
        args: body.args,
        metadata: body.metadata,
        requestId: body.requestId,
        deadline: body.deadline,
    });

    let recoveredAddress;
    try {
        recoveredAddress = getAddress(
            await recoverMessageAddress({
                message: payload,
                signature: auth.signature,
            })
        );
    } catch (error) {
        return { ok: false, statusCode: 401, message: 'Invalid message signature.' };
    }

    if (recoveredAddress.toLowerCase() !== normalizedDeclared) {
        return { ok: false, statusCode: 401, message: 'Signature does not match auth.address.' };
    }

    return {
        ok: true,
        senderKeyId: `addr:${normalizedDeclared}`,
        sender: {
            authType: 'eip191',
            address: declaredAddress,
            signedAtMs: auth.timestampMs,
            signature: auth.signature,
        },
    };
}

async function readJsonBody(req, { maxBytes }) {
    const chunks = [];
    let total = 0;

    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
            error.code = 'body_too_large';
            throw error;
        }
        chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        const parseError = new Error('Malformed JSON body.');
        parseError.code = 'invalid_json';
        throw parseError;
    }
}

function validateMessageBody(body) {
    if (!isPlainObject(body)) {
        return { ok: false, message: 'Request body must be a JSON object.' };
    }

    const allowedFields = new Set([
        'text',
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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
}

function createMessageApiServer({ config, inbox, logger = console } = {}) {
    if (!config) {
        throw new Error('createMessageApiServer requires config.');
    }
    if (!inbox) {
        throw new Error('createMessageApiServer requires inbox.');
    }

    const keyEntries = Object.entries(config.messageApiKeys ?? {}).map(([keyId, token]) => ({
        keyId,
        token,
    }));
    const signerAllowlist = new Set(
        (config.messageApiSignerAllowlist ?? []).map((address) => getAddress(address).toLowerCase())
    );
    const signatureMaxAgeSeconds = Number(config.messageApiSignatureMaxAgeSeconds ?? 300);
    if (signerAllowlist.size === 0) {
        throw new Error(
            'Message API requires MESSAGE_API_SIGNER_ALLOWLIST. MESSAGE_API_KEYS_JSON is optional additional bearer gating.'
        );
    }

    let server;

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
                sendJson(res, 400, { error: validation.message });
                return;
            }

            const nowMs = Date.now();
            const bearerKeyId =
                keyEntries.length > 0
                    ? authenticateRequest({
                          authorizationHeader: req.headers.authorization,
                          keyEntries,
                      })
                    : null;
            if (keyEntries.length > 0 && !bearerKeyId) {
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
                signatureMaxAgeSeconds,
                nowMs,
            });
            if (!signedAuth?.ok) {
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
                    sendJson(res, 429, {
                        error: result.message,
                        code: result.code,
                        queueDepth: result.queueDepth,
                    });
                    return;
                }
                if (result.code === 'request_replay_blocked') {
                    sendJson(res, 409, {
                        error: result.message,
                        code: result.code,
                        messageId: result.messageId,
                        replayLockedUntilMs: result.replayLockedUntilMs,
                        queueDepth: result.queueDepth,
                    });
                    return;
                }
                sendJson(res, 400, {
                    error: result.message ?? 'Invalid request.',
                    code: result.code ?? 'invalid_request',
                });
                return;
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
