import crypto from 'node:crypto';
import { getAddress, zeroAddress } from 'viem';

const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';
const DEFAULT_CLOB_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CLOB_MAX_RETRIES = 1;
const DEFAULT_CLOB_RETRY_DELAY_MS = 250;
const DATA_API_HOST = 'https://data-api.polymarket.com';
const DEFAULT_COLLATERAL_TOKEN = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const CLOB_SUCCESS_TERMINAL_STATUS = 'CONFIRMED';
const CLOB_FAILURE_TERMINAL_STATUS = 'FAILED';
const CLOB_ORDER_FAILURE_STATUSES = new Set([
    'FAILED',
    'REJECTED',
    'CANCELED',
    'CANCELLED',
    'EXPIRED',
]);
const CLOB_ORDER_FILLED_STATUSES = new Set(['FILLED', 'MATCHED', 'CONFIRMED']);
const CLOB_EIP712_DOMAIN_NAME = 'Polymarket CTF Exchange';
const CLOB_EIP712_DOMAIN_VERSION = '1';
const DEFAULT_EIP712_ORDER_SIDE = 0;
const DEFAULT_EIP712_SIGNATURE_TYPE = 0;
const ORDER_EIP712_TYPES = Object.freeze([
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
]);
const SIDE_INDEX = Object.freeze({
    BUY: 0,
    SELL: 1,
});
const SIGNATURE_TYPE_INDEX = Object.freeze({
    EOA: 0,
    POLY_PROXY: 1,
    POLY_GNOSIS_SAFE: 2,
});
const DEFAULT_CTF_EXCHANGE_BY_CHAIN_ID = Object.freeze({
    137: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
    80002: '0xdfe02eb6733538f8ea35d585af8de5958ad99e40',
});
const DEFAULT_NEG_RISK_CTF_EXCHANGE_BY_CHAIN_ID = Object.freeze({
    137: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    80002: '0xdfe02eb6733538f8ea35d585af8de5958ad99e40',
});

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function normalizeClobHost(host) {
    return (host ?? DEFAULT_CLOB_HOST).replace(/\/+$/, '');
}

function normalizeUint(value, fieldName, { allowZero = true } = {}) {
    if (value === null || value === undefined || value === '') {
        throw new Error(`${fieldName} is required.`);
    }

    let normalized;
    try {
        normalized = BigInt(value);
    } catch (error) {
        throw new Error(`${fieldName} must be an integer value.`);
    }

    if (normalized < 0n || (!allowZero && normalized === 0n)) {
        throw new Error(`${fieldName} must be ${allowZero ? '>= 0' : '> 0'}.`);
    }

    return normalized;
}

function normalizeSideIndex(value) {
    if (value === null || value === undefined || value === '') {
        return DEFAULT_EIP712_ORDER_SIDE;
    }
    if (typeof value === 'number') {
        if (value === 0 || value === 1) return value;
        throw new Error('side must be BUY/SELL or enum index 0/1.');
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toUpperCase();
        if (normalized in SIDE_INDEX) {
            return SIDE_INDEX[normalized];
        }
        if (normalized === '0' || normalized === '1') {
            return Number(normalized);
        }
    }

    throw new Error('side must be BUY/SELL or enum index 0/1.');
}

function normalizeSignatureTypeIndex(value) {
    if (value === null || value === undefined || value === '') {
        return DEFAULT_EIP712_SIGNATURE_TYPE;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2) {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toUpperCase();
        if (normalized in SIGNATURE_TYPE_INDEX) {
            return SIGNATURE_TYPE_INDEX[normalized];
        }
        if (normalized === '0' || normalized === '1' || normalized === '2') {
            return Number(normalized);
        }
    }

    throw new Error('signatureType must be EOA/POLY_GNOSIS_SAFE/POLY_PROXY or enum index 0/1/2.');
}

function randomSalt() {
    // Match the official Polymarket clob-order-utils generateOrderSalt():
    //   Math.round(Math.random() * Date.now())
    // This produces salts ~10-13 digits long, which fit safely in
    // JSON integers and JS Number.parseInt (used by the TS client).
    return String(Math.round(Math.random() * Date.now()));
}

function resolveClobExchangeAddress({ chainId, exchangeOverride, negRisk = false }) {
    if (exchangeOverride) {
        return getAddress(exchangeOverride);
    }

    const lookup = negRisk
        ? DEFAULT_NEG_RISK_CTF_EXCHANGE_BY_CHAIN_ID
        : DEFAULT_CTF_EXCHANGE_BY_CHAIN_ID;
    const exchange = lookup[Number(chainId)];
    if (!exchange) {
        throw new Error(
            `No default Polymarket ${negRisk ? 'neg-risk ' : ''}exchange for chainId=${chainId}.`
        );
    }
    return getAddress(exchange);
}

// Cache for neg risk lookups
const _negRiskCache = {};

async function checkNegRisk({ config, tokenId }) {
    if (tokenId in _negRiskCache) {
        return _negRiskCache[tokenId];
    }
    try {
        const host = normalizeClobHost(config.polymarketClobHost);
        const response = await fetch(
            `${host}/neg-risk?token_id=${encodeURIComponent(tokenId)}`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (response.ok) {
            const data = await response.json();
            const isNegRisk = Boolean(data?.neg_risk);
            _negRiskCache[tokenId] = isNegRisk;
            console.log(`[polymarket] Token ${tokenId.substring(0, 20)}... neg_risk=${isNegRisk}`);
            return isNegRisk;
        }
    } catch (error) {
        console.warn('[polymarket] Failed to check neg-risk:', error?.message);
    }
    // Default to true since most Polymarket markets are neg risk
    _negRiskCache[tokenId] = true;
    return true;
}

// Cache for fee rate lookups
const _feeRateCache = {};

async function getFeeRateBps({ config, signingAddress, tokenId }) {
    const cacheKey = `${signingAddress}:${tokenId}`;
    if (cacheKey in _feeRateCache) {
        return _feeRateCache[cacheKey];
    }
    try {
        const host = normalizeClobHost(config.polymarketClobHost);
        const url = `${host}/fee-rate?token_id=${encodeURIComponent(tokenId)}`;
        const timestamp = Math.floor(Date.now() / 1000);
        const headers = {
            'Content-Type': 'application/json',
            ...buildClobAuthHeaders({
                config,
                signingAddress,
                timestamp,
                method: 'GET',
                path: `/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
            }),
        };
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const data = await response.json();
            // The API returns { base_fee: "100" } or similar
            const feeRateBps = String(data?.base_fee ?? data?.fee_rate_bps ?? data?.feeRateBps ?? '0');
            _feeRateCache[cacheKey] = feeRateBps;
            console.log(`[polymarket] Fee rate for token ${tokenId.substring(0, 20)}...: ${feeRateBps} bps`);
            return feeRateBps;
        }
        const text = await response.text();
        console.warn(`[polymarket] Fee rate request failed: ${response.status} ${text}`);
        return '0';
    } catch (error) {
        console.warn('[polymarket] Failed to fetch fee rate:', error?.message);
        return '0';
    }
}

function buildClobOrderFromRaw({
    maker,
    signer,
    taker,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce,
    feeRateBps,
    side,
    signatureType,
    salt,
}) {
    const normalizedMaker = getAddress(maker);
    const normalizedSigner = getAddress(signer);
    const normalizedTaker = taker ? getAddress(taker) : zeroAddress;
    const normalizedTokenId = normalizeUint(tokenId, 'tokenId');
    const normalizedMakerAmount = normalizeUint(makerAmount, 'makerAmount', { allowZero: false });
    const normalizedTakerAmount = normalizeUint(takerAmount, 'takerAmount', { allowZero: false });
    const normalizedExpiration = normalizeUint(expiration ?? 0, 'expiration');
    const normalizedNonce = normalizeUint(nonce ?? 0, 'nonce');
    const normalizedFeeRateBps = normalizeUint(feeRateBps ?? 0, 'feeRateBps');
    const normalizedSide = normalizeSideIndex(side);
    const normalizedSignatureType = normalizeSignatureTypeIndex(signatureType);
    const normalizedSalt = normalizeUint(salt ?? randomSalt(), 'salt', { allowZero: false });

    return {
        salt: normalizedSalt.toString(),
        maker: normalizedMaker,
        signer: normalizedSigner,
        taker: normalizedTaker,
        tokenId: normalizedTokenId.toString(),
        makerAmount: normalizedMakerAmount.toString(),
        takerAmount: normalizedTakerAmount.toString(),
        expiration: normalizedExpiration.toString(),
        nonce: normalizedNonce.toString(),
        feeRateBps: normalizedFeeRateBps.toString(),
        side: normalizedSide,
        signatureType: normalizedSignatureType,
    };
}

async function signClobOrder({
    walletClient,
    account,
    chainId,
    exchange,
    order,
    domainName = CLOB_EIP712_DOMAIN_NAME,
    domainVersion = CLOB_EIP712_DOMAIN_VERSION,
}) {
    if (!walletClient || typeof walletClient.signTypedData !== 'function') {
        throw new Error(
            'Runtime signer does not support signTypedData; cannot build and sign CLOB orders.'
        );
    }

    const normalizedChainId = Number(chainId);
    if (!Number.isInteger(normalizedChainId) || normalizedChainId <= 0) {
        throw new Error(`Invalid chainId for CLOB signing: ${chainId}`);
    }

    const normalizedExchange = getAddress(exchange);
    const normalizedOrder = buildClobOrderFromRaw(order);
    const message = {
        ...normalizedOrder,
        salt: BigInt(normalizedOrder.salt),
        tokenId: BigInt(normalizedOrder.tokenId),
        makerAmount: BigInt(normalizedOrder.makerAmount),
        takerAmount: BigInt(normalizedOrder.takerAmount),
        expiration: BigInt(normalizedOrder.expiration),
        nonce: BigInt(normalizedOrder.nonce),
        feeRateBps: BigInt(normalizedOrder.feeRateBps),
        side: Number(normalizedOrder.side),
        signatureType: Number(normalizedOrder.signatureType),
    };

    const signature = await walletClient.signTypedData({
        account,
        domain: {
            name: domainName,
            version: domainVersion,
            chainId: normalizedChainId,
            verifyingContract: normalizedExchange,
        },
        types: {
            Order: ORDER_EIP712_TYPES,
        },
        primaryType: 'Order',
        message,
    });

    return {
        ...normalizedOrder,
        signature,
    };
}

function shouldRetryResponseStatus(status) {
    return status === 429 || status >= 500;
}

function shouldRetryError(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (error.name === 'TypeError') return true;
    return false;
}

function canRetryRequest({ method, path }) {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === 'POST' && path === '/order') {
        return false;
    }
    return true;
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClobAuthHeaders({
    config,
    signingAddress,
    timestamp,
    method,
    path,
    bodyText,
}) {
    const apiKey = config.polymarketClobApiKey;
    const apiSecret = config.polymarketClobApiSecret;
    const apiPassphrase = config.polymarketClobApiPassphrase;
    if (!signingAddress) {
        throw new Error('Missing signingAddress for CLOB auth headers.');
    }
    if (!apiKey || !apiSecret || !apiPassphrase) {
        throw new Error(
            'Missing CLOB credentials. Set POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_API_SECRET, and POLYMARKET_CLOB_API_PASSPHRASE.'
        );
    }

    const payload = `${timestamp}${method.toUpperCase()}${path}${bodyText ?? ''}`;
    const secretBytes = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(payload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    if (method.toUpperCase() === 'POST') {
        console.log('[polymarket] HMAC debug:', {
            timestamp,
            method: method.toUpperCase(),
            path,
            bodyLength: (bodyText ?? '').length,
            bodyFirst100: (bodyText ?? '').substring(0, 100),
            payloadFirst100: payload.substring(0, 100),
            signingAddress,
            hmacSignature: signature,
        });
    }

    return {
        'POLY_ADDRESS': signingAddress,
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': String(timestamp),
        'POLY_PASSPHRASE': apiPassphrase,
    };
}

async function clobRequest({
    config,
    signingAddress,
    path,
    method,
    body,
}) {
    const host = normalizeClobHost(config.polymarketClobHost);
    // Salt is now a small integer (matching official generateOrderSalt()),
    // so JSON.stringify handles it correctly as a bare number.
    let bodyText;
    if (body === undefined) {
        bodyText = '';
    } else {
        bodyText = JSON.stringify(body);
    }
    const timeoutMs = normalizeNonNegativeInteger(
        config.polymarketClobRequestTimeoutMs,
        DEFAULT_CLOB_REQUEST_TIMEOUT_MS
    );
    const maxRetries = normalizeNonNegativeInteger(
        config.polymarketClobMaxRetries,
        DEFAULT_CLOB_MAX_RETRIES
    );
    const retriesAllowed = canRetryRequest({ method, path }) ? maxRetries : 0;
    const retryDelayMs = normalizeNonNegativeInteger(
        config.polymarketClobRetryDelayMs,
        DEFAULT_CLOB_RETRY_DELAY_MS
    );

    if (method === 'POST' && path === '/order') {
        console.log('[polymarket] POST /order payload:', bodyText);
    }

    for (let attempt = 0; attempt <= retriesAllowed; attempt += 1) {
        const timestamp = Math.floor(Date.now() / 1000);
        const headers = {
            'Content-Type': 'application/json',
            ...buildClobAuthHeaders({
                config,
                signingAddress,
                timestamp,
                method,
                path,
                bodyText,
            }),
        };

        try {
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
                if (attempt < retriesAllowed && shouldRetryResponseStatus(response.status)) {
                    await sleep(retryDelayMs);
                    continue;
                }
                throw new Error(
                    `CLOB request failed (${method} ${path}): ${response.status} ${response.statusText} ${text}`
                );
            }

            return parsed;
        } catch (error) {
            if (attempt < retriesAllowed && shouldRetryError(error)) {
                await sleep(retryDelayMs);
                continue;
            }
            throw error;
        }
    }

    throw new Error(`CLOB request failed (${method} ${path}) after retries.`);
}

async function placeClobOrder({
    config,
    signingAddress,
    signedOrder,
    ownerApiKey,
    orderType,
}) {
    if (!signedOrder || typeof signedOrder !== 'object') {
        throw new Error('signedOrder is required and must be an object.');
    }
    if (!ownerApiKey) {
        throw new Error('ownerApiKey is required.');
    }
    if (!orderType) {
        throw new Error('orderType is required.');
    }

    const normalizedOrder =
        signedOrder.order && typeof signedOrder.order === 'object'
            ? signedOrder.order
            : signedOrder;

    // Match the official Polymarket clob-client orderToJson format exactly:
    // - salt: bare integer (Number.parseInt) — handled by custom JSON serialization in clobRequest
    // - side: string "BUY" or "SELL" (the TS Side enum is string-based, NOT numeric)
    // - signatureType: numeric (passed through from signing)
    // - makerAmount/takerAmount/feeRateBps/expiration/nonce: strings
    // - deferExec: required field, defaults to false
    const sideNum = Number(normalizedOrder.side);
    const sideStr = sideNum === 0 ? 'BUY' : 'SELL';

    // Match the EXACT key ordering from the official TS client's orderToJson:
    const apiOrder = {
        salt: Number.parseInt(normalizedOrder.salt, 10),
        maker: normalizedOrder.maker,
        signer: normalizedOrder.signer,
        taker: normalizedOrder.taker,
        tokenId: normalizedOrder.tokenId,
        makerAmount: normalizedOrder.makerAmount,
        takerAmount: normalizedOrder.takerAmount,
        side: sideStr,
        expiration: normalizedOrder.expiration,
        nonce: normalizedOrder.nonce,
        feeRateBps: normalizedOrder.feeRateBps,
        signatureType: Number(normalizedOrder.signatureType),
        signature: normalizedOrder.signature,
    };

    return clobRequest({
        config,
        signingAddress,
        method: 'POST',
        path: '/order',
        body: {
            deferExec: false,
            order: apiOrder,
            owner: ownerApiKey,
            orderType,
            postOnly: false,
        },
    });
}

async function getClobOrder({ config, signingAddress, orderId }) {
    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
        throw new Error('orderId is required.');
    }

    return clobRequest({
        config,
        signingAddress,
        method: 'GET',
        path: `/data/order/${encodeURIComponent(orderId.trim())}`,
    });
}

async function getClobTrades({
    config,
    signingAddress,
    maker,
    taker,
    market,
    after,
}) {
    if (!maker && !taker) {
        throw new Error('getClobTrades requires maker or taker.');
    }

    const params = new URLSearchParams();
    if (maker) params.set('maker', String(maker));
    if (taker) params.set('taker', String(taker));
    if (market) params.set('market', String(market));
    if (after !== undefined && after !== null) params.set('after', String(after));

    return clobRequest({
        config,
        signingAddress,
        method: 'GET',
        path: `/data/trades?${params.toString()}`,
    });
}

async function cancelClobOrders({
    config,
    signingAddress,
    mode,
    orderIds,
    market,
    assetId,
}) {
    if (mode === 'all') {
        return clobRequest({
            config,
            signingAddress,
            method: 'DELETE',
            path: '/cancel-all',
        });
    }

    if (mode === 'market') {
        if (!market && !assetId) {
            throw new Error('cancel mode=market requires market or assetId.');
        }
        return clobRequest({
            config,
            signingAddress,
            method: 'DELETE',
            path: '/cancel-market-orders',
            body: {
                market,
                asset_id: assetId,
            },
        });
    }

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        throw new Error('cancel mode=ids requires non-empty orderIds.');
    }

    return clobRequest({
        config,
        signingAddress,
        method: 'DELETE',
        path: '/orders',
        body: orderIds,
    });
}

export {
    CLOB_FAILURE_TERMINAL_STATUS,
    CLOB_ORDER_FAILURE_STATUSES,
    CLOB_ORDER_FILLED_STATUSES,
    CLOB_SUCCESS_TERMINAL_STATUS,
    DATA_API_HOST,
    DEFAULT_COLLATERAL_TOKEN,
    buildClobOrderFromRaw,
    cancelClobOrders,
    checkNegRisk,
    getClobOrder,
    getClobTrades,
    getFeeRateBps,
    placeClobOrder,
    resolveClobExchangeAddress,
    signClobOrder,
};
