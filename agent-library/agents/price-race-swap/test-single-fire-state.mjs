import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function run() {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'price-race-state-'));
    try {
        process.env.PRICE_RACE_STATE_PATH = path.join(tempDir, 'state.json');

        const mod = await import(`./agent.js?test=${Date.now()}`);
        const commitment = 'Test commitment text for persistence';

        assert.equal(mod.isCommitmentExecuted(commitment), false);
        mod.markCommitmentExecuted(commitment, { proposalHash: '0xabc' });
        assert.equal(mod.isCommitmentExecuted(commitment), true);

        await mod.onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted', proposalHash: '0xdef' },
            commitmentText: 'Another commitment',
        });
        assert.equal(mod.isCommitmentExecuted('Another commitment'), true);

        console.log('[test] single-fire state persistence OK');
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
        delete process.env.PRICE_RACE_STATE_PATH;
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
