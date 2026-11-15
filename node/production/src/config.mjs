import { parseBatch } from './batch-logging.mjs';
import { readFile } from 'node:fs/promises';
import { createSignedMessageAuthorizer } from '@oyaprotocol/messages';
import { createHttpConfig } from '@oyaprotocol/ethereum';
import { createIpfsConfig } from '@oyaprotocol/ipfs';
import { getAddress } from 'ethers';
import { SEPOLIA_DEFAULTS } from './defaults.mjs';
import { integer, publicNodeSettings } from './public-settings.mjs';

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
    const { mode, chainId, ledgerContract, operationTimeoutMs } = publicNodeSettings(input);
    let rpcUrl;
    if (mode === 'ledger') {
        const defaults = chainId === SEPOLIA_DEFAULTS.chainId ? SEPOLIA_DEFAULTS : {};
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
        operationTimeoutMs,
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
