export interface CreateIpfsConfigOptions {
    apiUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

export interface IpfsConfig {
    readonly apiUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}

function assertNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return value;
}

function assertHeadersObject(headers: unknown, label: string): Readonly<Record<string, string>> {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error(`${label} must be an object.`);
    }
    const validated: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === 'content-type') {
            throw new Error(`${label} must not include content-type.`);
        }
        if (typeof value !== 'string') {
            throw new Error(`${label}.${key} must be a string.`);
        }
        validated[key] = value;
    }
    return Object.freeze(validated);
}

function normalizeApiUrl(apiUrl: string): string {
    return apiUrl.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}

function createIpfsConfig({
    apiUrl,
    headers,
    timeoutMs,
    maxRetries,
    retryDelayMs,
}: CreateIpfsConfigOptions): IpfsConfig {
    return Object.freeze({
        apiUrl: normalizeApiUrl(assertNonEmptyString(apiUrl, 'config.apiUrl')),
        headers: assertHeadersObject(headers, 'config.headers'),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createIpfsConfig };
