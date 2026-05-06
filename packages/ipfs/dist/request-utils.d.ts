import { combineAbortSignals, createTimeoutSignal, invokeWithAbort, throwIfSignalAborted, waitForRetryDelay } from '@oyaprotocol/utils';
import type { AbortSignalHandle } from '@oyaprotocol/utils';
interface IpfsOperationErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}
declare function shouldRetryError(error: unknown): boolean;
declare function normalizeIpfsOperationError(error: unknown, messages: IpfsOperationErrorMessages): Error;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
export type { AbortSignalHandle, IpfsOperationErrorMessages };
