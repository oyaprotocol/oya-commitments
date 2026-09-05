import type { LoggerEvent } from './logger.js';
import type { EthWaitForTransactionReceiptOptions } from './receipts.js';
import type { EthereumTransactionReceipt } from './receipt-utils.js';
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
type PrepareLoggerTransaction = (request: LoggerTransactionRequest) => PreparedLoggerTransaction | PromiseLike<PreparedLoggerTransaction>;
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
declare class LogCidError extends Error {
    readonly cid: string;
    readonly stage: LogCidStage;
    /** Known before submission; its presence does not prove acceptance. */
    readonly transactionHash: string | null;
    readonly receipt: EthereumTransactionReceipt | null;
    constructor(cid: string, stage: LogCidStage, transactionHash: string | null, receipt: EthereumTransactionReceipt | null, cause: unknown);
}
declare function logCid(cid: string, { config, fetch, loggerAddress, expectedNode, prepareTransaction, timeoutMs, pollIntervalMs, signal, }: LogCidOptions): Promise<LogCidResult>;
export { logCid, LogCidError };
export type { LogCidOptions, LogCidResult, LogCidStage, LoggerTransactionRequest, PreparedLoggerTransaction, PrepareLoggerTransaction, };
