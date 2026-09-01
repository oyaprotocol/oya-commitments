import { isPlainObject } from '@oyaprotocol/utils';

import { SignedMessageAuthorizationError } from './authorization.js';
import type { SignedMessageAuthorizer } from './authorization.js';
import { SignedMessageVerificationError } from './ethereum-signature.js';
import { SignedMessageValidationError } from './schema.js';
import type { SignedMessageInput } from './schema.js';

const OPTION_FIELDS = new Set<PropertyKey>([
    'authorize',
    'maxBodyBytes',
    'maxTextBytes',
    'onAcceptedMessage',
]);
const REQUEST_FIELDS = new Set<PropertyKey>([
    'method',
    'contentType',
    'body',
]);
const JSON_CONTENT_TYPE_PATTERN =
    /^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*)?$/i;

interface HandleSignedMessageRequest {
    readonly method: string;
    readonly contentType: string | undefined;
    readonly body: Uint8Array;
}

type AcceptedSignedMessageHandler<TResult = unknown> = (
    message: Readonly<SignedMessageInput>
) => TResult | PromiseLike<TResult>;

interface HandleSignedMessageBaseOptions {
    readonly authorize: SignedMessageAuthorizer;
    readonly maxBodyBytes: number;
    readonly maxTextBytes: number;
}

interface HandleSignedMessageOptions extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage?: undefined;
}

interface HandleSignedMessageOptionsWithHandler<TResult>
    extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage: AcceptedSignedMessageHandler<TResult>;
}

interface HandleSignedMessageOptionsWithOptionalHandler<TResult>
    extends HandleSignedMessageBaseOptions {
    readonly onAcceptedMessage?:
        | AcceptedSignedMessageHandler<TResult>
        | undefined;
}

interface AcceptedSignedMessage {
    readonly status: 202;
    readonly body: Readonly<{
        status: 'accepted';
        signer: string;
    }>;
    readonly message: Readonly<SignedMessageInput>;
}

interface AcceptedSignedMessageWithHandler<TResult>
    extends AcceptedSignedMessage {
    readonly handleSignedMessageResult: TResult;
}

interface RejectedSignedMessage {
    readonly status: 400 | 401 | 403 | 405 | 413 | 415;
    readonly body: Readonly<{
        error: string;
        code: string;
        details?: Readonly<Record<string, unknown>>;
    }>;
}

type HandleSignedMessageResult<TResult = never> =
    | RejectedSignedMessage
    | ([TResult] extends [never]
          ? AcceptedSignedMessage
          : AcceptedSignedMessageWithHandler<Awaited<TResult>>);

function requirePlainObject(
    value: unknown,
    containerName: 'options' | 'request'
): asserts value is Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new TypeError(`${containerName} must be a plain object.`);
    }
}

function requireOnlyFields(
    value: Record<string, unknown>,
    allowedFields: ReadonlySet<PropertyKey>,
    containerName: 'options' | 'request'
): void {
    for (const field of Reflect.ownKeys(value)) {
        if (!allowedFields.has(field)) {
            const label = typeof field === 'symbol' ? field.toString() : field;
            throw new TypeError(`Unsupported ${containerName} field: ${label}.`);
        }
    }
}

function requireOwnFields(
    value: Record<string, unknown>,
    fields: readonly string[],
    containerName: 'options' | 'request'
): void {
    for (const field of fields) {
        if (!Object.hasOwn(value, field)) {
            throw new TypeError(`${containerName}.${field} is required.`);
        }
    }
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${fieldName} must be a positive integer.`);
    }
    return value;
}

function validateOptions<TResult>(
    options: unknown
): HandleSignedMessageOptionsWithOptionalHandler<TResult> {
    requirePlainObject(options, 'options');
    requireOnlyFields(
        options,
        OPTION_FIELDS,
        'options'
    );
    requireOwnFields(
        options,
        ['authorize', 'maxBodyBytes', 'maxTextBytes'],
        'options'
    );

    if (typeof options.authorize !== 'function') {
        throw new TypeError('options.authorize must be a function.');
    }
    const onAcceptedMessage = options.onAcceptedMessage;
    if (
        onAcceptedMessage !== undefined &&
        typeof onAcceptedMessage !== 'function'
    ) {
        throw new TypeError(
            'options.onAcceptedMessage must be a function or undefined.'
        );
    }

    return {
        authorize: options.authorize as SignedMessageAuthorizer,
        maxBodyBytes: requirePositiveInteger(
            options.maxBodyBytes,
            'options.maxBodyBytes'
        ),
        maxTextBytes: requirePositiveInteger(
            options.maxTextBytes,
            'options.maxTextBytes'
        ),
        ...(onAcceptedMessage === undefined
            ? {}
            : {
                  onAcceptedMessage:
                      onAcceptedMessage as AcceptedSignedMessageHandler<TResult>,
              }),
    };
}

function validateRequest(request: unknown): HandleSignedMessageRequest {
    requirePlainObject(request, 'request');
    requireOnlyFields(
        request,
        REQUEST_FIELDS,
        'request'
    );
    requireOwnFields(request, ['method', 'contentType', 'body'], 'request');

    if (typeof request.method !== 'string') {
        throw new TypeError('request.method must be a string.');
    }
    if (
        request.contentType !== undefined &&
        typeof request.contentType !== 'string'
    ) {
        throw new TypeError('request.contentType must be a string or undefined.');
    }
    if (!(request.body instanceof Uint8Array)) {
        throw new TypeError('request.body must be a Uint8Array.');
    }

    return {
        method: request.method,
        contentType: request.contentType,
        body: request.body,
    };
}

function createRejection(
    status: RejectedSignedMessage['status'],
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>
): RejectedSignedMessage {
    const body = Object.freeze({
        error: message,
        code,
        ...(details === undefined
            ? {}
            : { details: Object.freeze({ ...details }) }),
    });
    return Object.freeze({ status, body });
}

function createHttpRejection(
    status: 405 | 413 | 415 | 400,
    code:
        | 'method_not_allowed'
        | 'unsupported_content_type'
        | 'body_too_large'
        | 'invalid_json'
        | 'text_too_large',
    message: string
): RejectedSignedMessage {
    return createRejection(status, code, message);
}

function isMappableSignedMessageError(
    error: unknown
): error is
    | SignedMessageValidationError
    | SignedMessageVerificationError
    | SignedMessageAuthorizationError {
    return (
        error instanceof SignedMessageValidationError ||
        error instanceof SignedMessageVerificationError ||
        error instanceof SignedMessageAuthorizationError
    );
}

function hasOwnStringText(
    value: unknown
): value is { readonly text: string } {
    return (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        Object.hasOwn(value, 'text') &&
        typeof (value as { readonly text?: unknown }).text === 'string'
    );
}

function handleSignedMessage(
    request: HandleSignedMessageRequest,
    options: HandleSignedMessageOptions
): Promise<HandleSignedMessageResult>;
function handleSignedMessage<TResult>(
    request: HandleSignedMessageRequest,
    options: HandleSignedMessageOptionsWithHandler<TResult>
): Promise<HandleSignedMessageResult<TResult>>;
function handleSignedMessage<TResult>(
    request: HandleSignedMessageRequest,
    options: HandleSignedMessageOptionsWithOptionalHandler<TResult>
): Promise<HandleSignedMessageResult | HandleSignedMessageResult<TResult>>;
async function handleSignedMessage<TResult>(
    request: HandleSignedMessageRequest,
    options: HandleSignedMessageOptionsWithOptionalHandler<TResult>
): Promise<HandleSignedMessageResult | HandleSignedMessageResult<TResult>> {
    const validatedOptions = validateOptions<TResult>(options);
    const validatedRequest = validateRequest(request);

    if (validatedRequest.method !== 'POST') {
        return createHttpRejection(
            405,
            'method_not_allowed',
            'Method must be POST.'
        );
    }

    if (
        validatedRequest.contentType === undefined ||
        !JSON_CONTENT_TYPE_PATTERN.test(validatedRequest.contentType)
    ) {
        return createHttpRejection(
            415,
            'unsupported_content_type',
            'Content-Type must be application/json with optional charset=utf-8.'
        );
    }

    if (validatedRequest.body.byteLength > validatedOptions.maxBodyBytes) {
        return createHttpRejection(
            413,
            'body_too_large',
            'Request body exceeds the configured byte limit.'
        );
    }

    let parsedValue: unknown;
    try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(
            validatedRequest.body
        );
        parsedValue = JSON.parse(json) as unknown;
    } catch {
        return createHttpRejection(
            400,
            'invalid_json',
            'Request body must be valid UTF-8 JSON.'
        );
    }

    if (
        hasOwnStringText(parsedValue) &&
        new TextEncoder().encode(parsedValue.text).byteLength >
            validatedOptions.maxTextBytes
    ) {
        return createHttpRejection(
            413,
            'text_too_large',
            'text exceeds the configured byte limit.'
        );
    }

    let message: Readonly<SignedMessageInput>;
    try {
        message = validatedOptions.authorize(parsedValue);
    } catch (error) {
        if (!isMappableSignedMessageError(error)) {
            throw error;
        }
        const status =
            error instanceof SignedMessageValidationError
                ? 400
                : error instanceof SignedMessageVerificationError
                  ? 401
                  : 403;
        return createRejection(
            status,
            error.code,
            error.message,
            error instanceof SignedMessageValidationError
                ? error.details
                : undefined
        );
    }

    const acceptedMessage = Object.freeze({
        text: message.text,
        signer: message.signer,
        signature: message.signature,
    });
    const body = Object.freeze({
        status: 'accepted' as const,
        signer: acceptedMessage.signer,
    });

    if (validatedOptions.onAcceptedMessage !== undefined) {
        const handleSignedMessageResult =
            await validatedOptions.onAcceptedMessage(acceptedMessage);
        return Object.freeze({
            status: 202 as const,
            body,
            message: acceptedMessage,
            handleSignedMessageResult,
        });
    }

    return Object.freeze({
        status: 202 as const,
        body,
        message: acceptedMessage,
    });
}

export { handleSignedMessage };
export type {
    AcceptedSignedMessageHandler,
    HandleSignedMessageOptions,
    HandleSignedMessageOptionsWithHandler,
    HandleSignedMessageOptionsWithOptionalHandler,
    HandleSignedMessageRequest,
    HandleSignedMessageResult,
};
