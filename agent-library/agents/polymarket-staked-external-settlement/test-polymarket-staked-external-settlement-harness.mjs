import assert from 'node:assert/strict';
import { getHarnessDefinition, runSmokeScenario } from './harness.mjs';

async function run() {
    const harnessDefinition = getHarnessDefinition();
    assert.equal(harnessDefinition.scenario, 'polymarket-staked-external-settlement-smoke');
    assert.equal(typeof harnessDefinition.description, 'string');

    const result = await runSmokeScenario();
    assert.equal(result.scenario, 'polymarket-staked-external-settlement-smoke');
    assert.equal(result.messagePublicationCount, 4);
    assert.ok(result.tradeLogCid.startsWith('bafy'));
    assert.ok(result.reimbursementRequestCid.startsWith('bafy'));
    assert.ok(result.proposalCid.startsWith('bafy'));
    assert.equal(result.proposalHash, `0x${'f'.repeat(64)}`);
    assert.equal(result.proposalSubmissionStatus, 'resolved');
    assert.ok(result.proposalRequestId.includes(':proposal:'));

    console.log('[test] polymarket-staked-external-settlement harness OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
