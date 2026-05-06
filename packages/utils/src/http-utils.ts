import {
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

interface CreateHttpConfigOptions {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

interface HttpConfig {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}

interface HttpPostFetchOptions<TBody> {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: TBody;
    signal?: AbortSignal | undefined;
}

interface HttpTextResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

interface HttpStatusErrorOptions {
    operation: string;
    status: number;
    statusText?: string;
    responseText?: string;
}

type HttpFetchLike<TOptions, TResponse> = (
    url: string,
    options: TOptions
) => Promise<TResponse>;

type HttpPostFetchLike<TBody, TResponse = HttpTextResponse> = HttpFetchLike<
    HttpPostFetchOptions<TBody>,
    TResponse
>;

const RETRYABLE_HTTP_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);

class HttpStatusError extends Error {
    readonly operation: string;
    readonly status: number;
    readonly statusText: string;
    readonly responseText: string | undefined;

    constructor({ operation, status, statusText, responseText }: HttpStatusErrorOptions) {
        const normalizedOperation = assertNonEmptyString(operation, 'operation');
        const normalizedStatus = assertPositiveInteger(status, 'status');
        const normalizedStatusText =
            typeof statusText === 'string' && statusText.trim()
                ? statusText.trim()
                : 'Unknown Status';
        super(`${normalizedOperation} failed with ${normalizedStatus} ${normalizedStatusText}.`);
        this.name = 'HttpStatusError';
        this.operation = normalizedOperation;
        this.status = normalizedStatus;
        this.statusText = normalizedStatusText;
        this.responseText = responseText;
    }
}

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

function createHttpConfig(
    { url, headers, timeoutMs, maxRetries, retryDelayMs }: CreateHttpConfigOptions,
    normalizeConfigUrl: (url: string) => string = normalizeUrl
): HttpConfig {
    const normalizedUrl = assertNonEmptyString(
        normalizeConfigUrl(assertNonEmptyString(url, 'config.url')),
        'config.url'
    );

    return Object.freeze({
        url: normalizedUrl,
        headers: assertHeadersObject(headers, 'config.headers', {
            disallowedNames: ['content-type'],
        }),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

function readErrorCodeChain(error: unknown): string[] {
    const values: string[] = [];
    let current: unknown = error;
    while (current && typeof current === 'object') {
        const value = (current as Record<string, unknown>).code;
        if (typeof value === 'string' && value) {
            values.push(value);
        }
        current = (current as Record<string, unknown>).cause;
    }
    return values;
}

function hasRetryableNetworkErrorCode(error: unknown): boolean {
    for (const code of readErrorCodeChain(error)) {
        if (RETRYABLE_HTTP_NETWORK_ERROR_CODES.has(code.toUpperCase())) {
            return true;
        }
    }
    return false;
}

export {
    HttpStatusError,
    RETRYABLE_HTTP_NETWORK_ERROR_CODES,
    createHttpConfig,
    hasRetryableNetworkErrorCode,
};
export type {
    CreateHttpConfigOptions,
    HttpConfig,
    HttpFetchLike,
    HttpPostFetchLike,
    HttpPostFetchOptions,
    HttpStatusErrorOptions,
    HttpTextResponse,
};
