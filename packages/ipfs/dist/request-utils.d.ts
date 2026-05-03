import { combineAbortSignals, createTimeoutSignal, invokeWithAbort, throwIfSignalAborted, waitForRetryDelay } from '@oyaprotocol/utils';
import type { AbortSignalHandle } from '@oyaprotocol/utils';
interface IpfsHttpErrorOptions {
    status: number;
    responseText?: string;
}
interface IpfsOperationErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}
declare class IpfsHttpError extends Error {
    readonly status: number;
    readonly responseText: string | undefined;
    constructor(message: string, { status, responseText }: IpfsHttpErrorOptions);
}
declare function shouldRetryError(error: unknown): boolean;
declare function normalizeIpfsOperationError(error: unknown, messages: IpfsOperationErrorMessages): Error;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, IpfsHttpError, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
export type { AbortSignalHandle, IpfsOperationErrorMessages };
