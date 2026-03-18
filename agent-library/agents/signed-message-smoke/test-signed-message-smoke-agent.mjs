import assert from 'node:assert/strict';
import { getDeterministicToolCalls, getSystemPrompt } from './agent.js';

async function run() {
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

    const deterministicCalls = await getDeterministicToolCalls({
        signals: [
            {
                kind: 'userMessage',
                text: 'Smoke-test signed message',
            },
        ],
    });
    assert.deepEqual(deterministicCalls, []);

    console.log('[test] signed-message-smoke prompt OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
