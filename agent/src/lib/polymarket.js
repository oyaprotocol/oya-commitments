import crypto from 'node:crypto';

const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';

function normalizeClobHost(host) {
    return (host ?? DEFAULT_CLOB_HOST).replace(/\/+$/, '');
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
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now();
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
    const response = await fetch(`${host}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyText,
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch (error) {
        parsed = { raw: text };
    }

    if (!response.ok) {
        throw new Error(
            `CLOB request failed (${method} ${path}): ${response.status} ${response.statusText} ${text}`
        );
    }

    return parsed;
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

    return clobRequest({
        config,
        signingAddress,
        method: 'POST',
        path: '/order',
        body: {
            order: normalizedOrder,
            owner: ownerApiKey,
            orderType,
        },
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

export { cancelClobOrders, placeClobOrder };
