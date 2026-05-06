import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import { EthereumJsonRpcError } from './request-utils.js';
interface EthSendRawTransactionOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    rawTransaction: string;
    transactionHash?: string;
    id?: string | number;
    signal?: AbortSignal;
}
interface EthSendRawTransactionResult {
    readonly transactionHash: string;
    readonly attemptCount: number;
    readonly recovered: boolean;
    readonly response: unknown;
    readonly recoveryAttemptCount?: number;
    readonly recoveryResponse?: unknown;
}
interface EthereumRawTransactionRecoveryErrorOptions {
    transactionHash: string | null;
    originalError: EthereumJsonRpcError;
    recoveryError?: unknown;
}
declare class EthereumRawTransactionRecoveryError extends Error {
    readonly transactionHash: string | null;
    readonly originalError: EthereumJsonRpcError;
    readonly recoveryError?: unknown;
    constructor(message: string, { transactionHash, originalError, recoveryError, }: EthereumRawTransactionRecoveryErrorOptions);
}
declare function ethSendRawTransaction({ config, fetch, rawTransaction, transactionHash, id, signal, }: EthSendRawTransactionOptions): Promise<EthSendRawTransactionResult>;
export { EthereumRawTransactionRecoveryError, ethSendRawTransaction, };
export type { EthSendRawTransactionOptions, EthSendRawTransactionResult, };
