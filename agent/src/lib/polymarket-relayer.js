import crypto from 'node:crypto';
import {
    encodeAbiParameters,
    encodePacked,
    getAddress,
    getCreate2Address,
    hashTypedData,
    isHex,
    keccak256,
    zeroAddress,
} from 'viem';
import { normalizeAddressOrNull, normalizeHashOrNull } from './utils.js';

const DEFAULT_RELAYER_HOST = 'https://relayer-v2.polymarket.com';
const DEFAULT_RELAYER_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RELAYER_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RELAYER_POLL_TIMEOUT_MS = 120_000;
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const PROXY_FACTORY_ADDRESS = SAFE_FACTORY_ADDRESS;
const SAFE_INIT_CODE_HASH =
    '0xb61d27f6f0f1579b6af9d23fafd567586f35f7d2f43d6bd5f85c0b690952d469';
const PROXY_INIT_CODE_HASH =
    '0x72ea4f5319066fd7435f2f2e1e8f117d0848fa51987edc76b4e2207ee3f1fe6f';
const CREATE_PROXY_DOMAIN_NAME = 'Polymarket Contract Proxy Factory';

const SAFE_EIP712_TYPES = Object.freeze({
    EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
    ],
    SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
    ],
});

const CREATE_PROXY_EIP712_TYPES = Object.freeze({
    CreateProxy: [
        { name: 'paymentToken', type: 'address' },
        { name: 'payment', type: 'uint256' },
        { name: 'paymentReceiver', type: 'address' },
    ],
});

const RELAYER_TX_TYPE = Object.freeze({
    SAFE: 'SAFE',
    PROXY: 'PROXY',
});

const RELAYER_ENDPOINTS = Object.freeze({
    ADDRESS: '/address',
    NONCE: '/nonce',
    RELAY_PAYLOAD: '/relay-payload',
    SUBMIT: '/submit',
    TRANSACTION: '/transaction',
    DEPLOYED: '/deployed',
});

const LEGACY_ENDPOINTS = Object.freeze({
    PROXY_ADDRESS: (address) => `/relayer/proxy-address/${encodeURIComponent(address)}`,
    PROXY_NONCE: (address) => `/relayer/proxy-nonce/${encodeURIComponent(address)}`,
    CREATE_PROXY: '/relayer/create-proxy-wallet',
    TRANSACTION: '/relayer/transaction',
    TRANSACTION_STATUS: (hash) => `/relayer/transaction-status/${encodeURIComponent(hash)}`,
});

const RELAYER_SUCCESS_STATES = new Set([
    'STATE_MINED',
    'STATE_CONFIRMED',
    'MINED',
    'CONFIRMED',
]);

const RELAYER_FAILURE_STATES = new Set([
    'STATE_FAILED',
    'STATE_INVALID',
    'FAILED',
    'REVERTED',
    'INVALID',
]);

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function normalizeRelayerHost(host) {
    return (host ?? DEFAULT_RELAYER_HOST).replace(/\/+$/, '');
}

function normalizeRelayerTxType(value) {
    if (typeof value !== 'string') {
        return RELAYER_TX_TYPE.SAFE;
    }
    const normalized = value.trim().toUpperCase();
    if (normalized === RELAYER_TX_TYPE.PROXY) return RELAYER_TX_TYPE.PROXY;
    return RELAYER_TX_TYPE.SAFE;
}

function normalizeHexData(data) {
    if (!data) return '0x';
    if (typeof data !== 'string' || !isHex(data)) {
        throw new Error('Relayer transaction data must be a hex string.');
    }
    return data;
}

function normalizeMetadata(metadata) {
    if (typeof metadata === 'string') {
        return metadata;
    }
    if (metadata === null || metadata === undefined) {
        return '';
    }
    try {
        return JSON.stringify(metadata);
    } catch (error) {
        return String(metadata);
    }
}

function getBuilderCredentials(config) {
    const apiKey =
        config?.polymarketBuilderApiKey ??
        config?.polymarketApiKey ??
        config?.polymarketClobApiKey;
    const secret =
        config?.polymarketBuilderSecret ??
        config?.polymarketApiSecret ??
        config?.polymarketClobApiSecret;
    const passphrase =
        config?.polymarketBuilderPassphrase ??
        config?.polymarketApiPassphrase ??
        config?.polymarketClobApiPassphrase;
    return { apiKey, secret, passphrase };
}

function buildRelayerAuthHeaders({
    config,
    method,
    path,
    bodyText,
}) {
    const { apiKey, secret, passphrase } = getBuilderCredentials(config);
    if (!apiKey || !secret || !passphrase) {
        throw new Error(
            'Missing Polymarket builder credentials. Set POLYMARKET_BUILDER_API_KEY/POLYMARKET_BUILDER_SECRET/POLYMARKET_BUILDER_PASSPHRASE (or POLYMARKET_API_* / POLYMARKET_CLOB_* fallbacks).'
        );
    }

    const timestamp = Date.now().toString();
    const payload = `${timestamp}${method.toUpperCase()}${path}${bodyText ?? ''}`;
    const secretBytes = Buffer.from(secret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(payload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    return {
        POLY_BUILDER_API_KEY: apiKey,
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: timestamp,
        POLY_BUILDER_PASSPHRASE: passphrase,
    };
}

function buildPathWithQuery(basePath, params) {
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        urlParams.set(key, String(value));
    }
    const query = urlParams.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
}

function uniqueList(values) {
    return [...new Set(values.filter(Boolean))];
}

function buildSignerQueryCandidates(basePath, signerAddress, txType) {
    const address = getAddress(signerAddress);
    const normalizedType = normalizeRelayerTxType(txType);
    const typeCandidates = uniqueList([
        normalizedType,
        normalizedType.toLowerCase(),
    ]);

    const paths = [];
    for (const signerType of typeCandidates) {
        paths.push(buildPathWithQuery(basePath, { address, type: signerType }));
        paths.push(buildPathWithQuery(basePath, { address, signerType }));
        paths.push(buildPathWithQuery(basePath, { signerAddress: address, signerType }));
        paths.push(buildPathWithQuery(basePath, { signerAddress: address, type: signerType }));
    }
    return uniqueList(paths);
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function relayerRequest({
    config,
    method,
    path,
    body,
}) {
    const host = normalizeRelayerHost(config?.polymarketRelayerHost);
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const timeoutMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerRequestTimeoutMs,
        DEFAULT_RELAYER_REQUEST_TIMEOUT_MS
    );
    const headers = {
        'Content-Type': 'application/json',
        ...buildRelayerAuthHeaders({
            config,
            method,
            path,
            bodyText,
        }),
    };

    const response = await fetch(`${host}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyText,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch (error) {
        parsed = { raw: text };
    }

    if (!response.ok) {
        const requestError = new Error(
            `Relayer request failed (${method} ${path}): ${response.status} ${response.statusText} ${text}`
        );
        requestError.statusCode = response.status;
        requestError.responseBody = parsed;
        throw requestError;
    }

    return parsed;
}

async function relayerRequestFirst({
    config,
    method,
    candidatePaths,
    body,
}) {
    let lastError;

    for (const path of candidatePaths) {
        try {
            const payload = await relayerRequest({
                config,
                method,
                path,
                body,
            });
            return { payload, path };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error(`Relayer request failed for ${method} ${candidatePaths.join(', ')}`);
}

function collectPayloadObjects(payload) {
    const out = [];
    const seen = new Set();
    const queue = [payload];

    while (queue.length > 0 && out.length < 24) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) continue;
        seen.add(current);
        out.push(current);

        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return out;
}

function extractStringField(payload, fieldNames) {
    const candidates = collectPayloadObjects(payload);
    for (const candidate of candidates) {
        for (const fieldName of fieldNames) {
            const value = candidate?.[fieldName];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
            if (typeof value === 'number' && Number.isFinite(value)) {
                return String(value);
            }
            if (typeof value === 'bigint') {
                return value.toString();
            }
        }
    }
    return null;
}

function extractBooleanField(payload, fieldNames) {
    const candidates = collectPayloadObjects(payload);
    for (const candidate of candidates) {
        for (const fieldName of fieldNames) {
            const value = candidate?.[fieldName];
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false') return false;
            }
            if (typeof value === 'number') {
                if (value === 1) return true;
                if (value === 0) return false;
            }
        }
    }
    return null;
}

function extractRelayerTxHash(payload) {
    const hashCandidate = extractStringField(payload, [
        'txHash',
        'relayTxHash',
        'relay_hash',
        'hash',
    ]);
    return normalizeHashOrNull(hashCandidate);
}

function extractTransactionHash(payload) {
    const hashCandidate = extractStringField(payload, [
        'transactionHash',
        'transaction_hash',
        'chainTxHash',
        'minedTransactionHash',
    ]);
    return normalizeHashOrNull(hashCandidate);
}

function extractTransactionId(payload) {
    const idCandidate = extractStringField(payload, [
        'transactionID',
        'transactionId',
        'id',
    ]);
    return idCandidate && idCandidate.length > 0 ? idCandidate : null;
}

function normalizeRelayerState(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    if (!normalized) return null;
    if (!normalized.startsWith('STATE_')) {
        if (normalized === 'PENDING') return 'STATE_PENDING';
        if (normalized === 'MINED') return 'STATE_MINED';
        if (normalized === 'CONFIRMED') return 'STATE_CONFIRMED';
        if (normalized === 'FAILED') return 'STATE_FAILED';
        if (normalized === 'INVALID') return 'STATE_INVALID';
    }
    return normalized;
}

function extractRelayerStatus(payload) {
    const statusCandidate = extractStringField(payload, ['state', 'status', 'txStatus']);
    if (!statusCandidate) return null;
    return normalizeRelayerState(statusCandidate);
}

function extractTransactionRecord(payload) {
    if (Array.isArray(payload)) {
        return payload.length > 0 ? payload[0] : null;
    }
    if (payload && typeof payload === 'object') {
        if (Array.isArray(payload.transactions) && payload.transactions.length > 0) {
            return payload.transactions[0];
        }
        if (payload.transaction && typeof payload.transaction === 'object') {
            return payload.transaction;
        }
    }
    return payload;
}

function getSafeFactoryAddress(config) {
    const configured = normalizeAddressOrNull(config?.polymarketRelayerSafeFactory);
    return configured ? getAddress(configured) : SAFE_FACTORY_ADDRESS;
}

function getProxyFactoryAddress(config) {
    const configured = normalizeAddressOrNull(config?.polymarketRelayerProxyFactory);
    return configured ? getAddress(configured) : PROXY_FACTORY_ADDRESS;
}

function deriveSafeAddress({ signerAddress, safeFactory }) {
    return getCreate2Address({
        from: getAddress(safeFactory),
        salt: keccak256(
            encodeAbiParameters(
                [
                    {
                        type: 'address',
                    },
                ],
                [getAddress(signerAddress)]
            )
        ),
        bytecodeHash: SAFE_INIT_CODE_HASH,
    });
}

function deriveProxyAddress({ signerAddress, proxyFactory }) {
    return getCreate2Address({
        from: getAddress(proxyFactory),
        salt: keccak256(encodePacked(['address'], [getAddress(signerAddress)])),
        bytecodeHash: PROXY_INIT_CODE_HASH,
    });
}

function splitAndPackSignature(signature) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('Invalid 65-byte signature.');
    }

    const body = signature.slice(2);
    const r = body.slice(0, 64);
    const s = body.slice(64, 128);
    const vRaw = Number.parseInt(body.slice(128, 130), 16);

    let safeV = vRaw;
    if (safeV === 0 || safeV === 1) {
        safeV += 31;
    } else if (safeV === 27 || safeV === 28) {
        safeV += 4;
    }

    if (safeV < 31 || safeV > 32) {
        throw new Error(`Unexpected signature v=${vRaw} while packing SAFE signature.`);
    }

    return `0x${r}${s}${safeV.toString(16).padStart(2, '0')}`;
}

function isPolymarketRelayerEnabled(config) {
    return Boolean(config?.polymarketRelayerEnabled);
}

async function getRelayerPayload({
    config,
    signerAddress,
    txType,
}) {
    const payloadCandidates = buildSignerQueryCandidates(
        RELAYER_ENDPOINTS.RELAY_PAYLOAD,
        signerAddress,
        txType
    );

    try {
        const { payload } = await relayerRequestFirst({
            config,
            method: 'GET',
            candidatePaths: payloadCandidates,
        });
        return payload;
    } catch (error) {
        return null;
    }
}

async function getRelayerProxyAddress({
    config,
    signerAddress,
    txType = RELAYER_TX_TYPE.SAFE,
}) {
    const payload = await getRelayerPayload({
        config,
        signerAddress,
        txType,
    });

    let candidate = extractStringField(payload, [
        'address',
        'proxyWallet',
        'proxyAddress',
        'walletAddress',
    ]);

    if (!candidate) {
        try {
            const { payload: addressPayload } = await relayerRequestFirst({
                config,
                method: 'GET',
                candidatePaths: buildSignerQueryCandidates(
                    RELAYER_ENDPOINTS.ADDRESS,
                    signerAddress,
                    txType
                ),
            });
            candidate = extractStringField(addressPayload, [
                'address',
                'proxyWallet',
                'proxyAddress',
                'walletAddress',
            ]);
        } catch (error) {
            // Continue to legacy fallback.
        }
    }

    if (!candidate) {
        try {
            const { payload: legacyPayload } = await relayerRequestFirst({
                config,
                method: 'GET',
                candidatePaths: [LEGACY_ENDPOINTS.PROXY_ADDRESS(getAddress(signerAddress))],
            });
            candidate = extractStringField(legacyPayload, [
                'proxyWallet',
                'proxyAddress',
                'walletAddress',
                'address',
            ]);
        } catch (error) {
            // No legacy proxy-address support.
        }
    }

    const normalized = normalizeAddressOrNull(candidate);
    return normalized ? getAddress(normalized) : null;
}

async function getRelayerNonce({
    config,
    signerAddress,
    txType,
    proxyAddress,
}) {
    const payload = await getRelayerPayload({
        config,
        signerAddress,
        txType,
    });

    let nonceCandidate = extractStringField(payload, ['nonce']);

    if (!nonceCandidate) {
        try {
            const { payload: noncePayload } = await relayerRequestFirst({
                config,
                method: 'GET',
                candidatePaths: buildSignerQueryCandidates(
                    RELAYER_ENDPOINTS.NONCE,
                    signerAddress,
                    txType
                ),
            });
            nonceCandidate = extractStringField(noncePayload, ['nonce']);
        } catch (error) {
            // Continue to legacy fallback.
        }
    }

    if (!nonceCandidate && proxyAddress) {
        try {
            const { payload: legacyNoncePayload } = await relayerRequestFirst({
                config,
                method: 'GET',
                candidatePaths: [LEGACY_ENDPOINTS.PROXY_NONCE(getAddress(proxyAddress))],
            });
            nonceCandidate = extractStringField(legacyNoncePayload, ['nonce']);
        } catch (error) {
            // Continue.
        }
    }

    if (!nonceCandidate) {
        throw new Error('Relayer nonce response did not include nonce.');
    }

    return BigInt(nonceCandidate);
}

async function getSafeDeployed({
    config,
    safeAddress,
}) {
    try {
        const { payload } = await relayerRequestFirst({
            config,
            method: 'GET',
            candidatePaths: uniqueList([
                buildPathWithQuery(RELAYER_ENDPOINTS.DEPLOYED, {
                    address: getAddress(safeAddress),
                }),
                buildPathWithQuery(RELAYER_ENDPOINTS.DEPLOYED, {
                    proxyWallet: getAddress(safeAddress),
                }),
            ]),
        });
        return extractBooleanField(payload, ['deployed', 'isDeployed', 'safeDeployed']);
    } catch (error) {
        return null;
    }
}

async function buildSafeCreateRequest({
    walletClient,
    account,
    chainId,
    signerAddress,
    safeFactory,
    safeAddress,
    metadata,
}) {
    if (!walletClient || typeof walletClient.signTypedData !== 'function') {
        throw new Error(
            'Runtime signer does not support signTypedData; cannot create SAFE proxy wallet through relayer.'
        );
    }

    const signature = await walletClient.signTypedData({
        account,
        domain: {
            name: CREATE_PROXY_DOMAIN_NAME,
            chainId: Number(chainId),
            verifyingContract: getAddress(safeFactory),
        },
        types: CREATE_PROXY_EIP712_TYPES,
        primaryType: 'CreateProxy',
        message: {
            paymentToken: zeroAddress,
            payment: 0n,
            paymentReceiver: zeroAddress,
        },
    });

    return {
        from: getAddress(signerAddress),
        to: getAddress(safeFactory),
        proxyWallet: getAddress(safeAddress),
        data: '0x',
        signature,
        signatureParams: {
            paymentToken: zeroAddress,
            payment: '0',
            paymentReceiver: zeroAddress,
        },
        type: 'SAFE-CREATE',
        metadata: normalizeMetadata(metadata),
    };
}

async function signSafeTransaction({
    walletClient,
    account,
    chainId,
    signerAddress,
    proxyWallet,
    toAddress,
    value,
    data,
    operation,
    nonce,
    metadata,
}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error(
            'Runtime signer does not support signMessage; cannot sign SAFE relayer transaction.'
        );
    }
    if (!Number.isInteger(operation) || operation < 0 || operation > 1) {
        throw new Error('SAFE relayer transaction operation must be 0 or 1.');
    }

    const safeTxHash = hashTypedData({
        domain: {
            chainId: Number(chainId),
            verifyingContract: getAddress(proxyWallet),
        },
        primaryType: 'SafeTx',
        types: SAFE_EIP712_TYPES,
        message: {
            to: getAddress(toAddress),
            value: BigInt(value),
            data: normalizeHexData(data),
            operation,
            safeTxGas: 0n,
            baseGas: 0n,
            gasPrice: 0n,
            gasToken: zeroAddress,
            refundReceiver: zeroAddress,
            nonce: BigInt(nonce),
        },
    });

    const signature = await walletClient.signMessage({
        account,
        message: { raw: safeTxHash },
    });

    return {
        request: {
            from: getAddress(signerAddress),
            to: getAddress(toAddress),
            proxyWallet: getAddress(proxyWallet),
            data: normalizeHexData(data),
            nonce: BigInt(nonce).toString(),
            signature: splitAndPackSignature(signature),
            signatureParams: {
                gasPrice: '0',
                operation: String(operation),
                safeTxnGas: '0',
                baseGas: '0',
                gasToken: zeroAddress,
                refundReceiver: zeroAddress,
            },
            type: RELAYER_TX_TYPE.SAFE,
            metadata: normalizeMetadata(metadata),
        },
        txHash: safeTxHash,
    };
}

async function signProxyTransaction({
    walletClient,
    account,
    chainId,
    signerAddress,
    proxyWallet,
    toAddress,
    data,
    nonce,
    metadata,
}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error(
            'Runtime signer does not support signMessage; cannot sign PROXY relayer transaction.'
        );
    }

    const encoded = encodePacked(
        ['uint256', 'address', 'address', 'bytes', 'uint256'],
        [
            BigInt(chainId),
            getAddress(proxyWallet),
            getAddress(toAddress),
            normalizeHexData(data),
            BigInt(nonce),
        ]
    );

    const proxyTxHash = keccak256(encoded);
    const signature = await walletClient.signMessage({
        account,
        message: { raw: proxyTxHash },
    });

    return {
        request: {
            from: getAddress(signerAddress),
            to: getAddress(toAddress),
            proxyWallet: getAddress(proxyWallet),
            data: normalizeHexData(data),
            nonce: BigInt(nonce).toString(),
            signature,
            signatureParams: {
                chainId: String(chainId),
            },
            type: RELAYER_TX_TYPE.PROXY,
            metadata: normalizeMetadata(metadata),
        },
        txHash: proxyTxHash,
    };
}

async function submitRelayerTransaction({
    config,
    transactionRequest,
}) {
    const { payload, path } = await relayerRequestFirst({
        config,
        method: 'POST',
        candidatePaths: [RELAYER_ENDPOINTS.SUBMIT, LEGACY_ENDPOINTS.TRANSACTION],
        body: transactionRequest,
    });

    return {
        payload,
        path,
        transactionId: extractTransactionId(payload),
        relayTxHash: extractRelayerTxHash(payload),
        transactionHash: extractTransactionHash(payload),
        state: extractRelayerStatus(payload),
    };
}

async function fetchTransactionStatus({
    config,
    transactionId,
    relayTxHash,
}) {
    const candidatePaths = [];

    if (transactionId) {
        candidatePaths.push(
            buildPathWithQuery(RELAYER_ENDPOINTS.TRANSACTION, { id: transactionId }),
            buildPathWithQuery(RELAYER_ENDPOINTS.TRANSACTION, {
                transactionID: transactionId,
            }),
            buildPathWithQuery(RELAYER_ENDPOINTS.TRANSACTION, {
                transactionId,
            })
        );
    }

    if (relayTxHash) {
        candidatePaths.push(
            buildPathWithQuery(RELAYER_ENDPOINTS.TRANSACTION, { hash: relayTxHash }),
            buildPathWithQuery(RELAYER_ENDPOINTS.TRANSACTION, { txHash: relayTxHash }),
            LEGACY_ENDPOINTS.TRANSACTION_STATUS(relayTxHash)
        );
    }

    const { payload, path } = await relayerRequestFirst({
        config,
        method: 'GET',
        candidatePaths: uniqueList(candidatePaths),
    });

    const record = extractTransactionRecord(payload);
    const state = extractRelayerStatus(record ?? payload);
    const nextTransactionId = extractTransactionId(record ?? payload) ?? transactionId;
    const nextRelayTxHash = extractRelayerTxHash(record ?? payload) ?? relayTxHash;
    const transactionHash = extractTransactionHash(record ?? payload);

    return {
        payload,
        path,
        state,
        transactionId: nextTransactionId,
        relayTxHash: nextRelayTxHash,
        transactionHash,
    };
}

async function waitForRelayerTransaction({
    config,
    transactionId,
    relayTxHash,
}) {
    if (!transactionId && !relayTxHash) {
        throw new Error('waitForRelayerTransaction requires transactionId or relayTxHash.');
    }

    const pollIntervalMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerPollIntervalMs,
        DEFAULT_RELAYER_POLL_INTERVAL_MS
    );
    const timeoutMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerPollTimeoutMs,
        DEFAULT_RELAYER_POLL_TIMEOUT_MS
    );
    const deadline = Date.now() + timeoutMs;
    let lastStatus;
    let currentTransactionId = transactionId;
    let currentRelayTxHash = relayTxHash;

    while (Date.now() <= deadline) {
        const statusResult = await fetchTransactionStatus({
            config,
            transactionId: currentTransactionId,
            relayTxHash: currentRelayTxHash,
        });

        currentTransactionId = statusResult.transactionId ?? currentTransactionId;
        currentRelayTxHash = statusResult.relayTxHash ?? currentRelayTxHash;
        lastStatus = statusResult;

        if (statusResult.state && RELAYER_SUCCESS_STATES.has(statusResult.state)) {
            return {
                ...statusResult,
                transactionId: currentTransactionId,
                relayTxHash: currentRelayTxHash,
            };
        }

        if (statusResult.state && RELAYER_FAILURE_STATES.has(statusResult.state)) {
            throw new Error(
                `Relayer transaction failed with state=${statusResult.state} for transactionId=${currentTransactionId ?? 'unknown'} relayTxHash=${currentRelayTxHash ?? 'unknown'}.`
            );
        }

        await sleep(pollIntervalMs);
    }

    throw new Error(
        `Timed out waiting for relayer transaction. transactionId=${currentTransactionId ?? 'unknown'} relayTxHash=${currentRelayTxHash ?? 'unknown'} lastStatus=${JSON.stringify(
            lastStatus?.payload ?? null
        )}`
    );
}

async function createProxyWallet({
    config,
    signerAddress,
    chainId,
    txType,
}) {
    return relayerRequest({
        config,
        method: 'POST',
        path: LEGACY_ENDPOINTS.CREATE_PROXY,
        body: {
            from: getAddress(signerAddress),
            chainId: Number(chainId),
            relayerTxType: txType,
        },
    });
}

async function resolveProxyWalletAddress({
    config,
    signerAddress,
    chainId,
    txType,
    explicitProxyWallet,
}) {
    if (explicitProxyWallet) {
        return getAddress(explicitProxyWallet);
    }
    if (config?.polymarketRelayerFromAddress) {
        return getAddress(config.polymarketRelayerFromAddress);
    }

    const resolveProxyAddress = config?.polymarketRelayerResolveProxyAddress !== false;
    if (resolveProxyAddress) {
        try {
            const existingProxy = await getRelayerProxyAddress({
                config,
                signerAddress,
                txType,
            });
            if (existingProxy) {
                return existingProxy;
            }
        } catch (error) {
            // Continue to deterministic derivation and optional deployment.
        }
    }

    const derivedAddress =
        txType === RELAYER_TX_TYPE.SAFE
            ? deriveSafeAddress({
                signerAddress,
                safeFactory: getSafeFactoryAddress(config),
            })
            : deriveProxyAddress({
                signerAddress,
                proxyFactory: getProxyFactoryAddress(config),
            });

    if (txType === RELAYER_TX_TYPE.PROXY && config?.polymarketRelayerAutoDeployProxy) {
        const deployResponse = await createProxyWallet({
            config,
            signerAddress,
            chainId,
            txType,
        });
        const deployTxId = extractTransactionId(deployResponse);
        const deployTxHash = extractRelayerTxHash(deployResponse);
        await waitForRelayerTransaction({
            config,
            transactionId: deployTxId,
            relayTxHash: deployTxHash,
        });
    }

    return derivedAddress;
}

async function resolveRelayerProxyWallet({
    publicClient,
    account,
    config,
    proxyWallet,
}) {
    if (!isPolymarketRelayerEnabled(config)) {
        throw new Error('Polymarket relayer is disabled (POLYMARKET_RELAYER_ENABLED=false).');
    }
    if (!publicClient) {
        throw new Error('publicClient is required to resolve relayer proxy wallet.');
    }

    const signerAddress = getAddress(account?.address);
    const chainId = Number(
        config?.polymarketRelayerChainId ??
            (typeof publicClient.getChainId === 'function'
                ? await publicClient.getChainId()
                : undefined)
    );

    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(
            'Unable to resolve chainId for relayer transaction. Set POLYMARKET_RELAYER_CHAIN_ID.'
        );
    }

    const txType = normalizeRelayerTxType(config?.polymarketRelayerTxType);
    const resolvedProxyWallet = await resolveProxyWalletAddress({
        config,
        signerAddress,
        chainId,
        txType,
        explicitProxyWallet: proxyWallet,
    });

    if (!resolvedProxyWallet) {
        throw new Error(
            'Unable to resolve relayer proxy wallet address. Set POLYMARKET_RELAYER_FROM_ADDRESS, or enable relayer proxy resolution/auto-deploy.'
        );
    }

    return {
        signerAddress,
        chainId,
        txType,
        proxyWallet: resolvedProxyWallet,
    };
}

async function ensureSafeDeployed({
    config,
    walletClient,
    account,
    chainId,
    signerAddress,
    safeAddress,
}) {
    const deployed = await getSafeDeployed({
        config,
        safeAddress,
    });

    if (deployed === true) {
        return;
    }

    if (deployed === null) {
        console.warn(
            `[agent] Unable to verify SAFE deployment for ${safeAddress} via relayer /deployed endpoint; proceeding without deployment check.`
        );
        return;
    }

    if (!config?.polymarketRelayerAutoDeployProxy) {
        throw new Error(
            `SAFE proxy wallet ${safeAddress} appears undeployed. Enable POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY=true to deploy automatically or deploy it out of band.`
        );
    }

    const createRequest = await buildSafeCreateRequest({
        walletClient,
        account,
        chainId,
        signerAddress,
        safeFactory: getSafeFactoryAddress(config),
        safeAddress,
        metadata: 'Relayer SAFE deployment',
    });

    const createSubmission = await submitRelayerTransaction({
        config,
        transactionRequest: createRequest,
    });

    await waitForRelayerTransaction({
        config,
        transactionId: createSubmission.transactionId,
        relayTxHash: createSubmission.relayTxHash,
    });
}

async function relayPolymarketTransaction({
    publicClient,
    walletClient,
    account,
    config,
    proxyWallet,
    to,
    data,
    value = 0n,
    operation = 0,
    nonce,
    metadata,
}) {
    if (!isPolymarketRelayerEnabled(config)) {
        throw new Error('Polymarket relayer is disabled (POLYMARKET_RELAYER_ENABLED=false).');
    }
    if (!publicClient) {
        throw new Error('publicClient is required for relayer transaction submission.');
    }
    if (!walletClient) {
        throw new Error('walletClient is required for relayer transaction submission.');
    }

    const resolved = await resolveRelayerProxyWallet({
        publicClient,
        account,
        config,
        proxyWallet,
    });
    const signerAddress = resolved.signerAddress;
    const chainId = resolved.chainId;
    const txType = resolved.txType;
    const resolvedProxyWallet = resolved.proxyWallet;

    if (txType === RELAYER_TX_TYPE.SAFE) {
        const expectedSafeAddress = deriveSafeAddress({
            signerAddress,
            safeFactory: getSafeFactoryAddress(config),
        });
        if (resolvedProxyWallet.toLowerCase() !== expectedSafeAddress.toLowerCase()) {
            throw new Error(
                `Configured SAFE proxy wallet ${resolvedProxyWallet} does not match expected relayer SAFE address ${expectedSafeAddress} for signer ${signerAddress}.`
            );
        }
        await ensureSafeDeployed({
            config,
            walletClient,
            account,
            chainId,
            signerAddress,
            safeAddress: resolvedProxyWallet,
        });
    }

    const normalizedTo = getAddress(to);
    const normalizedData = normalizeHexData(data);
    const normalizedValue = BigInt(value ?? 0n);
    const normalizedOperation = Number(operation ?? 0);

    const normalizedNonce =
        nonce === undefined || nonce === null
            ? await getRelayerNonce({
                config,
                signerAddress,
                txType,
                proxyAddress: resolvedProxyWallet,
            })
            : BigInt(nonce);

    const signed =
        txType === RELAYER_TX_TYPE.SAFE
            ? await signSafeTransaction({
                walletClient,
                account,
                chainId,
                signerAddress,
                proxyWallet: resolvedProxyWallet,
                toAddress: normalizedTo,
                value: normalizedValue,
                data: normalizedData,
                operation: normalizedOperation,
                nonce: normalizedNonce,
                metadata,
            })
            : await signProxyTransaction({
                walletClient,
                account,
                chainId,
                signerAddress,
                proxyWallet: resolvedProxyWallet,
                toAddress: normalizedTo,
                data: normalizedData,
                nonce: normalizedNonce,
                metadata,
            });

    const submission = await submitRelayerTransaction({
        config,
        transactionRequest: signed.request,
    });
    if (!submission.transactionId && !submission.relayTxHash) {
        throw new Error(
            'Relayer submission did not return transactionID or txHash; cannot track transaction lifecycle.'
        );
    }

    const waited = await waitForRelayerTransaction({
        config,
        transactionId: submission.transactionId,
        relayTxHash: submission.relayTxHash,
    });

    let transactionHash = waited.transactionHash ?? submission.transactionHash;
    if (!transactionHash && waited.relayTxHash) {
        try {
            await publicClient.getTransactionReceipt({ hash: waited.relayTxHash });
            transactionHash = waited.relayTxHash;
        } catch (error) {
            // Relay tx hash is not always the chain transaction hash.
        }
    }

    if (!transactionHash) {
        throw new Error(
            `Relayer transaction reached state=${waited.state ?? 'unknown'} without transactionHash. transactionId=${waited.transactionId ?? 'unknown'} relayTxHash=${waited.relayTxHash ?? 'unknown'}`
        );
    }

    return {
        transactionHash,
        relayTxHash: waited.relayTxHash ?? submission.relayTxHash ?? null,
        transactionId: waited.transactionId ?? submission.transactionId ?? null,
        state: waited.state ?? submission.state ?? null,
        from: signerAddress,
        proxyWallet: resolvedProxyWallet,
        txType,
        nonce: normalizedNonce.toString(),
        submitResponse: submission.payload,
        statusResponse: waited.payload,
    };
}

export {
    RELAYER_TX_TYPE,
    getRelayerProxyAddress,
    isPolymarketRelayerEnabled,
    relayPolymarketTransaction,
    resolveRelayerProxyWallet,
};
