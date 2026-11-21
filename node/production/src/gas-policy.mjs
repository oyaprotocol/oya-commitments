// Shared config semantics. Transaction preparation applies additional uint256 checks.
const DEFAULT_GAS_LIMIT = 200_000;
const DEFAULT_FEE = '30000000000';

export function validateGasFee(input) {
    if (input.maxFeePerGasWei !== undefined && (typeof input.maxFeePerGasWei !== 'string' ||
        !/^[1-9][0-9]{0,77}$/.test(input.maxFeePerGasWei))) {
        throw new Error('maxFeePerGasWei must be a positive decimal string.');
    }
}

export function parseGasLimits(input) {
    validateGasFee(input);
    const gas = input.gasLimit ?? DEFAULT_GAS_LIMIT;
    if (!Number.isSafeInteger(gas) || gas < 1 || gas > 2_147_483_647) {
        throw new Error('gasLimit must be a positive integer no greater than 2147483647.');
    }
    return { gasLimit: BigInt(gas), feePerGas: BigInt(input.maxFeePerGasWei ?? DEFAULT_FEE) };
}

// Only mode and gas fields are projected; other runtime settings are not validated.
export function projectGasPolicy(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object.');
    const mode = input.mode === undefined ? 'ledger' : input.mode;
    if (!['ledger', 'ipfs'].includes(mode)) throw new Error('mode must be ledger or ipfs.');
    const base = { version: 1, scope: 'offline-config-projection', mode, applicable: mode === 'ledger' };
    if (mode === 'ipfs') {
        if (['gasLimit', 'maxFeePerGasWei'].some(key => Object.hasOwn(input, key))) {
            throw new Error('IPFS mode does not accept Ethereum or Ledger settings.');
        }
        return { ...base, gasLimit: null, maxFeePerGasWei: null, executionGasCeilingWei: null, origins: null };
    }
    const { gasLimit, feePerGas } = parseGasLimits(input);
    return { ...base, gasLimit: gasLimit.toString(), maxFeePerGasWei: feePerGas.toString(),
        executionGasCeilingWei: (gasLimit * feePerGas).toString(),
        origins: { gasLimit: input.gasLimit == null ? 'default' : 'override',
            maxFeePerGasWei: input.maxFeePerGasWei === undefined ? 'default' : 'override' } };
}

export function formatGasPolicy(policy) {
    const intro = `Offline config projection (${policy.mode}); not loaded runtime policy or full config validation.`;
    if (!policy.applicable) return `${intro}\nGas policy: inapplicable in IPFS mode.`;
    return [intro,
        `gasLimit: ${policy.gasLimit} gas (${policy.origins.gasLimit})`,
        `maxFeePerGasWei: ${policy.maxFeePerGasWei} wei/gas (${policy.origins.maxFeePerGasWei})`,
        `Execution-gas ceiling per transaction: ${policy.executionGasCeilingWei} wei`,
        'Configured cap product, not an actual fee estimate or daily budget; other chain fees may apply.',
    ].join('\n');
}
