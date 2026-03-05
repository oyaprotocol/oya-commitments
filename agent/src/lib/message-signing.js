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

function normalizeSignatureDomain(domain) {
    if (typeof domain !== 'string') {
        throw new Error('signature domain must be a string.');
    }
    const trimmed = domain.trim();
    if (!trimmed) {
        throw new Error('signature domain must be non-empty.');
    }
    return trimmed;
}

function buildDefaultMessageSignatureDomain({ commitmentSafe, ogModule }) {
    const normalizedSafe = getAddress(commitmentSafe).toLowerCase();
    const normalizedOgModule = getAddress(ogModule).toLowerCase();
    // Scope signatures to the concrete commitment deployment by default.
    return `oya-agent:${normalizedSafe}:${normalizedOgModule}`;
}

function buildSignedMessagePayload({
    domain,
    address,
    timestampMs,
    text,
    command,
    args,
    metadata,
    idempotencyKey,
    ttlSeconds,
}) {
    const normalizedDomain = normalizeSignatureDomain(domain);
    const normalizedAddress = getAddress(address).toLowerCase();
    const normalizedTimestamp = Number(timestampMs);
    if (!Number.isInteger(normalizedTimestamp)) {
        throw new Error('timestampMs must be an integer.');
    }

    const canonical = canonicalize({
        version: 'oya-agent-message-v1',
        domain: normalizedDomain,
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

export { buildDefaultMessageSignatureDomain, buildSignedMessagePayload, normalizeSignatureDomain };
