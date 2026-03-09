import assert from 'node:assert/strict';
import { getSystemPrompt } from './agent.js';

function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: false,
        disputeEnabled: false,
        commitmentText: 'Test signed-message commitment.',
    });

    assert.ok(prompt.includes('signed inbound user messages'));
    assert.ok(prompt.includes('kind is "userMessage"'));
    assert.ok(prompt.includes('sender.authType is "eip191"'));
    assert.ok(prompt.includes('Never call tools.'));
    assert.ok(prompt.includes('Return strict JSON'));
    assert.ok(prompt.includes('Commitment text'));

    console.log('[test] signed-message-smoke prompt OK');
}

run();
