import assert from 'node:assert/strict';
import { getSystemPrompt, augmentSignals } from './agent.js';

function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText: 'When ETH/USD is less than or equal to 2000, swap 1 USDC for WETH.',
    });

    assert.ok(prompt.includes('limit order agent'));
    assert.ok(prompt.includes('ethPriceUSD'));
    assert.ok(prompt.includes('safeWethHuman'));
    assert.ok(prompt.includes('safeUsdcHuman'));
    assert.ok(prompt.includes('commitment'));
    assert.ok(prompt.includes('uniswap_v3_exact_input_single'));
    assert.ok(prompt.includes('make_deposit'));

    const signals = [{ kind: 'deposit' }];
    const augmented = augmentSignals(signals);
    assert.equal(augmented.length, 2);
    const priceSignal = augmented.find((s) => s.kind === 'priceSignal');
    assert.ok(priceSignal);
    assert.ok(typeof priceSignal.currentTimestamp === 'number');
    assert.ok(typeof priceSignal.lastPollTimestamp === 'number');

    console.log('[test] limit-order agent OK');
}

run();
