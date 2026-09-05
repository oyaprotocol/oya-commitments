import {
    assertHexData,
    createHttpConfig,
    invokeWithAbort,
    isPlainObject,
    parseBytes,
    throwIfSignalAborted,
} from '@oyaprotocol/utils';

import { decodeLoggerEvent, encodeLoggerCall } from './logger.js';
import type { LoggerEvent } from './logger.js';
import { assertTimerMs, ethWaitForTransactionReceipt } from './receipts.js';
import type { EthWaitForTransactionReceiptOptions } from './receipts.js';
import type { EthereumTransactionReceipt } from './receipt-utils.js';
import { ethSendRawTransaction } from './transactions.js';

interface LoggerTransactionRequest {
    readonly to: string;
    readonly data: string;
    readonly value: 0n;
    readonly signal?: AbortSignal;
}

interface PreparedLoggerTransaction {
    readonly rawTransaction: string;
    readonly transactionHash: string;
}

/** Prepare and sign the requested call without broadcasting it. */
type PrepareLoggerTransaction = (
    request: LoggerTransactionRequest
) => PreparedLoggerTransaction | PromiseLike<PreparedLoggerTransaction>;

interface LogCidOptions extends Omit<EthWaitForTransactionReceiptOptions, 'transactionHash' | 'id'> {
    loggerAddress: string;
    /** Logger's immediate caller, which can be a contract wallet. */
    expectedNode: string;
    prepareTransaction: PrepareLoggerTransaction;
}

interface LogCidResult {
    readonly cid: string;
    readonly transactionHash: string;
    readonly receipt: EthereumTransactionReceipt;
    readonly event: LoggerEvent;
}

type LogCidStage = 'prepare' | 'submit' | 'receipt' | 'verify';

class LogCidError extends Error {
    readonly cid: string;
    readonly stage: LogCidStage;
    /** Known before submission; its presence does not prove acceptance. */
    readonly transactionHash: string | null;
    readonly receipt: EthereumTransactionReceipt | null;

    constructor(
        cid: string,
        stage: LogCidStage,
        transactionHash: string | null,
        receipt: EthereumTransactionReceipt | null,
        cause: unknown
    ) {
        super(`Logging CID failed during ${stage}.`, { cause });
        this.name = 'LogCidError';
        this.cid = cid;
        this.stage = stage;
        this.transactionHash = transactionHash;
        this.receipt = receipt;
    }
}

async function logCid(
    cid: string,
    {
        config, fetch, loggerAddress, expectedNode, prepareTransaction,
        timeoutMs, pollIntervalMs, signal,
    }: LogCidOptions
): Promise<LogCidResult> {
    const data = encodeLoggerCall(cid);
    const to = parseBytes(loggerAddress, 'loggerAddress', 20);
    const node = parseBytes(expectedNode, 'expectedNode', 20);
    const rpcConfig = createHttpConfig(config);
    const deadlineMs = assertTimerMs(timeoutMs, 'timeoutMs');
    const pollDelayMs = assertTimerMs(pollIntervalMs, 'pollIntervalMs');
    if (typeof fetch !== 'function' || typeof prepareTransaction !== 'function') {
        throw new TypeError('fetch and prepareTransaction must be functions.');
    }
    const cancellation = signal === undefined ? {} : { signal };
    const abortMessage = 'logCid was aborted by the caller.';
    let stage: LogCidStage = 'prepare';
    let transactionHash: string | null = null;
    let receipt: EthereumTransactionReceipt | null = null;
    try {
        throwIfSignalAborted(signal, abortMessage, signal?.reason);
        const prepared = await invokeWithAbort(
            async () => await prepareTransaction(Object.freeze({ to, data, value: 0n, ...cancellation })),
            signal
        );
        if (!isPlainObject(prepared)) {
            throw new TypeError('prepareTransaction must return a plain object.');
        }
        transactionHash = parseBytes(prepared.transactionHash, 'transactionHash', 32);
        const rawTransaction = assertHexData(prepared.rawTransaction, 'rawTransaction');
        throwIfSignalAborted(signal, abortMessage, signal?.reason);

        stage = 'submit';
        await ethSendRawTransaction({
            config: rpcConfig, fetch, rawTransaction, transactionHash, ...cancellation,
        });

        stage = 'receipt';
        const observed = await ethWaitForTransactionReceipt({
            config: rpcConfig, fetch, transactionHash,
            timeoutMs: deadlineMs, pollIntervalMs: pollDelayMs, ...cancellation,
        });
        receipt = observed.receipt;

        stage = 'verify';
        if (receipt.status !== 'success') {
            throw new Error(`Logger transaction execution status: ${receipt.status ?? 'unknown'}.`);
        }
        const event = receipt.logs
            .map((log) => decodeLoggerEvent(log, to))
            .find((entry) => entry !== null && entry.removed !== true &&
                entry.node.toLowerCase() === node.toLowerCase() && entry.cid === cid);
        if (!event) {
            throw new Error('Receipt did not contain the expected Logger event.');
        }
        return { cid, transactionHash, receipt, event };
    } catch (cause) {
        throw new LogCidError(cid, stage, transactionHash, receipt, cause);
    }
}

export { logCid, LogCidError };
export type {
    LogCidOptions, LogCidResult, LogCidStage,
    LoggerTransactionRequest, PreparedLoggerTransaction, PrepareLoggerTransaction,
};
