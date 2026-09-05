import { assertBytes32HexString, assertPositiveInteger, combineAbortSignals, createTimeoutSignal, throwIfSignalAborted, waitForRetryDelay, } from '@oyaprotocol/utils';
import { parseTransactionReceipt } from './receipt-utils.js';
import { requestEthereumJsonRpc } from './request-utils.js';
class EthereumTransactionReceiptTimeoutError extends Error {
    transactionHash;
    timeoutMs;
    pollCount;
    constructor(transactionHash, timeoutMs, pollCount, options) {
        super(`Waiting for transaction receipt ${transactionHash} timed out after ${timeoutMs} ms.`, options);
        this.name = 'EthereumTransactionReceiptTimeoutError';
        this.transactionHash = transactionHash;
        this.timeoutMs = timeoutMs;
        this.pollCount = pollCount;
    }
}
function assertTimerMs(value, name) {
    const duration = assertPositiveInteger(value, name);
    if (duration > 2_147_483_647) {
        throw new Error(`${name} must not exceed 2147483647 ms.`);
    }
    return duration;
}
async function ethGetTransactionReceipt({ config, fetch, transactionHash, id, signal, }) {
    const validatedHash = assertBytes32HexString(transactionHash, 'transactionHash');
    const result = await requestEthereumJsonRpc({
        config,
        fetch,
        method: 'eth_getTransactionReceipt',
        params: [validatedHash],
        ...(id === undefined ? {} : { id }),
        ...(signal === undefined ? {} : { signal }),
    });
    return {
        receipt: result.result === null ? null : parseTransactionReceipt(result.result, validatedHash),
        attemptCount: result.attemptCount,
        response: result.response,
    };
}
async function ethWaitForTransactionReceipt({ config, fetch, transactionHash, id, signal, timeoutMs, pollIntervalMs, }) {
    const validatedHash = assertBytes32HexString(transactionHash, 'transactionHash');
    const deadlineMs = assertTimerMs(timeoutMs, 'timeoutMs');
    const pollDelayMs = assertTimerMs(pollIntervalMs, 'pollIntervalMs');
    const abortMessage = 'ethWaitForTransactionReceipt was aborted by the caller.';
    throwIfSignalAborted(signal, abortMessage, signal?.reason);
    const timeout = createTimeoutSignal(deadlineMs);
    let operation;
    let pollCount = 0;
    let attemptCount = 0;
    try {
        operation = combineAbortSignals([signal, timeout.signal]);
        const operationSignal = operation.signal;
        while (true) {
            throwIfSignalAborted(operationSignal, abortMessage, operationSignal?.reason);
            pollCount += 1;
            const result = await ethGetTransactionReceipt({
                config,
                fetch,
                transactionHash: validatedHash,
                ...(id === undefined ? {} : { id }),
                ...(operationSignal === undefined ? {} : { signal: operationSignal }),
            });
            throwIfSignalAborted(operationSignal, abortMessage, operationSignal?.reason);
            attemptCount += result.attemptCount;
            if (result.receipt !== null) {
                return { receipt: result.receipt, pollCount, attemptCount, response: result.response };
            }
            await waitForRetryDelay({
                retryDelayMs: pollDelayMs,
                signal: operationSignal,
                abortErrorMessage: abortMessage,
            });
        }
    }
    catch (error) {
        throwIfSignalAborted(signal, abortMessage, signal?.reason);
        if (timeout.signal?.aborted) {
            throw new EthereumTransactionReceiptTimeoutError(validatedHash, deadlineMs, pollCount, { cause: error });
        }
        throw error;
    }
    finally {
        operation?.cleanup?.();
        timeout.cleanup?.();
    }
}
export { assertTimerMs, EthereumTransactionReceiptTimeoutError, ethGetTransactionReceipt, ethWaitForTransactionReceipt };
//# sourceMappingURL=receipts.js.map