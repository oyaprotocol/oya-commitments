import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

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
        'idempotencyKey',
        'ttlSeconds',
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
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
        return { ok: false, message: 'idempotencyKey must be a string when provided.' };
    }
    if (body.ttlSeconds !== undefined && !Number.isInteger(body.ttlSeconds)) {
        return { ok: false, message: 'ttlSeconds must be an integer when provided.' };
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
    if (keyEntries.length === 0) {
        throw new Error('MESSAGE_API_KEYS_JSON must include at least one key when enabled.');
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

            // All write paths require a valid Bearer token mapped to a configured key id.
            const keyId = authenticateRequest({
                authorizationHeader: req.headers.authorization,
                keyEntries,
            });
            if (!keyId) {
                sendJson(
                    res,
                    401,
                    { error: 'Unauthorized.' },
                    { 'WWW-Authenticate': 'Bearer realm="agent-message-api"' }
                );
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

            const result = inbox.submitMessage({
                text: body.text,
                command: body.command,
                args: body.args,
                metadata: body.metadata,
                idempotencyKey: body.idempotencyKey,
                ttlSeconds: body.ttlSeconds,
                senderKeyId: keyId,
                nowMs: Date.now(),
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
