import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSignedMessageAuthorizer } from '@oyaprotocol/messages';
import { createHttpConfig } from '@oyaprotocol/ethereum';
import { createIpfsConfig } from '@oyaprotocol/ipfs';

function integer(value, name, fallback, max = 2_147_483_647) {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
        throw new Error(`${name} must be a positive integer no greater than ${max}.`);
    }
    return selected;
}

function endpoint(value, name) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        return url.href;
    } catch {
        throw new Error(`${name} must be an HTTP or HTTPS URL.`);
    }
}

export function parseConfig(input, { baseDir = process.cwd(), env = process.env } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
    const fields = new Set(['host', 'port', 'chainId', 'loggerContract', 'allowedSigners', 'rpcUrl', 'ipfsUrl',
        'stateDir', 'maxBodyBytes', 'maxTextBytes', 'bodyTimeoutMs', 'receiptTimeoutMs', 'pollIntervalMs',
        'gasLimit', 'maxFeePerGasWei']);
    for (const key of Object.keys(input)) {
        if (!fields.has(key)) throw new Error('Config contains an unsupported field.');
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.loggerContract ?? '') || /^0x0{40}$/i.test(input.loggerContract)) {
        throw new Error('loggerContract must be a nonzero Ethereum address.');
    }
    const authorize = createSignedMessageAuthorizer(input.allowedSigners);
    if (input.allowedSigners.length === 0) throw new Error('allowedSigners must not be empty.');
    if (input.host !== undefined && (typeof input.host !== 'string' || !input.host.trim())) {
        throw new Error('host must be a nonempty string.');
    }
    if (typeof input.stateDir !== 'string' || !input.stateDir.trim()) throw new Error('stateDir is required.');
    if (input.maxFeePerGasWei !== undefined && !/^[1-9][0-9]{0,77}$/.test(input.maxFeePerGasWei)) {
        throw new Error('maxFeePerGasWei must be a positive decimal string.');
    }
    const transport = (url, authorization) => ({
        url, headers: authorization ? { authorization } : {}, timeoutMs: 10_000,
        maxRetries: 2, retryDelayMs: 250,
    });
    return Object.freeze({
        host: input.host ?? '127.0.0.1', port: integer(input.port, 'port', 8787, 65535),
        chainId: integer(input.chainId, 'chainId', undefined, Number.MAX_SAFE_INTEGER),
        loggerContract: input.loggerContract, authorize,
        stateDir: resolve(baseDir, input.stateDir),
        maxBodyBytes: integer(input.maxBodyBytes, 'maxBodyBytes', 16_384, 1_048_576),
        maxTextBytes: integer(input.maxTextBytes, 'maxTextBytes', 8192, 1_048_576),
        bodyTimeoutMs: integer(input.bodyTimeoutMs, 'bodyTimeoutMs', 10_000),
        receiptTimeoutMs: integer(input.receiptTimeoutMs, 'receiptTimeoutMs', 60_000),
        pollIntervalMs: integer(input.pollIntervalMs, 'pollIntervalMs', 1000),
        limits: {
            gasLimit: BigInt(integer(input.gasLimit, 'gasLimit', 200_000)),
            feePerGas: BigInt(input.maxFeePerGasWei ?? '30000000000'),
        },
        rpc: createHttpConfig(transport(endpoint(input.rpcUrl, 'rpcUrl'), env.OYA_RPC_AUTHORIZATION)),
        ipfs: createIpfsConfig(transport(endpoint(input.ipfsUrl, 'ipfsUrl'), env.OYA_IPFS_AUTHORIZATION)),
    });
}

export async function loadConfig(path, env = process.env) {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')), { baseDir: dirname(resolve(path)), env });
}
