import { getAddress } from 'viem';

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
    mustGetEnv,
    normalizePrivateKey,
    parseAddressList,
    parseToolArguments,
    summarizeViemError,
};
