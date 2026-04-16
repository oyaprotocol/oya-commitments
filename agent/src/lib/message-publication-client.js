import { buildSignedPublishedMessagePayload } from './signed-published-message.js';

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('message publication baseUrl must be a non-empty string.');
    }
    return value.trim().replace(/\/+$/, '');
}

function resolveMessagePublicationBaseUrl({
    config,
    baseUrl = undefined,
    scheme = 'http',
} = {}) {
    if (baseUrl) {
        return normalizeBaseUrl(baseUrl);
    }
    const host = config?.messagePublishApiHost;
    const port = Number(config?.messagePublishApiPort);
    if (typeof host !== 'string' || !host.trim()) {
        throw new Error(
            'message publication base URL is unavailable; configure messagePublishApi.host or pass baseUrl explicitly.'
        );
    }
    if (!Number.isInteger(port) || port < 1) {
        throw new Error(
            'message publication base URL is unavailable; configure messagePublishApi.port or pass baseUrl explicitly.'
        );
    }
    return `${scheme}://${host.trim()}:${port}`;
}

function parseTimeoutMs(value, fallbackMs = 10_000) {
    if (value === undefined || value === null || value === '') {
        return fallbackMs;
    }
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < 1) {
        throw new Error('message publication timeoutMs must be a positive integer.');
    }
    return normalized;
}

async function signPublishedMessage({
    walletClient,
    account,
    message,
    timestampMs = Date.now(),
} = {}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error('message publication requires walletClient.signMessage().');
    }
    if (!account?.address) {
        throw new Error('message publication requires a signer account address.');
    }
    const normalizedTimestampMs = Number(timestampMs);
    if (!Number.isInteger(normalizedTimestampMs)) {
        throw new Error('message publication timestampMs must be an integer.');
    }
    const payload = buildSignedPublishedMessagePayload({
        address: account.address,
        timestampMs: normalizedTimestampMs,
        message,
    });
    const signature = await walletClient.signMessage({
        account,
        message: payload,
    });
    return {
        payload,
        signature,
        timestampMs: normalizedTimestampMs,
    };
}

async function publishSignedMessage({
    walletClient,
    account,
    config,
    message,
    bearerToken = undefined,
    baseUrl = undefined,
    timeoutMs = undefined,
    fetchFn = globalThis.fetch,
} = {}) {
    if (typeof fetchFn !== 'function') {
        throw new Error('message publication requires fetch().');
    }

    const { payload, signature, timestampMs } = await signPublishedMessage({
        walletClient,
        account,
        message,
        timestampMs: Date.now(),
    });
    const resolvedBaseUrl = resolveMessagePublicationBaseUrl({ config, baseUrl });
    const endpoint = `${resolvedBaseUrl}/v1/messages/publish`;
    const requestTimeoutMs = parseTimeoutMs(timeoutMs);
    const headers = {
        'Content-Type': 'application/json',
    };
    if (typeof bearerToken === 'string' && bearerToken.trim()) {
        headers.Authorization = `Bearer ${bearerToken.trim()}`;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
    let response;
    let raw;
    try {
        response = await fetchFn(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                message,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
            signal: abortController.signal,
        });
        raw = await response.text();
    } finally {
        clearTimeout(timeout);
    }

    let parsed;
    try {
        parsed = raw ? JSON.parse(raw) : {};
    } catch {
        parsed = { raw };
    }

    return {
        endpoint,
        payload,
        response: parsed,
        signature,
        status: response.status,
        ok: response.ok,
        timestampMs,
    };
}

export {
    publishSignedMessage,
    resolveMessagePublicationBaseUrl,
    signPublishedMessage,
};
