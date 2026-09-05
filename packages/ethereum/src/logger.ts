import { isPlainObject } from '@oyaprotocol/utils';

import { parseBytes } from './receipt-utils.js';
import type { EthereumReceiptLog } from './receipt-utils.js';

// Verified against contracts/src/Logger.sol with forge inspect and cast keccak.
const LOGGER_SELECTOR = '0x41304fac'; // log(string)
const LOGGER_EVENT_TOPIC = '0x0738f4da267a110d810e6e89fc59e46be6de0c37b1d5cd559b267dc3688e74e0'; // Log(address,string)
const STRING_OFFSET = '20'.padStart(64, '0');

type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;

interface LoggerEvent {
    readonly node: string;
    readonly cid: string;
    readonly removed?: boolean;
}

function encodeLoggerCall(cid: string): string {
    if (typeof cid !== 'string' || !cid.isWellFormed()) {
        throw new TypeError('cid must be a well-formed Unicode string.');
    }
    const bytes = new TextEncoder().encode(cid);
    const length = bytes.length.toString(16).padStart(64, '0');
    const content = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const paddedContent = content.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    return `${LOGGER_SELECTOR}${STRING_OFFSET}${length}${paddedContent}`;
}

/** Returns null for unrelated logs; malformed matching Logger events throw. */
function decodeLoggerEvent(log: LoggerEventInput, loggerAddress: string): LoggerEvent | null {
    const expectedAddress = parseBytes(loggerAddress, 'loggerAddress', 20);
    if (!isPlainObject(log)) {
        throw new TypeError('log must be a plain object.');
    }
    const address = parseBytes(log.address, 'log.address', 20);
    if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
        return null;
    }
    if (!Array.isArray(log.topics)) {
        throw new TypeError('log.topics must be an array.');
    }
    if (log.topics.length === 0) {
        return null;
    }
    const signature = parseBytes(log.topics[0], 'log.topics[0]', 32);
    if (signature.toLowerCase() !== LOGGER_EVENT_TOPIC) {
        return null;
    }
    if (log.topics.length !== 2) {
        throw new Error('Logger event must have exactly two topics.');
    }
    const nodeTopic = parseBytes(log.topics[1], 'log.topics[1]', 32);
    if (nodeTopic.slice(2, 26) !== '0'.repeat(24)) {
        throw new Error('Logger event node address must have zero padding.');
    }
    if (log.removed !== undefined && typeof log.removed !== 'boolean') {
        throw new TypeError('log.removed must be a boolean when provided.');
    }

    const data = parseBytes(log.data, 'log.data').slice(2);
    if (data.length < 128 || data.slice(0, 64) !== STRING_OFFSET) {
        throw new Error('Logger event data must contain offset 32 and a string length word.');
    }
    const length = BigInt(`0x${data.slice(64, 128)}`);
    const paddedLength = ((length + 31n) / 32n) * 32n;
    if (BigInt(data.length / 2) !== 64n + paddedLength) {
        throw new Error('Logger event data size must match its padded string length.');
    }
    // The size check bounds the declared length to the actual input before allocation.
    const byteLength = Number(length);
    const contentEnd = 128 + byteLength * 2;
    if (!/^0*$/.test(data.slice(contentEnd))) {
        throw new Error('Logger event string must have zero padding.');
    }
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
        bytes[index] = Number.parseInt(data.slice(128 + index * 2, 130 + index * 2), 16);
    }
    let cid: string;
    try {
        // Preserve a leading BOM as content rather than consuming it as a marker.
        cid = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
        throw new Error('Logger event cid must contain valid UTF-8.', { cause: error });
    }
    return {
        node: `0x${nodeTopic.slice(26)}`,
        cid,
        ...(log.removed === undefined ? {} : { removed: log.removed }),
    };
}

export { encodeLoggerCall, decodeLoggerEvent };
export type { LoggerEventInput, LoggerEvent };
