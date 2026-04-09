import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolveMessagePublishServerConfig } from './lib/message-publish-runtime.mjs';

async function createAgentModule(repoRootPath, name, config) {
    const agentDir = path.join(repoRootPath, 'agent-library', 'agents', name);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'agent.js'), 'export default {};\n', 'utf8');
    await writeFile(
        path.join(agentDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf8'
    );
    await writeFile(path.join(agentDir, 'commitment.txt'), 'test commitment\n', 'utf8');
}

async function run() {
    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'message-publish-runtime-'));

    await createAgentModule(repoRootPath, 'message-publish-single-chain', {
        chainId: 11155111,
        ipfsEnabled: true,
        messagePublishApi: {
            enabled: true,
            host: 'message-publish.local',
            port: 9892,
            requireSignerAllowlist: false,
        },
    });

    const serverConfig = await resolveMessagePublishServerConfig({
        argv: ['node', 'start-message-publish-node.mjs', '--module=message-publish-single-chain'],
        env: {
            MESSAGE_PUBLISH_API_KEYS_JSON: '{"ops":"k_message_publish_env"}',
            IPFS_HEADERS_JSON: '{"Authorization":"Bearer message-publish-ipfs"}',
        },
        repoRootPath,
    });

    assert.equal(serverConfig.runtimeConfig.messagePublishApiEnabled, true);
    assert.deepEqual(serverConfig.runtimeConfig.messagePublishApiKeys, {
        ops: 'k_message_publish_env',
    });
    assert.deepEqual(serverConfig.runtimeConfig.ipfsHeaders, {
        Authorization: 'Bearer message-publish-ipfs',
    });
    assert.equal(serverConfig.runtimeConfig.messagePublishApiHost, 'message-publish.local');
    assert.equal(serverConfig.runtimeConfig.messagePublishApiPort, 9892);
    assert.equal(
        serverConfig.stateFile,
        path.join(
            repoRootPath,
            'agent',
            '.state',
            'message-publications',
            'message-publish-single-chain-chain-11155111.json'
        )
    );

    console.log('[test] message publish runtime OK');
}

run().catch((error) => {
    console.error('[test] message publish runtime failed:', error?.message ?? error);
    process.exit(1);
});
