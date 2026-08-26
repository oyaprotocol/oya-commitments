import { isPlainObject } from '@oyaprotocol/utils';
import { SignedMessageAuthorizationError } from './authorization.js';
import { SignedMessageVerificationError } from './ethereum-signature.js';
import { SignedMessageValidationError } from './schema.js';
const OPTION_FIELDS = new Set([
    'authorize',
    'maxBodyBytes',
    'maxTextBytes',
]);
const REQUEST_FIELDS = new Set([
    'method',
    'contentType',
    'body',
]);
const JSON_CONTENT_TYPE_PATTERN = /^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*)?$/i;
function requirePlainObject(value, containerName) {
    if (!isPlainObject(value)) {
        throw new TypeError(`${containerName} must be a plain object.`);
    }
}
function requireOnlyFields(value, allowedFields, containerName) {
    for (const field of Reflect.ownKeys(value)) {
        if (!allowedFields.has(field)) {
            const label = typeof field === 'symbol' ? field.toString() : field;
            throw new TypeError(`Unsupported ${containerName} field: ${label}.`);
        }
    }
}
function requireOwnFields(value, fields, containerName) {
    for (const field of fields) {
        if (!Object.hasOwn(value, field)) {
            throw new TypeError(`${containerName}.${field} is required.`);
        }
    }
}
function requirePositiveInteger(value, fieldName) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${fieldName} must be a positive integer.`);
    }
    return value;
}
function validateOptions(options) {
    requirePlainObject(options, 'options');
    requireOnlyFields(options, OPTION_FIELDS, 'options');
    requireOwnFields(options, ['authorize', 'maxBodyBytes', 'maxTextBytes'], 'options');
    if (typeof options.authorize !== 'function') {
        throw new TypeError('options.authorize must be a function.');
    }
    return {
        authorize: options.authorize,
        maxBodyBytes: requirePositiveInteger(options.maxBodyBytes, 'options.maxBodyBytes'),
        maxTextBytes: requirePositiveInteger(options.maxTextBytes, 'options.maxTextBytes'),
    };
}
function validateRequest(request) {
    requirePlainObject(request, 'request');
    requireOnlyFields(request, REQUEST_FIELDS, 'request');
    requireOwnFields(request, ['method', 'contentType', 'body'], 'request');
    if (typeof request.method !== 'string') {
        throw new TypeError('request.method must be a string.');
    }
    if (request.contentType !== undefined &&
        typeof request.contentType !== 'string') {
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
function createRejection(status, code, message, details) {
    const body = Object.freeze({
        error: message,
        code,
        ...(details === undefined
            ? {}
            : { details: Object.freeze({ ...details }) }),
    });
    return Object.freeze({ status, body });
}
function createHttpRejection(status, code, message) {
    return createRejection(status, code, message);
}
function isMappableSignedMessageError(error) {
    return (error instanceof SignedMessageValidationError ||
        error instanceof SignedMessageVerificationError ||
        error instanceof SignedMessageAuthorizationError);
}
function hasOwnStringText(value) {
    return (value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        Object.hasOwn(value, 'text') &&
        typeof value.text === 'string');
}
function handleSignedMessage(request, options) {
    const validatedOptions = validateOptions(options);
    const validatedRequest = validateRequest(request);
    if (validatedRequest.method !== 'POST') {
        return createHttpRejection(405, 'method_not_allowed', 'Method must be POST.');
    }
    if (validatedRequest.contentType === undefined ||
        !JSON_CONTENT_TYPE_PATTERN.test(validatedRequest.contentType)) {
        return createHttpRejection(415, 'unsupported_content_type', 'Content-Type must be application/json with optional charset=utf-8.');
    }
    if (validatedRequest.body.byteLength > validatedOptions.maxBodyBytes) {
        return createHttpRejection(413, 'body_too_large', 'Request body exceeds the configured byte limit.');
    }
    let parsedValue;
    try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(validatedRequest.body);
        parsedValue = JSON.parse(json);
    }
    catch {
        return createHttpRejection(400, 'invalid_json', 'Request body must be valid UTF-8 JSON.');
    }
    if (hasOwnStringText(parsedValue) &&
        new TextEncoder().encode(parsedValue.text).byteLength >
            validatedOptions.maxTextBytes) {
        return createHttpRejection(413, 'text_too_large', 'text exceeds the configured byte limit.');
    }
    let message;
    try {
        message = validatedOptions.authorize(parsedValue);
    }
    catch (error) {
        if (!isMappableSignedMessageError(error)) {
            throw error;
        }
        const status = error instanceof SignedMessageValidationError
            ? 400
            : error instanceof SignedMessageVerificationError
                ? 401
                : 403;
        return createRejection(status, error.code, error.message, error instanceof SignedMessageValidationError
            ? error.details
            : undefined);
    }
    const acceptedMessage = Object.freeze({
        text: message.text,
        signer: message.signer,
        signature: message.signature,
    });
    const body = Object.freeze({
        status: 'accepted',
        signer: acceptedMessage.signer,
    });
    return Object.freeze({
        status: 202,
        body,
        message: acceptedMessage,
    });
}
export { handleSignedMessage };
//# sourceMappingURL=ingress.js.map