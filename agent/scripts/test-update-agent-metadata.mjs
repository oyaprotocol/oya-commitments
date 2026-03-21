import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

async function run() {
    const tempRoot = await mkdtemp(path.join(repoRoot, 'agent/.state/update-agent-metadata-'));
    const agentDir = path.join(tempRoot, 'fixture-agent');
    const agentJsonPath = path.join(agentDir, 'agent.json');

    try {
        await mkdir(agentDir, { recursive: true });
        await writeFile(
            agentJsonPath,
            JSON.stringify(
                {
                    name: 'Fixture Agent',
                    endpoints: [],
                    registrations: [],
                },
                null,
                2
            ),
            'utf8'
        );

        const result = spawnSync(
            'node',
            [
                'agent/scripts/update-agent-metadata.mjs',
                `--agent=${agentDir}`,
                '--agent-id=1',
                '--agent-wallet=0x1111111111111111111111111111111111111111',
            ],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                env: process.env,
            }
        );
        if (result.status !== 0) {
            throw new Error(
                `update-agent-metadata failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
            );
        }

        const updated = JSON.parse(await readFile(agentJsonPath, 'utf8'));
        assert.equal(updated.endpoints[0].endpoint, 'eip155:11155111:0x1111111111111111111111111111111111111111');
        assert.equal(
            updated.registrations[0].agentRegistry,
            'eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e'
        );
        assert.equal(updated.registrations[0].agentId, '1');

        console.log('ok');
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
