import { randomUUID } from 'node:crypto';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInteger(value, fallback, { min = undefined, max = undefined } = {}) {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`Expected integer value, received: ${value}`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`Expected integer >= ${min}, received: ${parsed}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`Expected integer <= ${max}, received: ${parsed}`);
    }
    return parsed;
}

function createMessageInbox(options = {}) {
    const queueLimit = normalizeInteger(options.queueLimit, 500, { min: 1 });
    const defaultTtlSeconds = normalizeInteger(options.defaultTtlSeconds, 3600, { min: 1 });
    const minTtlSeconds = normalizeInteger(options.minTtlSeconds, 30, { min: 1 });
    const maxTtlSeconds = normalizeInteger(options.maxTtlSeconds, 86400, { min: minTtlSeconds });
    const idempotencyTtlSeconds = normalizeInteger(options.idempotencyTtlSeconds, 86400, {
        min: 1,
    });
    const maxTextLength = normalizeInteger(options.maxTextLength, 2000, { min: 1 });
    const rateLimitPerMinute = normalizeInteger(options.rateLimitPerMinute, 30, { min: 0 });
    const rateLimitBurst = normalizeInteger(options.rateLimitBurst, 10, { min: 0 });
    const staleRateWindowMs = Math.max(idempotencyTtlSeconds * 1000, 60_000);

    const queue = [];
    const inFlight = new Map();
    // senderKeyId -> (idempotencyKey -> cached message metadata)
    const idempotencyCache = new Map();
    const rateLimitState = new Map();

    function pruneExpired(nowMs) {
        // Keep queue/in-flight/idempotency bounded without a background timer.
        if (queue.length > 0) {
            let writeIndex = 0;
            for (const message of queue) {
                if (message.expiresAtMs <= nowMs) continue;
                queue[writeIndex] = message;
                writeIndex += 1;
            }
            queue.length = writeIndex;
        }

        if (inFlight.size > 0) {
            for (const [messageId, message] of inFlight.entries()) {
                if (message.expiresAtMs <= nowMs) {
                    inFlight.delete(messageId);
                }
            }
        }

        if (idempotencyCache.size > 0) {
            for (const [senderKeyId, senderCache] of idempotencyCache.entries()) {
                for (const [idempotencyKey, value] of senderCache.entries()) {
                    if (value.expiresAtMs <= nowMs) {
                        senderCache.delete(idempotencyKey);
                    }
                }
                if (senderCache.size === 0) {
                    idempotencyCache.delete(senderKeyId);
                }
            }
        }

        if (rateLimitState.size > 0) {
            for (const [keyId, state] of rateLimitState.entries()) {
                if (nowMs - state.lastSeenMs > staleRateWindowMs) {
                    rateLimitState.delete(keyId);
                }
            }
        }
    }

    function consumeRateLimit(senderKeyId, nowMs) {
        if (rateLimitPerMinute <= 0 || rateLimitBurst <= 0) {
            return { allowed: true };
        }

        // Simple token-bucket per API key: refill continuously, consume 1 token/request.
        const ratePerMs = rateLimitPerMinute / 60_000;
        const state = rateLimitState.get(senderKeyId) ?? {
            tokens: rateLimitBurst,
            lastRefillMs: nowMs,
            lastSeenMs: nowMs,
        };

        const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
        state.tokens = Math.min(rateLimitBurst, state.tokens + elapsedMs * ratePerMs);
        state.lastRefillMs = nowMs;
        state.lastSeenMs = nowMs;

        if (state.tokens < 1) {
            rateLimitState.set(senderKeyId, state);
            const retryAfterMs = Math.ceil((1 - state.tokens) / ratePerMs);
            return {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            };
        }

        state.tokens -= 1;
        rateLimitState.set(senderKeyId, state);
        return { allowed: true };
    }

    function normalizePayload({
        text,
        command,
        args,
        metadata,
        ttlSeconds,
        idempotencyKey,
        senderKeyId,
        nowMs,
    }) {
        if (typeof senderKeyId !== 'string' || senderKeyId.trim() === '') {
            return { ok: false, code: 'invalid_request', message: 'senderKeyId is required.' };
        }

        if (typeof text !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'text must be a string.' };
        }
        const normalizedText = text.trim();
        if (!normalizedText) {
            return { ok: false, code: 'invalid_request', message: 'text must be non-empty.' };
        }
        if (normalizedText.length > maxTextLength) {
            return {
                ok: false,
                code: 'invalid_request',
                message: `text must be <= ${maxTextLength} characters.`,
            };
        }

        if (command !== undefined && (typeof command !== 'string' || command.trim() === '')) {
            return {
                ok: false,
                code: 'invalid_request',
                message: 'command must be a non-empty string when provided.',
            };
        }

        if (args !== undefined && !isPlainObject(args)) {
            return {
                ok: false,
                code: 'invalid_request',
                message: 'args must be an object when provided.',
            };
        }

        if (metadata !== undefined && !isPlainObject(metadata)) {
            return {
                ok: false,
                code: 'invalid_request',
                message: 'metadata must be an object when provided.',
            };
        }

        const normalizedTtl = ttlSeconds === undefined ? defaultTtlSeconds : Number(ttlSeconds);
        if (!Number.isInteger(normalizedTtl)) {
            return {
                ok: false,
                code: 'invalid_request',
                message: 'ttlSeconds must be an integer.',
            };
        }
        if (normalizedTtl < minTtlSeconds || normalizedTtl > maxTtlSeconds) {
            return {
                ok: false,
                code: 'invalid_request',
                message: `ttlSeconds must be between ${minTtlSeconds} and ${maxTtlSeconds}.`,
            };
        }

        let normalizedIdempotencyKey;
        if (idempotencyKey !== undefined) {
            if (typeof idempotencyKey !== 'string') {
                return {
                    ok: false,
                    code: 'invalid_request',
                    message: 'idempotencyKey must be a string when provided.',
                };
            }
            normalizedIdempotencyKey = idempotencyKey.trim();
            if (!normalizedIdempotencyKey) {
                return {
                    ok: false,
                    code: 'invalid_request',
                    message: 'idempotencyKey cannot be blank.',
                };
            }
            if (normalizedIdempotencyKey.length > 64) {
                return {
                    ok: false,
                    code: 'invalid_request',
                    message: 'idempotencyKey must be <= 64 characters.',
                };
            }
        }

        const messageId = `msg_${randomUUID()}`;
        const receivedAtMs = nowMs;
        const expiresAtMs = nowMs + normalizedTtl * 1000;

        return {
            ok: true,
            message: {
                kind: 'userMessage',
                messageId,
                text: normalizedText,
                command: command === undefined ? undefined : command.trim(),
                args: args === undefined ? undefined : args,
                metadata: metadata === undefined ? undefined : metadata,
                sender: {
                    authType: 'apiKey',
                    keyId: senderKeyId,
                },
                receivedAtMs,
                expiresAtMs,
            },
            idempotencyKey: normalizedIdempotencyKey,
        };
    }

    function submitMessage({
        text,
        command,
        args,
        metadata,
        ttlSeconds,
        idempotencyKey,
        senderKeyId,
        nowMs = Date.now(),
    }) {
        pruneExpired(nowMs);

        const normalized = normalizePayload({
            text,
            command,
            args,
            metadata,
            ttlSeconds,
            idempotencyKey,
            senderKeyId,
            nowMs,
        });
        if (!normalized.ok) {
            return normalized;
        }

        const rateLimitResult = consumeRateLimit(senderKeyId, nowMs);
        if (!rateLimitResult.allowed) {
            return {
                ok: false,
                code: 'rate_limited',
                message: 'Rate limit exceeded.',
                retryAfterSeconds: rateLimitResult.retryAfterSeconds,
                queueDepth: queue.length,
            };
        }

        // Duplicate replays should still consume per-key rate-limit budget so repeated
        // retries cannot bypass MESSAGE_API_RATE_LIMIT_* controls.
        if (normalized.idempotencyKey) {
            const senderCache = idempotencyCache.get(senderKeyId);
            const cached = senderCache?.get(normalized.idempotencyKey);
            if (cached && cached.expiresAtMs > nowMs && cached.message?.expiresAtMs > nowMs) {
                return {
                    ok: true,
                    status: 'duplicate',
                    message: cached.message,
                    queueDepth: queue.length,
                };
            }
            // Preserve idempotency only while the original message remains deliverable.
            if (cached && cached.message?.expiresAtMs <= nowMs) {
                senderCache.delete(normalized.idempotencyKey);
                if (senderCache.size === 0) {
                    idempotencyCache.delete(senderKeyId);
                }
            }
        }

        if (queue.length + inFlight.size >= queueLimit) {
            return {
                ok: false,
                code: 'queue_full',
                message: 'Message queue is full.',
                queueDepth: queue.length,
            };
        }

        queue.push(normalized.message);
        if (normalized.idempotencyKey) {
            let senderCache = idempotencyCache.get(senderKeyId);
            if (!senderCache) {
                senderCache = new Map();
                idempotencyCache.set(senderKeyId, senderCache);
            }
            senderCache.set(normalized.idempotencyKey, {
                message: normalized.message,
                expiresAtMs: nowMs + idempotencyTtlSeconds * 1000,
            });
        }

        return {
            ok: true,
            status: 'queued',
            message: normalized.message,
            queueDepth: queue.length,
        };
    }

    function takeBatch({ maxItems = 1, nowMs = Date.now() } = {}) {
        pruneExpired(nowMs);
        const takeLimit = normalizeInteger(maxItems, 1, { min: 1 });
        const out = [];
        while (out.length < takeLimit && queue.length > 0) {
            const message = queue.shift();
            if (!message) break;
            if (message.expiresAtMs <= nowMs) continue;
            inFlight.set(message.messageId, message);
            out.push(message);
        }
        return out;
    }

    function ackBatch(messageIds = [], nowMs = Date.now()) {
        // Ack removes messages after a loop that completed without a decision-path failure.
        pruneExpired(nowMs);
        for (const messageId of messageIds) {
            if (typeof messageId !== 'string') continue;
            inFlight.delete(messageId);
        }
    }

    function requeueBatch(messageIds = [], nowMs = Date.now()) {
        // Requeue preserves at-least-once delivery semantics on transient runner failures.
        pruneExpired(nowMs);
        const toRequeue = [];
        for (const messageId of messageIds) {
            if (typeof messageId !== 'string') continue;
            const message = inFlight.get(messageId);
            if (!message) continue;
            inFlight.delete(messageId);
            if (message.expiresAtMs <= nowMs) continue;
            toRequeue.push(message);
        }
        if (toRequeue.length > 0) {
            queue.unshift(...toRequeue);
        }
    }

    function getQueueDepth(nowMs = Date.now()) {
        pruneExpired(nowMs);
        return queue.length;
    }

    function getPendingCount(nowMs = Date.now()) {
        pruneExpired(nowMs);
        return queue.length + inFlight.size;
    }

    return {
        submitMessage,
        takeBatch,
        ackBatch,
        requeueBatch,
        getQueueDepth,
        getPendingCount,
    };
}

export { createMessageInbox };
