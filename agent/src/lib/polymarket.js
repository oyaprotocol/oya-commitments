const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';

function normalizeClobHost(host) {
    return (host ?? DEFAULT_CLOB_HOST).replace(/\/+$/, '');
}

function buildClobAuthHeaders(config) {
    const apiKey = config.polymarketClobApiKey;
    const apiSecret = config.polymarketClobApiSecret;
    const apiPassphrase = config.polymarketClobApiPassphrase;
    if (!apiKey || !apiSecret || !apiPassphrase) {
        throw new Error(
            'Missing CLOB credentials. Set POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_API_SECRET, and POLYMARKET_CLOB_API_PASSPHRASE.'
        );
    }

    return {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': apiSecret,
        'POLY_PASSPHRASE': apiPassphrase,
    };
}

async function clobRequest({
    config,
    path,
    method,
    body,
}) {
    const host = normalizeClobHost(config.polymarketClobHost);
    const headers = {
        'Content-Type': 'application/json',
        ...buildClobAuthHeaders(config),
    };
    const response = await fetch(`${host}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
    signedOrder,
    owner,
    orderType,
}) {
    if (!signedOrder || typeof signedOrder !== 'object') {
        throw new Error('signedOrder is required and must be an object.');
    }
    if (!owner) {
        throw new Error('owner is required.');
    }
    if (!orderType) {
        throw new Error('orderType is required.');
    }

    return clobRequest({
        config,
        method: 'POST',
        path: '/order',
        body: {
            order: signedOrder,
            owner,
            orderType,
        },
    });
}

async function cancelClobOrders({
    config,
    mode,
    orderIds,
    market,
    assetId,
}) {
    if (mode === 'all') {
        return clobRequest({
            config,
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
        method: 'DELETE',
        path: '/orders',
        body: {
            orderIDs: orderIds,
        },
    });
}

export { cancelClobOrders, placeClobOrder };
