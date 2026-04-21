export interface CreateIpfsPublishConfigOptions {
    apiUrl: string;
    headers: Record<string, unknown>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}

export interface IpfsPublishConfig {
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
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
}

function assertHeadersObject(headers: unknown, label: string): Readonly<Record<string, string>> {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error(`${label} must be an object.`);
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (String(key).toLowerCase() === 'content-type') {
            throw new Error(`${label} must not include content-type.`);
        }
        normalized[String(key)] = String(value);
    }
    return normalized;
}

function createIpfsPublishConfig({
    apiUrl,
    headers,
    timeoutMs,
    maxRetries,
    retryDelayMs,
}: Partial<CreateIpfsPublishConfigOptions> = {}): IpfsPublishConfig {
    return Object.freeze({
        apiUrl: assertNonEmptyString(apiUrl, 'config.apiUrl').replace(/\/+$/, ''),
        headers: assertHeadersObject(headers, 'config.headers'),
        timeoutMs: assertPositiveInteger(timeoutMs, 'config.timeoutMs'),
        maxRetries: assertNonNegativeInteger(maxRetries, 'config.maxRetries'),
        retryDelayMs: assertNonNegativeInteger(retryDelayMs, 'config.retryDelayMs'),
    });
}

export { createIpfsPublishConfig };
