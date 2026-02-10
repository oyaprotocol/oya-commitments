import assert from 'node:assert/strict';
import { cancelClobOrders, placeClobOrder } from '../src/lib/polymarket.js';

const TEST_CONFIG = {
    polymarketClobHost: 'https://clob.polymarket.com',
    polymarketClobApiKey: 'test-api-key',
    polymarketClobApiSecret: Buffer.from('test-secret').toString('base64'),
    polymarketClobApiPassphrase: 'test-passphrase',
    polymarketClobRequestTimeoutMs: 1_000,
    polymarketClobMaxRetries: 2,
    polymarketClobRetryDelayMs: 0,
};

function jsonResponse(status, body, statusText = '') {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        async text() {
            return text;
        },
    };
}

async function run() {
    const originalFetch = globalThis.fetch;
    try {
        let orderCalls = 0;
        globalThis.fetch = async () => {
            orderCalls += 1;
            return jsonResponse(500, { error: 'temporary failure' }, 'Internal Server Error');
        };

        await assert.rejects(
            placeClobOrder({
                config: TEST_CONFIG,
                signingAddress: '0x1111111111111111111111111111111111111111',
                signedOrder: {
                    maker: '0x1111111111111111111111111111111111111111',
                    tokenId: '1',
                    side: 'BUY',
                },
                ownerApiKey: 'owner-key',
                orderType: 'GTC',
            }),
            /CLOB request failed \(POST \/order\): 500/
        );
        assert.equal(orderCalls, 1);

        let cancelCalls = 0;
        globalThis.fetch = async () => {
            cancelCalls += 1;
            if (cancelCalls === 1) {
                return jsonResponse(500, { error: 'temporary failure' }, 'Internal Server Error');
            }
            return jsonResponse(200, { canceled: ['order-1'] });
        };

        const cancelResult = await cancelClobOrders({
            config: TEST_CONFIG,
            signingAddress: '0x1111111111111111111111111111111111111111',
            mode: 'ids',
            orderIds: ['order-1'],
        });
        assert.deepEqual(cancelResult, { canceled: ['order-1'] });
        assert.equal(cancelCalls, 2);

        console.log('[test] polymarket request retries OK');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

run();
