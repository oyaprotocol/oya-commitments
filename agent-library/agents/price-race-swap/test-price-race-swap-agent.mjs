import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSystemPrompt } from './agent.js';

function run() {
    const commitmentText = readFileSync(new URL('./commitment.txt', import.meta.url), 'utf8');

    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText,
    });

    assert.ok(prompt.includes('First trigger wins'));
    assert.ok(prompt.includes('Use all currently available WETH in the Safe'));
    assert.ok(prompt.includes('Do not depend on rigid text pattern matching'));
    assert.ok(prompt.includes('Commitment text'));

    console.log('[test] price-race-swap prompt OK');
}

run();
