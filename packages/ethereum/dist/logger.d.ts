import type { EthereumReceiptLog } from './receipt-utils.js';
type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;
interface LoggerEvent {
    readonly node: string;
    readonly cidKeccak256Hash: string;
    readonly cid: string;
    readonly removed?: boolean;
}
declare function encodeLoggerCall(cid: string): string;
/** Compute the topic used to find Logger events for a canonical CID. */
declare function hashLoggerCid(cid: string): string;
/** Returns null for unrelated logs; malformed matching Logger events throw. */
declare function decodeLoggerEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null;
export { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid };
export type { LoggerEventInput, LoggerEvent };
