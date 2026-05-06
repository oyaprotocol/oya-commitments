import { invokeWithAbort, runWithRetry } from '@oyaprotocol/utils';
import type { AbortSignalHandle } from '@oyaprotocol/utils';
interface IpfsOperationErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}
declare function shouldRetryError(error: unknown): boolean;
declare function normalizeIpfsOperationError(error: unknown, messages: IpfsOperationErrorMessages): Error;
export { invokeWithAbort, normalizeIpfsOperationError, runWithRetry, shouldRetryError, };
export type { AbortSignalHandle, IpfsOperationErrorMessages };
