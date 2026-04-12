import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

async function makeFixture(rootDir, fixtureName, { commitmentType, includeAgentJson = true } = {}) {
    const agentDir = path.join(rootDir, fixtureName);
    await mkdir(agentDir, { recursive: true });
    await writeFile(
        path.join(agentDir, 'agent.js'),
        [
            'export function getSystemPrompt({ commitmentText }) {',
            '  return `Prompt: ${commitmentText}`;',
            '}',
            '',
        ].join('\n'),
        'utf8'
    );
    await writeFile(path.join(agentDir, 'commitment.txt'), 'Fixture commitment.\n', 'utf8');
    if (includeAgentJson) {
        await writeFile(
            path.join(agentDir, 'agent.json'),
            `${JSON.stringify(
                {
                    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
                    commitmentType,
                    name: 'Fixture Agent',
                },
                null,
                2
            )}\n`,
            'utf8'
        );
    }
    return path.join(agentDir, 'agent.js');
}

function runValidate(agentModulePath) {
    return spawnSync(
        'node',
        ['agent/scripts/validate-agent.mjs', `--module=${agentModulePath}`],
        {
            cwd: repoRoot,
            encoding: 'utf8',
            env: process.env,
        }
    );
}

async function run() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'validate-agent-'));

    try {
        const validModulePath = await makeFixture(tempRoot, 'valid-agent', {
            commitmentType: 'standard',
        });
        const validResult = runValidate(validModulePath);
        assert.equal(validResult.status, 0, validResult.stderr);
        assert.match(validResult.stdout, /commitmentType: standard/);

        const invalidModulePath = await makeFixture(tempRoot, 'invalid-agent', {
            commitmentType: 'legacy',
        });
        const invalidResult = runValidate(invalidModulePath);
        assert.notEqual(invalidResult.status, 0);
        assert.match(
            invalidResult.stderr,
            /agent\.json commitmentType must be "standard" or "freeform"/
        );

        const noMetadataModulePath = await makeFixture(tempRoot, 'no-metadata-agent', {
            includeAgentJson: false,
        });
        const noMetadataResult = runValidate(noMetadataModulePath);
        assert.notEqual(noMetadataResult.status, 0);
        assert.match(noMetadataResult.stderr, /agent\.json is missing/);

        console.log('ok');
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

run().catch(async (error) => {
    try {
        if (error?.path) {
            const raw = await readFile(error.path, 'utf8');
            console.error(raw);
        }
    } catch {}
    console.error(error);
    process.exit(1);
});
