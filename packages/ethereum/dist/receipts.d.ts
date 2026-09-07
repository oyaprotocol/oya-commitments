import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import type { EthereumTransactionReceipt } from './receipt-utils.js';
interface EthGetTransactionReceiptOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    transactionHash: string;
    id?: string | number;
    signal?: AbortSignal;
}
interface EthGetTransactionReceiptResult {
    readonly receipt: EthereumTransactionReceipt | null;
    readonly attemptCount: number;
    readonly response: unknown;
}
interface EthWaitForTransactionReceiptOptions extends EthGetTransactionReceiptOptions {
    /** Overall deadline, including requests, retries, and poll delays. */
    timeoutMs: number;
    pollIntervalMs: number;
}
interface EthWaitForTransactionReceiptResult {
    readonly receipt: EthereumTransactionReceipt;
    readonly pollCount: number;
    /** Total HTTP attempts across all completed lookups. */
    readonly attemptCount: number;
    readonly response: unknown;
}
declare class EthereumTransactionReceiptTimeoutError extends Error {
    readonly transactionHash: string;
    readonly timeoutMs: number;
    readonly pollCount: number;
    constructor(transactionHash: string, timeoutMs: number, pollCount: number, options?: ErrorOptions);
}
declare function ethGetTransactionReceipt({ config, fetch, transactionHash, id, signal, }: EthGetTransactionReceiptOptions): Promise<EthGetTransactionReceiptResult>;
declare function ethWaitForTransactionReceipt({ config, fetch, transactionHash, id, signal, timeoutMs, pollIntervalMs, }: EthWaitForTransactionReceiptOptions): Promise<EthWaitForTransactionReceiptResult>;
export { EthereumTransactionReceiptTimeoutError, ethGetTransactionReceipt, ethWaitForTransactionReceipt };
export type { EthGetTransactionReceiptOptions, EthGetTransactionReceiptResult, EthWaitForTransactionReceiptOptions, EthWaitForTransactionReceiptResult, };
