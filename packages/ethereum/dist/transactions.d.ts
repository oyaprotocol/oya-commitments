import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import { EthereumJsonRpcError } from './request-utils.js';
/** Call intent; the host supplies chain, nonce, gas, fees, and signing. */
interface TransactionRequest {
    readonly to: string;
    readonly data: string;
    /** Native currency amount in wei. */
    readonly value: bigint;
    readonly signal?: AbortSignal;
}
interface SignedTransaction {
    readonly rawTransaction: string;
    readonly transactionHash: string;
}
/** Fully specified EIP-1559 call with an empty access list. */
interface UnsignedTransaction extends Omit<TransactionRequest, 'signal'> {
    readonly type: 2;
    readonly chainId: bigint;
    /** Nonces outside the safe integer range are rejected before signing. */
    readonly nonce: number;
    readonly gasLimit: bigint;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
}
interface TransactionSigner {
    /** Account signing the outer Ethereum transaction. */
    readonly address: string;
    /** Preserve all supplied fields and sign without broadcasting. */
    signTransaction(transaction: Readonly<UnsignedTransaction>, signal?: AbortSignal): SignedTransaction | PromiseLike<SignedTransaction>;
}
/** Prepare and sign the requested call without broadcasting it. */
type TransactionPreparer = (request: TransactionRequest) => SignedTransaction | PromiseLike<SignedTransaction>;
/** Verify covers operation-specific checks after receipt observation. */
type TransactionStage = 'prepare' | 'submit' | 'receipt' | 'verify';
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
export type { TransactionRequest, SignedTransaction, UnsignedTransaction, TransactionSigner, TransactionPreparer, TransactionStage, EthSendRawTransactionOptions, EthSendRawTransactionResult, };
