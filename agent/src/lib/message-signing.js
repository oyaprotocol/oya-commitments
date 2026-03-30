import { getAddress } from 'viem';
import { stringifyCanonicalJson } from './canonical-json.js';

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
        chainId === undefined || chainId === null ? undefined : Number(chainId);
    if (normalizedChainId !== undefined) {
        if (!Number.isInteger(normalizedChainId) || normalizedChainId < 1) {
            throw new Error('chainId must be a positive integer when provided.');
        }
    }

    const canonical = {
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
    };

    return stringifyCanonicalJson(canonical);
}

export { buildSignedMessagePayload };
