import assert from 'node:assert/strict';
import { getSystemPrompt } from './agent.js';

function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText: 'Test commitment.',
    });

    assert.ok(prompt.includes('monitoring an onchain commitment'));
    assert.ok(prompt.includes('Commitment text'));
    console.log('[test] default agent prompt OK');
}

run();
