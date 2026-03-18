import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
    ensureHarnessSession,
    getHarnessSessionPaths,
    readHarnessSessionStatus,
    resetHarnessSession,
    sanitizeSessionSegment,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';

async function run() {
    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'testnet-harness-session-'));
    const agentRef = 'nested/agent ref';
    const profile = 'fork/sepolia';

    assert.equal(sanitizeSessionSegment(agentRef), 'nested_agent_ref');
    assert.equal(sanitizeSessionSegment(profile), 'fork_sepolia');

    const paths = getHarnessSessionPaths({ repoRootPath, agentRef, profile });
    assert.equal(
        paths.sessionDir,
        path.join(repoRootPath, 'agent', '.state', 'harness', 'nested_agent_ref', 'fork_sepolia')
    );

    await ensureHarnessSession({ repoRootPath, agentRef, profile });
    await writeHarnessJson(paths.files.overlay, { commitmentSafe: '0x1234' });
    await writeHarnessJson(paths.files.roles, { agent: '0xabcd' });

    const status = await readHarnessSessionStatus({ repoRootPath, agentRef, profile });
    assert.equal(status.exists, true);
    assert.equal(status.fileStatuses.overlay.exists, true);
    assert.equal(status.fileStatuses.roles.exists, true);
    assert.equal(status.fileStatuses.deployment.exists, false);
    assert.deepEqual(status.data.overlay, { commitmentSafe: '0x1234' });
    assert.deepEqual(status.data.roles, { agent: '0xabcd' });
    assert.equal(status.data.deployment, null);

    await resetHarnessSession({ repoRootPath, agentRef, profile });
    const resetStatus = await readHarnessSessionStatus({ repoRootPath, agentRef, profile });
    assert.equal(resetStatus.exists, false);
    assert.equal(resetStatus.fileStatuses.overlay.exists, false);

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
