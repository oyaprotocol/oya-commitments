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
    assert.equal(triggers[0].comparator, 'gte');
    assert.equal(triggers[0].threshold, 1800);
    assert.equal(triggers[0].pool.toLowerCase(), '0x6418eec70f50913ff0d756b48d32ce7c02b47c47');
    assert.equal(triggers[1].comparator, 'lte');
    assert.equal(triggers[1].threshold, 0.03);
    assert.equal(triggers[1].pool.toLowerCase(), '0x287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7');

    console.log('[test] price-race-swap prompt and trigger parser OK');
}

run();
