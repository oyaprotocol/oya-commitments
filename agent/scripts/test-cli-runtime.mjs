import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import {
    loadAgentConfigForScript,
    resolveConfiguredChainIdForScript,
    resolveExplicitOverlayPaths,
    sanitizeConfigSelectionEnv,
} from './lib/cli-runtime.mjs';

async function createAgentModule(repoRootPath, name, config, localConfig) {
    const agentDir = path.join(repoRootPath, 'agent-library', 'agents', name);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'agent.js'), 'export default {};\n', 'utf8');
    await writeFile(path.join(agentDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    if (localConfig !== undefined) {
        await writeFile(
            path.join(agentDir, 'config.local.json'),
            JSON.stringify(localConfig, null, 2),
            'utf8'
        );
    }
}

async function run() {
    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'cli-runtime-'));

    await createAgentModule(
        repoRootPath,
        'selection-test',
        {
            byChain: {
                '11155111': {
                    messageApi: {
                        host: 'config-host.local',
                        port: 9001,
                    },
                },
            },
        },
        undefined
    );

    const overlayPath = path.join(repoRootPath, 'overlay.json');
    await writeFile(
        overlayPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        messageApi: {
                            host: 'overlay-host.local',
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    assert.deepEqual(
        resolveExplicitOverlayPaths({
            argv: [
                'node',
                'script.mjs',
                `--overlay=${overlayPath}`,
                '--overlay-paths=/tmp/extra-a.json,/tmp/extra-b.json',
            ],
        }),
        [overlayPath, '/tmp/extra-a.json', '/tmp/extra-b.json']
    );

    const sanitizedEnv = sanitizeConfigSelectionEnv({
        AGENT_CONFIG_OVERLAY_PATH: '/tmp/ambient.json',
        AGENT_CONFIG_OVERLAY_PATHS: '/tmp/ambient-a.json,/tmp/ambient-b.json',
        KEEP_ME: 'yes',
    });
    assert.equal(sanitizedEnv.AGENT_CONFIG_OVERLAY_PATH, '');
    assert.equal(sanitizedEnv.AGENT_CONFIG_OVERLAY_PATHS, '');
    assert.equal(sanitizedEnv.KEEP_ME, 'yes');

    const ignoredAmbientConfig = await loadAgentConfigForScript('selection-test', {
        repoRootPath,
        env: {
            AGENT_CONFIG_OVERLAY_PATH: overlayPath,
        },
    });
    assert.equal(
        ignoredAmbientConfig.agentConfigStack.raw.byChain['11155111'].messageApi.host,
        'config-host.local'
    );

    const explicitOverlayConfig = await loadAgentConfigForScript('selection-test', {
        repoRootPath,
        overlayPaths: [overlayPath],
    });
    assert.equal(
        explicitOverlayConfig.agentConfigStack.raw.byChain['11155111'].messageApi.host,
        'overlay-host.local'
    );

    assert.equal(
        await resolveConfiguredChainIdForScript('selection-test', {
            repoRootPath,
            explicitChainId: 11155111,
        }),
        11155111
    );

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
