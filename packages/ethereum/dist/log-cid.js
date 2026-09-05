import { assertHexData, createHttpConfig, invokeWithAbort, isPlainObject, parseBytes, throwIfSignalAborted, } from '@oyaprotocol/utils';
import { decodeLoggerEvent, encodeLoggerCall } from './logger.js';
import { assertTimerMs, ethWaitForTransactionReceipt } from './receipts.js';
import { ethSendRawTransaction } from './transactions.js';
class LogCidError extends Error {
    cid;
    stage;
    /** Known before submission; its presence does not prove acceptance. */
    transactionHash;
    receipt;
    constructor(cid, stage, transactionHash, receipt, cause) {
        super(`Logging CID failed during ${stage}.`, { cause });
        this.name = 'LogCidError';
        this.cid = cid;
        this.stage = stage;
        this.transactionHash = transactionHash;
        this.receipt = receipt;
    }
}
async function logCid(cid, { config, fetch, loggerAddress, expectedNode, prepareTransaction, timeoutMs, pollIntervalMs, signal, }) {
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
    let stage = 'prepare';
    let transactionHash = null;
    let receipt = null;
    try {
        throwIfSignalAborted(signal, abortMessage, signal?.reason);
        const prepared = await invokeWithAbort(async () => await prepareTransaction(Object.freeze({ to, data, value: 0n, ...cancellation })), signal);
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
    }
    catch (cause) {
        throw new LogCidError(cid, stage, transactionHash, receipt, cause);
    }
}
export { logCid, LogCidError };
//# sourceMappingURL=log-cid.js.map