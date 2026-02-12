import assert from 'node:assert/strict';
import { getSystemPrompt, augmentSignals, fetchEthPriceDataFromCoinGecko } from './agent.js';

async function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText: 'When ethPriceUSD <= smaEth200USD, swap 1 USDC for WETH.',
    });

    assert.ok(prompt.includes('smaEth200USD'));
    assert.ok(prompt.includes('ethPriceUSD'));
    assert.ok(prompt.includes('safeWethHuman'));
    assert.ok(prompt.includes('safeUsdcHuman'));
    assert.ok(prompt.includes('commitment'));
    assert.ok(prompt.includes('uniswap_v3_exact_input_single'));
    assert.ok(prompt.includes('make_deposit'));
    assert.ok(prompt.includes('200-day'));
    assert.ok(prompt.includes('ethPriceUSD <= smaEth200USD'));

    const signals = [{ kind: 'deposit' }];
    const augmented = augmentSignals(signals);
    assert.equal(augmented.length, 2);
    const priceSignal = augmented.find((s) => s.kind === 'priceSignal');
    assert.ok(priceSignal);
    assert.ok(typeof priceSignal.currentTimestamp === 'number');
    assert.ok(typeof priceSignal.lastPollTimestamp === 'number');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            prices: Array.from({ length: 150 }, (_, i) => [
                Date.now() - (150 - i) * 86400 * 1000,
                2000 + i * 0.1,
            ]),
        }),
    });
    try {
        const { ethPriceUSD, smaEth200USD, fetchedAt } = await fetchEthPriceDataFromCoinGecko();
        assert.ok(typeof ethPriceUSD === 'number' && ethPriceUSD > 0);
        assert.ok(typeof smaEth200USD === 'number' && smaEth200USD > 0);
        assert.ok(typeof fetchedAt === 'number');
    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log('[test] limit-order-sma agent OK');
}

run();
