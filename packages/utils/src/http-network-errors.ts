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

export { RETRYABLE_HTTP_NETWORK_ERROR_CODES, hasRetryableNetworkErrorCode };
