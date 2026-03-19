import assert from 'node:assert/strict';
import { getHarnessDefinition, runSmokeScenario } from './harness.mjs';

async function run() {
    const definition = getHarnessDefinition();
    assert.equal(definition.scenario, 'erc1155-swap-fast-withdraw-remote-smoke');
    assert.equal(typeof definition.description, 'string');
    assert.equal(typeof runSmokeScenario, 'function');

    console.log('[test] erc1155-swap-fast-withdraw harness OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
