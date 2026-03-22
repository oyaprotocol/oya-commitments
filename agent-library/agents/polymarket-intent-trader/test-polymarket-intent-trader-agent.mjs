import assert from 'node:assert/strict';
import { getDeterministicToolCalls, getSystemPrompt } from './agent.js';

async function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: false,
        disputeEnabled: false,
        commitmentText: 'Signed Polymarket trade intents may be written in plain English.',
    });

    assert.ok(prompt.includes('kind is "userMessage"'));
    assert.ok(prompt.includes('sender.authType is "eip191"'));
    assert.ok(prompt.includes('signed human-readable message text as the primary source of trading intent'));
    assert.ok(prompt.includes('Parse signed free-text messages into candidate BUY intents'));
    assert.ok(prompt.includes('Return strict JSON'));
    assert.ok(prompt.includes('Commitment text'));

    const deterministicCalls = await getDeterministicToolCalls({
        signals: [
            {
                kind: 'userMessage',
                text: 'Buy NO for up to 25 USDC if the price is 0.42 or better before 6pm UTC.',
            },
        ],
    });
    assert.deepEqual(deterministicCalls, []);

    console.log('[test] polymarket-intent-trader prompt OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
