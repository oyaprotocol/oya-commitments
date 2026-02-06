import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPriceTriggers, getSystemPrompt } from './agent.js';

function run() {
    const commitmentText = readFileSync(new URL('./commitment.txt', import.meta.url), 'utf8');

    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText,
    });

    assert.ok(prompt.includes('First trigger wins'));
    assert.ok(prompt.includes('Use all currently available USDC in the Safe'));
    assert.ok(prompt.includes('Commitment text'));

    const triggers = getPriceTriggers({ commitmentText });
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].id, 'eth-breakout');
    assert.equal(triggers[0].comparator, 'gte');
    assert.equal(triggers[0].threshold, 3200);
    assert.equal(triggers[1].id, 'uma-drop');
    assert.equal(triggers[1].comparator, 'lte');
    assert.equal(triggers[1].poolSelection, 'high-liquidity');

    console.log('[test] price-race-swap prompt and trigger parser OK');
}

run();
