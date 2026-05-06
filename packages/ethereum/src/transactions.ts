import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import {
    assertBytes32HexString,
    assertHexData,
    isPlainObject,
} from '@oyaprotocol/utils';

import {
    EthereumJsonRpcError,
    requestEthereumJsonRpc,
    requestEthereumJsonRpcWithCustomRetryPolicy,
} from './request-utils.js';
import type { RequestEthereumJsonRpcOptions } from './request-utils.js';

const RAW_TRANSACTION_DUPLICATE_MESSAGES = [
    'already known',
    'known transaction',
    'already imported',
    'already exists',
    'already in mempool',
    'nonce too low',
];

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

class EthereumRawTransactionRecoveryError extends Error {
    readonly transactionHash: string | null;
    readonly originalError: EthereumJsonRpcError;
    readonly recoveryError?: unknown;

    constructor(
        message: string,
        {
            transactionHash,
            originalError,
            recoveryError,
        }: EthereumRawTransactionRecoveryErrorOptions
    ) {
        super(message, { cause: recoveryError ?? originalError });
        this.name = 'EthereumRawTransactionRecoveryError';
        this.transactionHash = transactionHash;
        this.originalError = originalError;
        if (recoveryError !== undefined) {
            this.recoveryError = recoveryError;
        }
    }
}

function isDuplicateRawTransactionError(error: unknown): error is EthereumJsonRpcError {
    if (!(error instanceof EthereumJsonRpcError)) {
        return false;
    }
    if (error.method !== 'eth_sendRawTransaction' || error.attemptCount <= 1) {
        return false;
    }
    const message = error.message.toLowerCase();
    return RAW_TRANSACTION_DUPLICATE_MESSAGES.some((text) => message.includes(text));
}

function transactionLookupMatchesHash(result: unknown, transactionHash: string): boolean {
    if (!isPlainObject(result)) {
        return false;
    }
    if (typeof result.hash !== 'string') {
        return false;
    }
    return (
        assertBytes32HexString(result.hash, 'transaction.hash').toLowerCase() ===
        transactionHash.toLowerCase()
    );
}

function createJsonRpcOptions({
    config,
    fetch,
    method,
    params,
    id,
    signal,
}: {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    method: string;
    params: readonly unknown[];
    id: string | number | undefined;
    signal: AbortSignal | undefined;
}): RequestEthereumJsonRpcOptions {
    return {
        config,
        fetch,
        method,
        params,
        ...(id === undefined ? {} : { id }),
        ...(signal === undefined ? {} : { signal }),
    };
}

function isRawTransactionMethod(method: string): boolean {
    return method === 'eth_sendRawTransaction';
}

async function recoverRawTransactionSubmission({
    config,
    fetch,
    transactionHash,
    id,
    signal,
    originalError,
}: {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    transactionHash: string | null;
    id: string | number | undefined;
    signal: AbortSignal | undefined;
    originalError: EthereumJsonRpcError;
}): Promise<EthSendRawTransactionResult> {
    if (transactionHash === null) {
        throw new EthereumRawTransactionRecoveryError(
            'eth_sendRawTransaction may have been accepted before a retry returned a duplicate transaction error; provide transactionHash to verify acceptance.',
            {
                transactionHash,
                originalError,
            }
        );
    }

    try {
        const lookup = await requestEthereumJsonRpc(
            createJsonRpcOptions({
                config,
                fetch,
                method: 'eth_getTransactionByHash',
                params: [transactionHash],
                id,
                signal,
            })
        );

        if (!transactionLookupMatchesHash(lookup.result, transactionHash)) {
            throw new EthereumRawTransactionRecoveryError(
                'eth_sendRawTransaction may have been accepted, but eth_getTransactionByHash did not confirm the supplied transactionHash.',
                {
                    transactionHash,
                    originalError,
                }
            );
        }

        return {
            transactionHash,
            attemptCount: originalError.attemptCount,
            recovered: true,
            response: originalError.response,
            recoveryAttemptCount: lookup.attemptCount,
            recoveryResponse: lookup.response,
        };
    } catch (error) {
        if (error instanceof EthereumRawTransactionRecoveryError) {
            throw error;
        }
        throw new EthereumRawTransactionRecoveryError(
            'eth_sendRawTransaction may have been accepted, but transaction hash recovery failed.',
            {
                transactionHash,
                originalError,
                recoveryError: error,
            }
        );
    }
}

async function ethSendRawTransaction({
    config,
    fetch,
    rawTransaction,
    transactionHash,
    id,
    signal,
}: EthSendRawTransactionOptions): Promise<EthSendRawTransactionResult> {
    const validatedRawTransaction = assertHexData(rawTransaction, 'rawTransaction');
    const validatedTransactionHash =
        transactionHash === undefined
            ? null
            : assertBytes32HexString(transactionHash, 'transactionHash');

    try {
        const result = await requestEthereumJsonRpcWithCustomRetryPolicy<string>(
            createJsonRpcOptions({
                config,
                fetch,
                method: 'eth_sendRawTransaction',
                params: [validatedRawTransaction],
                id,
                signal,
            }),
            isRawTransactionMethod
        );
        const returnedTransactionHash = assertBytes32HexString(result.result, 'result');

        if (
            validatedTransactionHash !== null &&
            returnedTransactionHash.toLowerCase() !== validatedTransactionHash.toLowerCase()
        ) {
            throw new Error(
                'eth_sendRawTransaction returned a transaction hash that did not match transactionHash.'
            );
        }

        return {
            transactionHash: returnedTransactionHash,
            attemptCount: result.attemptCount,
            recovered: false,
            response: result.response,
        };
    } catch (error) {
        if (!isDuplicateRawTransactionError(error)) {
            throw error;
        }
        return await recoverRawTransactionSubmission({
            config,
            fetch,
            transactionHash: validatedTransactionHash,
            id,
            signal,
            originalError: error,
        });
    }
}

export {
    EthereumRawTransactionRecoveryError,
    ethSendRawTransaction,
};
export type {
    EthSendRawTransactionOptions,
    EthSendRawTransactionResult,
};
