import {
    assertBytes32HexString,
    assertPositiveInteger,
    combineAbortSignals,
    createTimeoutSignal,
    throwIfSignalAborted,
    waitForRetryDelay,
} from '@oyaprotocol/utils';
import type { AbortSignalHandle, HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';

import { parseTransactionReceipt } from './receipt-utils.js';
import type { EthereumTransactionReceipt } from './receipt-utils.js';
import { requestEthereumJsonRpc } from './request-utils.js';

interface EthGetTransactionReceiptOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    transactionHash: string;
    id?: string | number;
    signal?: AbortSignal;
}

interface EthGetTransactionReceiptResult {
    readonly receipt: EthereumTransactionReceipt | null;
    readonly attemptCount: number;
    readonly response: unknown;
}

interface EthWaitForTransactionReceiptOptions extends EthGetTransactionReceiptOptions {
    /** Overall deadline, including requests, retries, and poll delays. */
    timeoutMs: number;
    pollIntervalMs: number;
}

interface EthWaitForTransactionReceiptResult {
    readonly receipt: EthereumTransactionReceipt;
    readonly pollCount: number;
    /** Total HTTP attempts across all completed lookups. */
    readonly attemptCount: number;
    readonly response: unknown;
}

class EthereumTransactionReceiptTimeoutError extends Error {
    readonly transactionHash: string;
    readonly timeoutMs: number;
    readonly pollCount: number;

    constructor(transactionHash: string, timeoutMs: number, pollCount: number, options?: ErrorOptions) {
        super(`Waiting for transaction receipt ${transactionHash} timed out after ${timeoutMs} ms.`, options);
        this.name = 'EthereumTransactionReceiptTimeoutError';
        this.transactionHash = transactionHash;
        this.timeoutMs = timeoutMs;
        this.pollCount = pollCount;
    }
}

function assertTimerMs(value: unknown, name: string): number {
    const duration = assertPositiveInteger(value, name);
    if (duration > 2_147_483_647) {
        throw new Error(`${name} must not exceed 2147483647 ms.`);
    }
    return duration;
}

async function ethGetTransactionReceipt({
    config,
    fetch,
    transactionHash,
    id,
    signal,
}: EthGetTransactionReceiptOptions): Promise<EthGetTransactionReceiptResult> {
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

async function ethWaitForTransactionReceipt({
    config,
    fetch,
    transactionHash,
    id,
    signal,
    timeoutMs,
    pollIntervalMs,
}: EthWaitForTransactionReceiptOptions): Promise<EthWaitForTransactionReceiptResult> {
    const validatedHash = assertBytes32HexString(transactionHash, 'transactionHash');
    const deadlineMs = assertTimerMs(timeoutMs, 'timeoutMs');
    const pollDelayMs = assertTimerMs(pollIntervalMs, 'pollIntervalMs');
    const abortMessage = 'ethWaitForTransactionReceipt was aborted by the caller.';
    throwIfSignalAborted(signal, abortMessage, signal?.reason);
    const timeout = createTimeoutSignal(deadlineMs);
    let operation: AbortSignalHandle | undefined;
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
    } catch (error) {
        throwIfSignalAborted(signal, abortMessage, signal?.reason);
        if (timeout.signal?.aborted) {
            throw new EthereumTransactionReceiptTimeoutError(validatedHash, deadlineMs, pollCount, { cause: error });
        }
        throw error;
    } finally {
        operation?.cleanup?.();
        timeout.cleanup?.();
    }
}

export { EthereumTransactionReceiptTimeoutError, ethGetTransactionReceipt, ethWaitForTransactionReceipt };
export type {
    EthGetTransactionReceiptOptions,
    EthGetTransactionReceiptResult,
    EthWaitForTransactionReceiptOptions,
    EthWaitForTransactionReceiptResult,
};
