import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    assertTimerMs,
    createHttpConfig,
    isPlainObject,
    parseBytes,
    runWithRetry,
    throwIfSignalAborted,
} from '@oyaprotocol/utils';
import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';

import { normalizeJsonRpcId, parseQuantity, requestEthereumJsonRpc } from './request-utils.js';
import type { SignedTransaction, TransactionPreparer, TransactionSigner, UnsignedTransaction } from './transactions.js';

interface CreateTransactionPreparerOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    chainId: bigint;
    signer: TransactionSigner;
    /** Whole percent added to the estimate, rounded up. Default: 20. */
    gasLimitMarginPercent?: number;
    /** Integer multiplier for the latest base fee. Default: 2. */
    baseFeeMultiplier?: number;
    /** Exceeding either optional ceiling rejects before signing. */
    limits?: { gasLimit?: bigint; feePerGas?: bigint };
    /** Overall preparation deadline, including signing. Default: 30,000 ms. */
    timeoutMs?: number;
    /** JSON-RPC ID for preparation reads. Default: 1. */
    id?: string | number;
}

const UINT256_MAX = (1n << 256n) - 1n;

function assertUint256(value: unknown, name: string): bigint {
    if (typeof value !== 'bigint' || value < 0n || value > UINT256_MAX) {
        throw new Error(`${name} must be a non-negative bigint fitting in 256 bits.`);
    }
    return value;
}

function parseTransactionQuantity(value: unknown, name: string): bigint {
    if (typeof value === 'string' && value.length > 66) {
        throw new Error(`${name} must fit in 256 bits.`);
    }
    return parseQuantity(value, name);
}

/** Prepare direct account calls; the host coordinates nonces through submission. */
function createTransactionPreparer({
    config, fetch, chainId, signer, gasLimitMarginPercent = 20,
    baseFeeMultiplier = 2, limits, timeoutMs = 30_000, id,
}: CreateTransactionPreparerOptions): TransactionPreparer {
    const rpcConfig = createHttpConfig(config);
    assertTimerMs(rpcConfig.timeoutMs, 'config.timeoutMs');
    const deadlineMs = assertTimerMs(timeoutMs, 'timeoutMs');
    const expectedChainId = assertUint256(chainId, 'chainId');
    if (expectedChainId === 0n) {
        throw new Error('chainId must be positive.');
    }
    const requestId = normalizeJsonRpcId(id);
    if (typeof fetch !== 'function') {
        throw new TypeError('fetch must be provided as a function.');
    }
    if (signer == null || typeof signer.signTransaction !== 'function') {
        throw new TypeError('signer.signTransaction must be provided as a function.');
    }
    const signerAddress = parseBytes(signer.address, 'signer.address', 20);
    const signTransaction = signer.signTransaction.bind(signer);
    if (!Number.isSafeInteger(gasLimitMarginPercent) || gasLimitMarginPercent < 0) {
        throw new Error('gasLimitMarginPercent must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(baseFeeMultiplier) || baseFeeMultiplier < 1) {
        throw new Error('baseFeeMultiplier must be a positive safe integer.');
    }
    if (limits !== undefined && !isPlainObject(limits)) {
        throw new TypeError('limits must be a plain object.');
    }
    const gasLimitCap = limits?.gasLimit === undefined
        ? undefined : assertUint256(limits.gasLimit, 'limits.gasLimit');
    const feePerGasCap = limits?.feePerGas === undefined
        ? undefined : assertUint256(limits.feePerGas, 'limits.feePerGas');
    if (gasLimitCap === 0n) {
        throw new Error('limits.gasLimit must be positive.');
    }

    return async ({ to, data, value, signal }) => {
        const call = {
            to: parseBytes(to, 'to', 20),
            data: parseBytes(data, 'data'),
            value: assertUint256(value, 'value'),
        };
        const abortMessage = 'Transaction preparation was aborted by the caller.';
        return await runWithRetry<SignedTransaction>({
            maxRetries: 0, retryDelayMs: 0, timeoutMs: deadlineMs, signal,
            abortErrorMessage: abortMessage,
            shouldRetry: () => false,
            normalizeError: (error) => error instanceof Error
                ? error : new Error('Transaction preparation failed.', { cause: error }),
            run: async ({ signal: operationSignal }) => {
                const rpc = async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
                    const response = await requestEthereumJsonRpc({
                        config: rpcConfig, fetch, method, params, id: requestId,
                        ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                    });
                    return response.result;
                };
                const actualChainId = parseTransactionQuantity(await rpc('eth_chainId'), 'eth_chainId result');
                if (actualChainId !== expectedChainId) {
                    throw new Error(`RPC chain ID ${actualChainId} did not match configured chainId ${expectedChainId}.`);
                }
                const nonce = parseTransactionQuantity(
                    await rpc('eth_getTransactionCount', [signerAddress, 'pending']),
                    'eth_getTransactionCount result',
                );
                if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error('Transaction nonce must fit in a safe integer.');
                }
                const block = await rpc('eth_getBlockByNumber', ['latest', false]);
                if (!isPlainObject(block) || block.baseFeePerGas === undefined || block.baseFeePerGas === null) {
                    throw new Error('Latest block must include baseFeePerGas for EIP-1559 transaction preparation.');
                }
                const baseFee = parseTransactionQuantity(block.baseFeePerGas, 'block.baseFeePerGas');
                const blockGasLimit = parseTransactionQuantity(block.gasLimit, 'block.gasLimit');
                if (blockGasLimit === 0n) {
                    throw new Error('block.gasLimit must be positive.');
                }
                const maxPriorityFeePerGas = parseTransactionQuantity(
                    await rpc('eth_maxPriorityFeePerGas'), 'eth_maxPriorityFeePerGas result',
                );
                const maxFeePerGas = assertUint256(
                    baseFee * BigInt(baseFeeMultiplier) + maxPriorityFeePerGas, 'maxFeePerGas',
                );
                if (feePerGasCap !== undefined && maxFeePerGas > feePerGasCap) {
                    throw new Error('Calculated maxFeePerGas exceeds limits.feePerGas.');
                }
                const estimate = parseTransactionQuantity(await rpc('eth_estimateGas', [{
                    from: signerAddress, to: call.to, data: call.data,
                    value: `0x${call.value.toString(16)}`,
                    type: '0x2', chainId: `0x${expectedChainId.toString(16)}`,
                    nonce: `0x${nonce.toString(16)}`,
                    maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
                    maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
                }, 'pending']), 'eth_estimateGas result');
                if (estimate === 0n) {
                    throw new Error('eth_estimateGas result must be positive.');
                }
                const gasLimit = (estimate * (100n + BigInt(gasLimitMarginPercent)) + 99n) / 100n;
                if (gasLimit > blockGasLimit) {
                    throw new Error('Buffered gas limit exceeds the latest block gas limit.');
                }
                if (gasLimitCap !== undefined && gasLimit > gasLimitCap) {
                    throw new Error('Buffered gas limit exceeds limits.gasLimit.');
                }
                const transaction: Readonly<UnsignedTransaction> = Object.freeze({
                    ...call, type: 2, chainId: expectedChainId, nonce: Number(nonce),
                    gasLimit, maxFeePerGas, maxPriorityFeePerGas,
                });
                throwIfSignalAborted(operationSignal, abortMessage, operationSignal?.reason);
                const signed = await signTransaction(transaction, operationSignal);
                throwIfSignalAborted(operationSignal, abortMessage, operationSignal?.reason);
                if (!isPlainObject(signed)) {
                    throw new TypeError('signer.signTransaction must return a plain object.');
                }
                const rawTransaction = parseBytes(signed.rawTransaction, 'rawTransaction');
                const transactionHash = parseBytes(signed.transactionHash, 'transactionHash', 32);
                if (!rawTransaction.startsWith('0x02') || rawTransaction.length <= 4) {
                    throw new Error('rawTransaction must contain a signed EIP-1559 type-2 transaction.');
                }
                const computedHash = `0x${bytesToHex(keccak_256(hexToBytes(rawTransaction.slice(2))))}`;
                if (computedHash !== transactionHash.toLowerCase()) {
                    throw new Error('transactionHash did not match the signed rawTransaction bytes.');
                }
                return Object.freeze({ rawTransaction, transactionHash });
            },
        });
    };
}

export { createTransactionPreparer };
export type { CreateTransactionPreparerOptions };
