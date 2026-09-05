import { encodeLoggerCall, decodeLoggerEvent } from '@oyaprotocol/ethereum';
import type {
    EthereumReceiptLog,
    LoggerEvent,
    LoggerEventInput,
} from '@oyaprotocol/ethereum';

const calldata: string = encodeLoggerCall('bafy-test');
declare const loggerAddress: string;
declare const receiptLog: EthereumReceiptLog;
const input: LoggerEventInput = receiptLog;
const event: LoggerEvent | null = decodeLoggerEvent(input, loggerAddress);
if (event !== null) {
    const node: string = event.node;
    const cid: string = event.cid;
    const removed: boolean | undefined = event.removed;
    // @ts-expect-error Decoded event values are readonly.
    event.cid = 'changed';
    void [node, cid, removed];
}

// @ts-expect-error Call encoding requires a string.
encodeLoggerCall(1);
// @ts-expect-error Decoding requires an explicit expected Logger address.
decodeLoggerEvent(receiptLog);
// @ts-expect-error Event filtering can return null.
const matchingEvent: LoggerEvent = decodeLoggerEvent(receiptLog, loggerAddress);
void [calldata, matchingEvent];
