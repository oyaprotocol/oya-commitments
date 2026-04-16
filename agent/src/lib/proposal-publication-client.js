import { buildSignedProposalPayload } from './signed-proposal.js';

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('proposal publication baseUrl must be a non-empty string.');
    }
    return value.trim().replace(/\/+$/, '');
}

function resolveProposalPublicationBaseUrl({
    config,
    baseUrl = undefined,
    scheme = 'http',
} = {}) {
    if (baseUrl) {
        return normalizeBaseUrl(baseUrl);
    }
    const host = config?.proposalPublishApiHost;
    const port = Number(config?.proposalPublishApiPort);
    if (typeof host !== 'string' || !host.trim()) {
        throw new Error(
            'proposal publication base URL is unavailable; configure proposalPublishApi.host or pass baseUrl explicitly.'
        );
    }
    if (!Number.isInteger(port) || port < 1) {
        throw new Error(
            'proposal publication base URL is unavailable; configure proposalPublishApi.port or pass baseUrl explicitly.'
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
        throw new Error('proposal publication timeoutMs must be a positive integer.');
    }
    return normalized;
}

async function signPublishedProposal({
    walletClient,
    account,
    proposal,
    timestampMs = Date.now(),
} = {}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error('proposal publication requires walletClient.signMessage().');
    }
    if (!account?.address) {
        throw new Error('proposal publication requires a signer account address.');
    }
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
        throw new Error('proposal publication requires a proposal object.');
    }
    const normalizedTimestampMs = Number(timestampMs);
    if (!Number.isInteger(normalizedTimestampMs)) {
        throw new Error('proposal publication timestampMs must be an integer.');
    }
    const payload = buildSignedProposalPayload({
        address: account.address,
        chainId: proposal.chainId,
        timestampMs: normalizedTimestampMs,
        requestId: proposal.requestId,
        commitmentSafe: proposal.commitmentSafe,
        ogModule: proposal.ogModule,
        transactions: proposal.transactions,
        explanation: proposal.explanation,
        metadata: proposal.metadata,
        deadline: proposal.deadline,
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

async function publishSignedProposal({
    walletClient,
    account,
    config,
    proposal,
    bearerToken = undefined,
    baseUrl = undefined,
    timeoutMs = undefined,
    fetchFn = globalThis.fetch,
} = {}) {
    if (typeof fetchFn !== 'function') {
        throw new Error('proposal publication requires fetch().');
    }

    const { payload, signature, timestampMs } = await signPublishedProposal({
        walletClient,
        account,
        proposal,
        timestampMs: Date.now(),
    });
    const resolvedBaseUrl = resolveProposalPublicationBaseUrl({ config, baseUrl });
    const endpoint = `${resolvedBaseUrl}/v1/proposals/publish`;
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
                chainId: proposal.chainId,
                requestId: proposal.requestId,
                commitmentSafe: proposal.commitmentSafe,
                ogModule: proposal.ogModule,
                transactions: proposal.transactions,
                explanation: proposal.explanation,
                ...(proposal.metadata !== undefined ? { metadata: proposal.metadata } : {}),
                ...(proposal.deadline !== undefined ? { deadline: proposal.deadline } : {}),
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
    publishSignedProposal,
    resolveProposalPublicationBaseUrl,
    signPublishedProposal,
};
