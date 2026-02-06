import assert from 'node:assert/strict';
import { getSystemPrompt } from './agent.js';

function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText: 'Price race commitment text.',
    });

    assert.ok(prompt.includes('First trigger wins'));
    assert.ok(prompt.includes('Use all currently available USDC in the Safe'));
    assert.ok(prompt.includes('execute at most one winning branch'));
    assert.ok(prompt.includes('Commitment text'));

    console.log('[test] price-race-swap prompt OK');
}

run();
