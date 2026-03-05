import { getAddress } from 'viem';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalize(value[key]);
        }
        return out;
    }
    return value;
}

function buildSignedMessagePayload({
    address,
    timestampMs,
    text,
    command,
    args,
    metadata,
    idempotencyKey,
    ttlSeconds,
}) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const normalizedTimestamp = Number(timestampMs);
    if (!Number.isInteger(normalizedTimestamp)) {
        throw new Error('timestampMs must be an integer.');
    }

    const canonical = canonicalize({
        version: 'oya-agent-message-v1',
        address: normalizedAddress,
        timestampMs: normalizedTimestamp,
        idempotencyKey: idempotencyKey ?? null,
        text: text ?? null,
        command: command ?? null,
        args: args ?? null,
        metadata: metadata ?? null,
        ttlSeconds: ttlSeconds ?? null,
    });

    return JSON.stringify(canonical);
}

export { buildSignedMessagePayload };
