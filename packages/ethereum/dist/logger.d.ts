import type { EthereumReceiptLog } from './receipt-utils.js';
type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;
interface LoggerEvent {
    readonly node: string;
    readonly cid: string;
    readonly removed?: boolean;
}
declare function encodeLoggerLogCall(cid: string): string;
/** Returns null for unrelated logs; malformed matching Logger events throw. */
declare function decodeLoggerLogEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null;
export { encodeLoggerLogCall, decodeLoggerLogEvent };
export type { LoggerEventInput, LoggerEvent };
