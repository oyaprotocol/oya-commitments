import type { EthereumReceiptLog, EthereumTransactionReceipt } from './receipt-utils.js';
import type { EthWaitForTransactionReceiptOptions } from './receipts.js';
import type { TransactionPreparer, TransactionStage } from './transactions.js';
type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;
interface LoggerEvent {
    readonly node: string;
    readonly cidKeccak256Hash: string;
    readonly cid: string;
    readonly removed?: boolean;
}
interface LogCidOptions extends Omit<EthWaitForTransactionReceiptOptions, 'transactionHash' | 'id'> {
    /** 20-byte address of the deployed Logger contract. */
    loggerContract: string;
    /** Address Logger should record as its immediate caller; can be a contract wallet. */
    nodeAddress: string;
    transactionPreparer: TransactionPreparer;
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
declare function decodeLoggerEvent(log: LoggerEventInput, loggerContract: string): LoggerEvent | null;
declare function logCid(cid: string, { config, fetch, loggerContract, nodeAddress, transactionPreparer, timeoutMs, pollIntervalMs, signal, }: LogCidOptions): Promise<LogCidResult>;
export { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid, logCid, LogCidError };
export type { LoggerEventInput, LoggerEvent, LogCidOptions, LogCidResult, };
