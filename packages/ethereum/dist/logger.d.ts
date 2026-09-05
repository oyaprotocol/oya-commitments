import type { EthereumReceiptLog, EthereumTransactionReceipt } from './receipt-utils.js';
import type { EthWaitForTransactionReceiptOptions } from './receipts.js';
import type { PrepareTransaction, TransactionStage } from './transactions.js';
type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;
interface LoggerEvent {
    readonly node: string;
    readonly cidKeccak256Hash: string;
    readonly cid: string;
    readonly removed?: boolean;
}
interface LogCidOptions extends Omit<EthWaitForTransactionReceiptOptions, 'transactionHash' | 'id'> {
    loggerAddress: string;
    /** Logger's immediate caller, which can be a contract wallet. */
    expectedNode: string;
    prepareTransaction: PrepareTransaction;
}
interface LogCidResult {
    readonly cid: string;
    readonly transactionHash: string;
    readonly receipt: EthereumTransactionReceipt;
    readonly event: LoggerEvent;
}
declare class LogCidError extends Error {
    readonly cid: string;
    readonly stage: TransactionStage;
    /** Known before submission; its presence does not prove acceptance. */
    readonly transactionHash: string | null;
    readonly receipt: EthereumTransactionReceipt | null;
    constructor(cid: string, stage: TransactionStage, transactionHash: string | null, receipt: EthereumTransactionReceipt | null, cause: unknown);
}
declare function encodeLoggerCall(cid: string): string;
/** Compute the topic used to find Logger events for a canonical CID. */
declare function hashLoggerCid(cid: string): string;
/** Returns null for unrelated logs; malformed matching Logger events throw. */
declare function decodeLoggerEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null;
declare function logCid(cid: string, { config, fetch, loggerAddress, expectedNode, prepareTransaction, timeoutMs, pollIntervalMs, signal, }: LogCidOptions): Promise<LogCidResult>;
export { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid, logCid, LogCidError };
export type { LoggerEventInput, LoggerEvent, LogCidOptions, LogCidResult, };
