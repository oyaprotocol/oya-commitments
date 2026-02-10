import assert from 'node:assert/strict';
import { sanitizeInferredTriggers } from './agent.js';

const WETH = '0x7b79995e5f793a07bc00c21412e50ecae098e7f9';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const POOL = '0x6418eec70f50913ff0d756b48d32ce7c02b47c47';

function run() {
    const normalized = sanitizeInferredTriggers([
        {
            id: 'second',
            baseToken: UNI,
            quoteToken: WETH,
            comparator: 'lte',
            threshold: 0.03,
            priority: 1,
        },
        {
            id: 'first',
            baseToken: WETH,
            quoteToken: USDC,
            comparator: 'gte',
            threshold: 1800,
            priority: 0,
            pool: POOL,
        },
    ]);

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].id, 'first');
    assert.equal(normalized[1].id, 'second');
    assert.equal(normalized[1].poolSelection, 'high-liquidity');

    assert.throws(() =>
        sanitizeInferredTriggers([
            {
                id: 'dup',
                baseToken: WETH,
                quoteToken: USDC,
                comparator: 'gte',
                threshold: 1,
            },
            {
                id: 'dup',
                baseToken: UNI,
                quoteToken: WETH,
                comparator: 'lte',
                threshold: 1,
            },
        ])
    );

    assert.throws(() =>
        sanitizeInferredTriggers([
            {
                id: 'bad',
                baseToken: WETH,
                quoteToken: WETH,
                comparator: 'gte',
                threshold: 1,
            },
        ])
    );

    console.log('[test] local inferred trigger sanitizer OK');
}

run();
