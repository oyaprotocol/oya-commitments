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
    chainId,
    timestampMs,
    text,
    command,
    args,
    metadata,
    requestId,
    deadline,
}) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const normalizedTimestamp = Number(timestampMs);
    if (!Number.isInteger(normalizedTimestamp)) {
        throw new Error('timestampMs must be an integer.');
    }
    const normalizedChainId =
        chainId === undefined || chainId === null || chainId === ''
            ? undefined
            : Number(chainId);
    if (normalizedChainId !== undefined) {
        if (!Number.isInteger(normalizedChainId) || normalizedChainId < 1) {
            throw new Error('chainId must be a positive integer when provided.');
        }
    }

    const canonical = canonicalize({
        version: 'oya-agent-message-v1',
        address: normalizedAddress,
        ...(normalizedChainId !== undefined ? { chainId: normalizedChainId } : {}),
        timestampMs: normalizedTimestamp,
        requestId: requestId ?? null,
        text: text ?? null,
        command: command ?? null,
        args: args ?? null,
        metadata: metadata ?? null,
        deadline: deadline ?? null,
    });

    return JSON.stringify(canonical);
}

export { buildSignedMessagePayload };
