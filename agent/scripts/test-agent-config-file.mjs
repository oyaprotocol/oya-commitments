import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { loadAgentConfigFile, resolveAgentRuntimeConfig } from '../src/lib/agent-config.js';

const ENV_ERC20 = '0x1111111111111111111111111111111111111111';
const FILE_ERC20 = '0x2222222222222222222222222222222222222222';
const FILE_CHAIN_ERC20 = '0x3333333333333333333333333333333333333333';
const ENV_ERC1155 = '0x4444444444444444444444444444444444444444';
const FILE_ERC1155 = '0x5555555555555555555555555555555555555555';

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agent-config-file-'));
    const missingPath = path.join(tmpDir, 'missing-config.json');

    const baseConfig = {
        watchAssets: [ENV_ERC20],
        watchErc1155Assets: [
            {
                token: ENV_ERC1155,
                tokenId: '9',
                symbol: 'ENV-1155',
            },
        ],
    };

    const missingFile = await loadAgentConfigFile(missingPath);
    assert.equal(missingFile.exists, false);
    const fallbackResolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile: missingFile,
        chainId: 11155111,
    });
    assert.deepEqual(fallbackResolved.watchAssets, [ENV_ERC20]);
    assert.deepEqual(fallbackResolved.watchErc1155Assets, baseConfig.watchErc1155Assets);
    assert.deepEqual(fallbackResolved.agentConfig, {});

    const configPath = path.join(tmpDir, 'config.json');
    await writeFile(
        configPath,
        JSON.stringify(
            {
                policyName: 'fast-withdraw',
                watchAssets: [FILE_ERC20],
                byChain: {
                    '11155111': {
                        watchAssets: [FILE_CHAIN_ERC20],
                        watchErc1155Assets: [
                            {
                                token: FILE_ERC1155,
                                tokenId: '42',
                                symbol: 'FILE-1155',
                            },
                        ],
                        fillConfirmationThreshold: 5,
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const agentConfigFile = await loadAgentConfigFile(configPath);
    assert.equal(agentConfigFile.exists, true);
    const resolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile,
        chainId: 11155111,
    });
    assert.deepEqual(resolved.watchAssets, [FILE_CHAIN_ERC20]);
    assert.deepEqual(resolved.watchErc1155Assets, [
        {
            token: FILE_ERC1155,
            tokenId: '42',
            symbol: 'FILE-1155',
        },
    ]);
    assert.equal(resolved.agentConfig.policyName, 'fast-withdraw');
    assert.equal(resolved.agentConfig.fillConfirmationThreshold, 5);

    await writeFile(
        configPath,
        JSON.stringify(
            {
                byChain: [],
            },
            null,
            2
        ),
        'utf8'
    );

    const invalidByChainFile = await loadAgentConfigFile(configPath);
    assert.throws(
        () =>
            resolveAgentRuntimeConfig({
                baseConfig,
                agentConfigFile: invalidByChainFile,
                chainId: 11155111,
            }),
        /field "byChain" must be a JSON object/
    );

    console.log('[test] agent config file OK');
}

run().catch((error) => {
    console.error('[test] agent config file failed:', error?.message ?? error);
    process.exit(1);
});
