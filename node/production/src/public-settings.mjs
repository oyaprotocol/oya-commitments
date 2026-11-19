import { SEPOLIA_DEFAULTS } from './defaults.mjs';

export function integer(value, name, fallback, max = 2_147_483_647) {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
        throw new Error(`${name} must be a positive integer no greater than ${max}.`);
    }
    return selected;
}

export function publicAddress(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
        throw new Error('Expected a nonzero public Ethereum address.');
    }
    return value.toLowerCase();
}

// Identity projection shared with runtime parsing. Runtime additionally validates
// checksums, authorizers, transports and transaction settings before execution.
export function publicNodeSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
    const mode = input.mode === undefined ? 'ledger' : input.mode;
    if (!['ledger', 'ipfs'].includes(mode)) throw new Error('mode must be ledger or ipfs.');
    const fields = new Set(['mode', 'host', 'port', 'chainId', 'ledgerContract', 'allowedSigners', 'rpcUrl', 'ipfsUrl',
        'maxBodyBytes', 'maxTextBytes', 'bodyTimeoutMs', 'receiptTimeoutMs', 'pollIntervalMs',
        'operationTimeoutMs', 'gasLimit', 'maxFeePerGasWei', 'maxMessageRequestsPerMinute', 'batchLogging']);
    if (Object.keys(input).some(key => !fields.has(key))) throw new Error('Config contains an unsupported field.');
    const ledgerFields = ['chainId', 'ledgerContract', 'rpcUrl', 'receiptTimeoutMs', 'pollIntervalMs', 'gasLimit', 'maxFeePerGasWei'];
    if (mode === 'ipfs' && ledgerFields.some(key => Object.hasOwn(input, key))) {
        throw new Error('IPFS mode does not accept Ethereum or Ledger settings.');
    }
    const operationTimeoutMs = integer(input.operationTimeoutMs, 'operationTimeoutMs', 180_000);
    if (mode === 'ipfs') return { mode, operationTimeoutMs };
    const chainId = integer(input.chainId === undefined ? SEPOLIA_DEFAULTS.chainId : input.chainId,
        'chainId', undefined, Number.MAX_SAFE_INTEGER);
    const ledgerContract = input.ledgerContract === undefined && chainId === SEPOLIA_DEFAULTS.chainId
        ? SEPOLIA_DEFAULTS.ledgerContract : input.ledgerContract;
    publicAddress(ledgerContract);
    return { mode, chainId, ledgerContract, operationTimeoutMs };
}

export function targetName(value) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid inbox target.');
    return value;
}

export function workerTarget(worker) {
    if (!worker || typeof worker !== 'object' || Array.isArray(worker) ||
        Object.keys(worker).some(key => !['url', 'target', 'pollIntervalMs', 'peers'].includes(key))) {
        throw new Error('Unknown worker field.');
    }
    return targetName(worker.target);
}
