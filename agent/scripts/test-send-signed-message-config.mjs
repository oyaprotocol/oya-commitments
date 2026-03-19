import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { buildBaseUrl } from './send-signed-message.mjs';

async function createAgentModule(repoRootPath, name, config, localConfig) {
    const agentDir = path.join(repoRootPath, 'agent-library', 'agents', name);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'agent.js'), 'export default {};\n', 'utf8');
    await writeFile(
        path.join(agentDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf8'
    );
    if (localConfig !== undefined) {
        await writeFile(
            path.join(agentDir, 'config.local.json'),
            JSON.stringify(localConfig, null, 2),
            'utf8'
        );
    }
}

async function run() {
    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'send-signed-message-'));

    await createAgentModule(
        repoRootPath,
        'single-chain',
        {
            messageApi: {
                host: 'config-host.local',
                port: 7777,
            },
            byChain: {
                '11155111': {
                    messageApi: {
                        port: 9898,
                    },
                },
            },
        },
        {
            byChain: {
                '11155111': {
                    messageApi: {
                        host: 'local-host.local',
                    },
                },
            },
        }
    );

    await createAgentModule(repoRootPath, 'blank', {
        policyName: 'blank',
    });

    const overlayPath = path.join(repoRootPath, 'overlay.json');
    await writeFile(
        overlayPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        messageApi: {
                            port: 9444,
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    assert.equal(
        await buildBaseUrl({
            argv: ['node', 'send-signed-message.mjs', '--url=http://cli-host:9555'],
            env: {
                MESSAGE_API_URL: 'http://env-url:8555',
            },
            repoRootPath,
        }),
        'http://cli-host:9555'
    );

    assert.equal(
        await buildBaseUrl({
            argv: ['node', 'send-signed-message.mjs', '--module=single-chain'],
            env: {},
            repoRootPath,
        }),
        'http://local-host.local:9898'
    );

    assert.equal(
        await buildBaseUrl({
            argv: ['node', 'send-signed-message.mjs', '--module=single-chain'],
            env: {
                AGENT_CONFIG_OVERLAY_PATH: overlayPath,
            },
            repoRootPath,
        }),
        'http://local-host.local:9444'
    );

    assert.equal(
        await buildBaseUrl({
            argv: [
                'node',
                'send-signed-message.mjs',
                '--module=single-chain',
                '--scheme=https',
                '--port=9443',
            ],
            env: {},
            repoRootPath,
        }),
        'https://local-host.local:9443'
    );

    assert.equal(
        await buildBaseUrl({
            argv: ['node', 'send-signed-message.mjs', '--module=blank'],
            env: {
                MESSAGE_API_URL: 'http://env-url:8555/base',
            },
            repoRootPath,
        }),
        'http://127.0.0.1:8787'
    );

    assert.equal(
        await buildBaseUrl({
            argv: [
                'node',
                'send-signed-message.mjs',
                '--module=blank',
                '--host=override-host',
            ],
            env: {
                MESSAGE_API_URL: 'http://env-url:8555/base',
            },
            repoRootPath,
        }),
        'http://override-host:8787'
    );

    assert.equal(
        await buildBaseUrl({
            argv: ['node', 'send-signed-message.mjs', '--module=blank'],
            env: {
                MESSAGE_API_HOST: 'env-host.local',
                MESSAGE_API_PORT: '8123',
            },
            repoRootPath,
        }),
        'http://127.0.0.1:8787'
    );

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
