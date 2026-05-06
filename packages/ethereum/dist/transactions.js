import { assertBytes32HexString, assertHexData, isPlainObject, } from '@oyaprotocol/utils';
import { EthereumJsonRpcError, requestEthereumJsonRpc, requestEthereumJsonRpcWithCustomRetryPolicy, } from './request-utils.js';
const RAW_TRANSACTION_RECOVERY_MESSAGES = [
    'already known',
    'known transaction',
    'already imported',
    'already exists',
    'already in mempool',
    'nonce too low',
];
class EthereumRawTransactionRecoveryError extends Error {
    transactionHash;
    originalError;
    recoveryError;
    constructor(message, { transactionHash, originalError, recoveryError, }) {
        super(message, { cause: recoveryError ?? originalError });
        this.name = 'EthereumRawTransactionRecoveryError';
        this.transactionHash = transactionHash;
        this.originalError = originalError;
        if (recoveryError !== undefined) {
            this.recoveryError = recoveryError;
        }
    }
}
function isRetryRecoveryJsonRpcError(error) {
    if (!(error instanceof EthereumJsonRpcError)) {
        return false;
    }
    if (error.method !== 'eth_sendRawTransaction' || error.attemptCount <= 1) {
        return false;
    }
    const message = error.message.toLowerCase();
    return RAW_TRANSACTION_RECOVERY_MESSAGES.some((text) => message.includes(text));
}
function transactionLookupMatchesHash(result, transactionHash) {
    if (!isPlainObject(result)) {
        return false;
    }
    if (typeof result.hash !== 'string') {
        return false;
    }
    return (assertBytes32HexString(result.hash, 'transaction.hash').toLowerCase() ===
        transactionHash.toLowerCase());
}
function createJsonRpcOptions({ config, fetch, method, params, id, signal, }) {
    return {
        config,
        fetch,
        method,
        params,
        ...(id === undefined ? {} : { id }),
        ...(signal === undefined ? {} : { signal }),
    };
}
function shouldRetryRawTransactionMethod(method) {
    return method === 'eth_sendRawTransaction';
}
async function recoverRawTransactionSubmission({ config, fetch, transactionHash, id, signal, originalError, }) {
    if (transactionHash === null) {
        throw new EthereumRawTransactionRecoveryError('eth_sendRawTransaction may have been accepted before a retry returned a duplicate transaction error; provide transactionHash to verify acceptance.', {
            transactionHash,
            originalError,
        });
    }
    try {
        const lookup = await requestEthereumJsonRpc(createJsonRpcOptions({
            config,
            fetch,
            method: 'eth_getTransactionByHash',
            params: [transactionHash],
            id,
            signal,
        }));
        if (!transactionLookupMatchesHash(lookup.result, transactionHash)) {
            throw new EthereumRawTransactionRecoveryError('eth_sendRawTransaction may have been accepted, but eth_getTransactionByHash did not confirm the supplied transactionHash.', {
                transactionHash,
                originalError,
            });
        }
        return {
            transactionHash,
            attemptCount: originalError.attemptCount,
            recovered: true,
            response: originalError.response,
            recoveryAttemptCount: lookup.attemptCount,
            recoveryResponse: lookup.response,
        };
    }
    catch (error) {
        if (error instanceof EthereumRawTransactionRecoveryError) {
            throw error;
        }
        throw new EthereumRawTransactionRecoveryError('eth_sendRawTransaction may have been accepted, but transaction hash recovery failed.', {
            transactionHash,
            originalError,
            recoveryError: error,
        });
    }
}
async function ethSendRawTransaction({ config, fetch, rawTransaction, transactionHash, id, signal, }) {
    const validatedRawTransaction = assertHexData(rawTransaction, 'rawTransaction');
    const validatedTransactionHash = transactionHash === undefined
        ? null
        : assertBytes32HexString(transactionHash, 'transactionHash');
    try {
        const result = await requestEthereumJsonRpcWithCustomRetryPolicy(createJsonRpcOptions({
            config,
            fetch,
            method: 'eth_sendRawTransaction',
            params: [validatedRawTransaction],
            id,
            signal,
        }), shouldRetryRawTransactionMethod);
        const returnedTransactionHash = assertBytes32HexString(result.result, 'result');
        if (validatedTransactionHash !== null &&
            returnedTransactionHash.toLowerCase() !== validatedTransactionHash.toLowerCase()) {
            throw new Error('eth_sendRawTransaction returned a transaction hash that did not match transactionHash.');
        }
        return {
            transactionHash: returnedTransactionHash,
            attemptCount: result.attemptCount,
            recovered: false,
            response: result.response,
        };
    }
    catch (error) {
        if (!isRetryRecoveryJsonRpcError(error)) {
            throw error;
        }
        return await recoverRawTransactionSubmission({
            config,
            fetch,
            transactionHash: validatedTransactionHash,
            id,
            signal,
            originalError: error,
        });
    }
}
export { EthereumRawTransactionRecoveryError, ethSendRawTransaction, };
//# sourceMappingURL=transactions.js.map