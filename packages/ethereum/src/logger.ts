import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    assertCanonicalCid,
    assertHexData,
    assertTimerMs,
    createHttpConfig,
    invokeWithAbort,
    isPlainObject,
    parseBytes,
    throwIfSignalAborted,
} from '@oyaprotocol/utils';

import type { EthereumReceiptLog, EthereumTransactionReceipt } from './receipt-utils.js';
import { ethWaitForTransactionReceipt } from './receipts.js';
import type { EthWaitForTransactionReceiptOptions } from './receipts.js';
import { normalizeJsonRpcId } from './request-utils.js';
import { ethSendRawTransaction } from './transactions.js';
import type { TransactionPreparer, TransactionStage } from './transactions.js';

// Verified against contracts/src/Logger.sol with forge inspect and cast keccak.
const LOGGER_SELECTOR = '0x41304fac'; // log(string)
const LOGGER_EVENT_TOPIC = '0xce2d845fcf02211a951a2153c1ddf64ec48ef6d54644ea188101f10018b871dc'; // Log(address,bytes32,string)
const STRING_OFFSET = '20'.padStart(64, '0');

type LoggerEventInput = Pick<EthereumReceiptLog, 'address' | 'topics' | 'data' | 'removed'>;

interface LoggerEvent {
    readonly node: string;
    readonly cidKeccak256Hash: string;
    readonly cid: string;
    readonly removed?: boolean;
}

interface LogCidOptions extends Omit<EthWaitForTransactionReceiptOptions, 'transactionHash'> {
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

class LogCidError extends Error {
    readonly cid: string;
    readonly stage: TransactionStage;
    /** Known before submission; its presence does not prove acceptance. */
    readonly transactionHash: string | null;
    readonly receipt: EthereumTransactionReceipt | null;

    constructor(
        cid: string,
        stage: TransactionStage,
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

function encodeLoggerCall(cid: string): string {
    assertCanonicalCid(cid, 'cid');
    const bytes = new TextEncoder().encode(cid);
    const length = bytes.length.toString(16).padStart(64, '0');
    const content = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const paddedContent = content.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    return `${LOGGER_SELECTOR}${STRING_OFFSET}${length}${paddedContent}`;
}

/** Compute the topic used to find Logger events for a canonical CID. */
function hashLoggerCid(cid: string): string {
    assertCanonicalCid(cid, 'cid');
    return `0x${bytesToHex(keccak_256(new TextEncoder().encode(cid)))}`;
}

/** Returns null for unrelated logs; malformed matching Logger events throw. */
function decodeLoggerEvent(log: LoggerEventInput, loggerContract: string): LoggerEvent | null {
    const expectedAddress = parseBytes(loggerContract, 'loggerContract', 20);
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
    if (log.topics.length !== 3) {
        throw new Error('Logger event must have exactly three topics.');
    }
    const nodeTopic = parseBytes(log.topics[1], 'log.topics[1]', 32);
    if (nodeTopic.slice(2, 26) !== '0'.repeat(24)) {
        throw new Error('Logger event node address must have zero padding.');
    }
    const cidKeccak256Hash = parseBytes(log.topics[2], 'log.topics[2]', 32);
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
    if (hashLoggerCid(cid).toLowerCase() !== cidKeccak256Hash.toLowerCase()) {
        throw new Error('Logger event cidKeccak256Hash must match its canonical CID.');
    }
    return {
        node: `0x${nodeTopic.slice(26)}`,
        cidKeccak256Hash,
        cid,
        ...(log.removed === undefined ? {} : { removed: log.removed }),
    };
}

async function logCid(
    cid: string,
    {
        config, fetch, loggerContract, nodeAddress, transactionPreparer,
        timeoutMs, pollIntervalMs, id, signal,
    }: LogCidOptions
): Promise<LogCidResult> {
    const data = encodeLoggerCall(cid);
    const to = parseBytes(loggerContract, 'loggerContract', 20);
    const node = parseBytes(nodeAddress, 'nodeAddress', 20);
    const rpcConfig = createHttpConfig(config);
    const deadlineMs = assertTimerMs(timeoutMs, 'timeoutMs');
    const pollDelayMs = assertTimerMs(pollIntervalMs, 'pollIntervalMs');
    const requestId = normalizeJsonRpcId(id);
    if (typeof fetch !== 'function' || typeof transactionPreparer !== 'function') {
        throw new TypeError('fetch and transactionPreparer must be functions.');
    }
    const cancellation = signal === undefined ? {} : { signal };
    const abortMessage = 'logCid was aborted by the caller.';
    let stage: TransactionStage = 'prepare';
    let transactionHash: string | null = null;
    let receipt: EthereumTransactionReceipt | null = null;
    try {
        throwIfSignalAborted(signal, abortMessage, signal?.reason);
        const prepared = await invokeWithAbort(
            async () => await transactionPreparer(Object.freeze({ to, data, value: 0n, ...cancellation })),
            signal
        );
        if (!isPlainObject(prepared)) {
            throw new TypeError('transactionPreparer must return a plain object.');
        }
        transactionHash = parseBytes(prepared.transactionHash, 'transactionHash', 32);
        const rawTransaction = assertHexData(prepared.rawTransaction, 'rawTransaction');
        throwIfSignalAborted(signal, abortMessage, signal?.reason);

        stage = 'submit';
        await ethSendRawTransaction({
            config: rpcConfig, fetch, rawTransaction, transactionHash, id: requestId, ...cancellation,
        });

        stage = 'receipt';
        const observed = await ethWaitForTransactionReceipt({
            config: rpcConfig, fetch, transactionHash, id: requestId,
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

export { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid, logCid, LogCidError };
export type {
    LoggerEventInput, LoggerEvent,
    LogCidOptions, LogCidResult,
};
