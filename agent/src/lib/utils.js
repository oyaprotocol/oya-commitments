import { decodeFunctionData, erc20Abi, getAddress } from 'viem';

function mustGetEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env var ${key}`);
    }
    return value;
}

function normalizePrivateKey(value) {
    if (!value) return value;
    return value.startsWith('0x') ? value : `0x${value}`;
}

function parseAddressList(list) {
    if (!list) return [];
    return list
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(getAddress);
}

function summarizeViemError(error) {
    if (!error) return null;

    return {
        name: error.name,
        shortMessage: error.shortMessage,
        message: error.message,
        details: error.details,
        metaMessages: error.metaMessages,
        data: error.data ?? error.cause?.data,
        cause: error.cause?.shortMessage ?? error.cause?.message ?? error.cause,
    };
}

function normalizeAddressOrNull(value, { trim = true, requireHex = true } = {}) {
    if (typeof value !== 'string') return null;
    const candidate = trim ? value.trim() : value;
    if (candidate.length !== 42 || !candidate.startsWith('0x')) return null;
    if (requireHex && !/^0x[0-9a-fA-F]{40}$/.test(candidate)) return null;
    return candidate.toLowerCase();
}

function normalizeAddressOrThrow(value, options = {}) {
    const normalized = normalizeAddressOrNull(value, { trim: false, ...options });
    if (!normalized) {
        throw new Error(`Invalid address: ${value}`);
    }
    return normalized;
}

function normalizeHashOrNull(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

function normalizeTokenId(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
        const normalized = BigInt(value);
        if (normalized < 0n) return null;
        return normalized.toString();
    } catch (error) {
        return null;
    }
}

function parseFiniteNumber(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

function decodeErc20TransferCallData(data) {
    if (typeof data !== 'string') return null;

    try {
        const decoded = decodeFunctionData({
            abi: erc20Abi,
            data,
        });
        if (decoded.functionName !== 'transfer') return null;

        const to = normalizeAddressOrNull(decoded.args?.[0], { trim: false });
        if (!to) return null;
        const amount = BigInt(decoded.args?.[1] ?? 0n);
        if (amount < 0n) return null;
        return { to, amount };
    } catch (error) {
        return null;
    }
}

function parseToolArguments(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }
    return null;
}

export {
    decodeErc20TransferCallData,
    mustGetEnv,
    normalizeAddressOrNull,
    normalizeAddressOrThrow,
    normalizeHashOrNull,
    normalizeTokenId,
    normalizePrivateKey,
    parseFiniteNumber,
    parseAddressList,
    parseToolArguments,
    summarizeViemError,
};
