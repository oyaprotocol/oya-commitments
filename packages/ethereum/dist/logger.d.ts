import type { EthereumReceiptLog } from './receipt-utils.js';
type LoggerLogEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;
interface LoggerLogEvent {
    readonly node: string;
    readonly cid: string;
    readonly removed?: boolean;
}
declare function encodeLoggerLogCall(cid: string): string;
/** Returns null for unrelated logs; malformed matching Logger events throw. */
declare function decodeLoggerLogEvent(log: LoggerLogEventInput, loggerAddress: string): LoggerLogEvent | null;
export { encodeLoggerLogCall, decodeLoggerLogEvent };
export type { LoggerLogEventInput, LoggerLogEvent };
