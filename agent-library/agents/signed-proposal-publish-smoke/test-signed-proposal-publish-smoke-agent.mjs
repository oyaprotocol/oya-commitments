import assert from 'node:assert/strict';
import { getDeterministicToolCalls, getSystemPrompt } from './agent.js';
import { getHarnessDefinition, runSmokeScenario } from './harness.mjs';

async function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: false,
        disputeEnabled: false,
        commitmentText: 'Test signed-proposal-publish commitment.',
    });

    assert.ok(prompt.includes('signed proposal publication'));
    assert.ok(prompt.includes('offchain publication'));
    assert.ok(prompt.includes('Never call tools.'));
    assert.ok(prompt.includes('Return strict JSON'));
    assert.ok(prompt.includes('Commitment text'));

    const deterministicCalls = await getDeterministicToolCalls({
        signals: [
            {
                kind: 'proposal',
                explanation: 'Smoke-test proposal',
            },
        ],
    });
    assert.deepEqual(deterministicCalls, []);

    const harnessDefinition = getHarnessDefinition();
    assert.equal(harnessDefinition.scenario, 'signed-proposal-publish-smoke');
    assert.equal(typeof harnessDefinition.description, 'string');

    const result = await runSmokeScenario();
    assert.equal(result.scenario, 'signed-proposal-publish-smoke');
    assert.equal(result.requestId, 'smoke-proposal-publication');
    assert.ok(result.cid);
    assert.ok(result.uri.startsWith('ipfs://'));

    console.log('[test] signed-proposal-publish-smoke agent OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
