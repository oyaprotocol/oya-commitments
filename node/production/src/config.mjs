import { parseBatch } from './batch-logging.mjs';
import { readFile } from 'node:fs/promises';
import { createSignedMessageAuthorizer } from '@oyaprotocol/messages';
import { createHttpConfig } from '@oyaprotocol/ethereum';
import { createIpfsConfig } from '@oyaprotocol/ipfs';
import { getAddress } from 'ethers';
import { SEPOLIA_DEFAULTS } from './defaults.mjs';

function integer(value, name, fallback, max = 2_147_483_647) {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
        throw new Error(`${name} must be a positive integer no greater than ${max}.`);
    }
    return selected;
}

function endpoint(value, name) {
    try {
        if (typeof value !== 'string') throw new Error();
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        return url.href;
    } catch {
        throw new Error(`${name} must be an HTTP or HTTPS URL.`);
    }
}

export function parseConfig(input, { env = process.env } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
    const mode = input.mode === undefined ? 'ledger' : input.mode;
    if (!['ledger', 'ipfs'].includes(mode)) throw new Error('mode must be ledger or ipfs.');
    const fields = new Set(['mode', 'host', 'port', 'chainId', 'ledgerContract', 'allowedSigners', 'rpcUrl', 'ipfsUrl',
        'maxBodyBytes', 'maxTextBytes', 'bodyTimeoutMs', 'receiptTimeoutMs', 'pollIntervalMs',
        'operationTimeoutMs', 'gasLimit', 'maxFeePerGasWei', 'maxMessageRequestsPerMinute', 'batchLogging']);
    for (const key of Object.keys(input)) {
        if (!fields.has(key)) throw new Error('Config contains an unsupported field.');
    }
    const ledgerFields = ['chainId', 'ledgerContract', 'rpcUrl', 'receiptTimeoutMs', 'pollIntervalMs', 'gasLimit', 'maxFeePerGasWei'];
    if (mode === 'ipfs' && ledgerFields.some(key => Object.hasOwn(input, key))) {
        throw new Error('IPFS mode does not accept Ethereum or Ledger settings.');
    }
    let chainId, ledgerContract, rpcUrl;
    if (mode === 'ledger') {
        chainId = integer(input.chainId === undefined ? SEPOLIA_DEFAULTS.chainId : input.chainId,
            'chainId', undefined, Number.MAX_SAFE_INTEGER);
        // Scope target defaults to Sepolia.
        const defaults = chainId === SEPOLIA_DEFAULTS.chainId ? SEPOLIA_DEFAULTS : {};
        ledgerContract = input.ledgerContract === undefined ? defaults.ledgerContract : input.ledgerContract;
        rpcUrl = input.rpcUrl === undefined ? defaults.rpcUrl : input.rpcUrl;
        if (input.rpcUrl === undefined && env.OYA_RPC_AUTHORIZATION) {
            throw new Error('rpcUrl must be explicit when RPC authorization is configured.');
        }
        try {
            if (typeof ledgerContract !== 'string' || ledgerContract.length !== 42 ||
                !/^0x[0-9a-fA-F]{40}$/.test(ledgerContract) || /^0x0{40}$/i.test(ledgerContract)) throw new Error();
            getAddress(ledgerContract); // Validate mixed-case checksums.
        } catch {
            throw new Error('ledgerContract must be a nonzero Ethereum address with a valid checksum.');
        }
    }
    const authorize = createSignedMessageAuthorizer(input.allowedSigners);
    if (input.allowedSigners.length === 0) throw new Error('allowedSigners must not be empty.');
    if (input.host !== undefined && (typeof input.host !== 'string' || !input.host.trim())) {
        throw new Error('host must be a nonempty string.');
    }
    if (input.maxFeePerGasWei !== undefined && (typeof input.maxFeePerGasWei !== 'string' ||
        !/^[1-9][0-9]{0,77}$/.test(input.maxFeePerGasWei))) {
        throw new Error('maxFeePerGasWei must be a positive decimal string.');
    }
    const transport = (url, authorization) => ({
        url, headers: authorization ? { authorization } : {}, timeoutMs: 10_000,
        maxRetries: 2, retryDelayMs: 250,
    });
    return Object.freeze({
        batchLogging: parseBatch(input.batchLogging, mode),
        mode, host: input.host ?? '127.0.0.1', port: integer(input.port, 'port', 8787, 65535), authorize,
        maxMessageRequestsPerMinute: integer(input.maxMessageRequestsPerMinute, 'maxMessageRequestsPerMinute', 60),
        maxBodyBytes: integer(input.maxBodyBytes, 'maxBodyBytes', 16_384, 1_048_576),
        maxTextBytes: integer(input.maxTextBytes, 'maxTextBytes', 8192, 1_048_576),
        bodyTimeoutMs: integer(input.bodyTimeoutMs, 'bodyTimeoutMs', 10_000),
        operationTimeoutMs: integer(input.operationTimeoutMs, 'operationTimeoutMs', 180_000),
        ipfs: createIpfsConfig(transport(endpoint(input.ipfsUrl, 'ipfsUrl'), env.OYA_IPFS_AUTHORIZATION)),
        ...(mode === 'ledger' ? {
            chainId, ledgerContract,
            receiptTimeoutMs: integer(input.receiptTimeoutMs, 'receiptTimeoutMs', 60_000),
            pollIntervalMs: integer(input.pollIntervalMs, 'pollIntervalMs', 1000),
            limits: {
                gasLimit: BigInt(integer(input.gasLimit, 'gasLimit', 200_000)),
                feePerGas: BigInt(input.maxFeePerGasWei ?? '30000000000'),
            },
            rpc: createHttpConfig(transport(endpoint(rpcUrl, 'rpcUrl'), env.OYA_RPC_AUTHORIZATION)),
        } : {}),
    });
}

export async function loadConfig(path, env = process.env) {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')), { env });
}
