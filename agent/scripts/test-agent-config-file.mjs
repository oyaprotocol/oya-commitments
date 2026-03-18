import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { buildConfig } from '../src/lib/config.js';
import { loadAgentConfigFile, resolveAgentRuntimeConfig } from '../src/lib/agent-config.js';

const RPC_URL = 'http://127.0.0.1:8545';
const ENV_ERC20 = '0x1111111111111111111111111111111111111111';
const FILE_ERC20 = '0x2222222222222222222222222222222222222222';
const FILE_CHAIN_ERC20 = '0x3333333333333333333333333333333333333333';
const ENV_ERC1155 = '0x4444444444444444444444444444444444444444';
const FILE_ERC1155 = '0x5555555555555555555555555555555555555555';
const ENV_SAFE = '0x6666666666666666666666666666666666666666';
const FILE_SAFE = '0x7777777777777777777777777777777777777777';
const ENV_OG = '0x8888888888888888888888888888888888888888';
const FILE_OG = '0x9999999999999999999999999999999999999999';
const FILE_SIGNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAIN_SIGNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MANAGED_ENV_KEYS = ['RPC_URL', 'COMMITMENT_SAFE', 'OG_MODULE'];

function withManagedEnv(overrides, fn) {
    const previous = new Map();
    for (const key of MANAGED_ENV_KEYS) {
        previous.set(key, process.env[key]);
    }

    try {
        process.env.RPC_URL = RPC_URL;
        for (const key of MANAGED_ENV_KEYS) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                const nextValue = overrides[key];
                if (nextValue === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = String(nextValue);
                }
            }
        }
        return fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agent-config-file-'));
    const missingPath = path.join(tmpDir, 'missing-config.json');

    withManagedEnv(
        {
            COMMITMENT_SAFE: undefined,
            OG_MODULE: undefined,
        },
        () => {
            const config = buildConfig();
            assert.equal(config.commitmentSafe, undefined);
            assert.equal(config.ogModule, undefined);
        }
    );

    const baseConfig = {
        commitmentSafe: ENV_SAFE,
        ogModule: ENV_OG,
        watchAssets: [ENV_ERC20],
        watchErc1155Assets: [
            {
                token: ENV_ERC1155,
                tokenId: '9',
                symbol: 'ENV-1155',
            },
        ],
        messageApiEnabled: false,
        messageApiHost: '127.0.0.1',
        messageApiPort: 8787,
        messageApiKeys: {},
        messageApiRequireSignerAllowlist: true,
        messageApiSignerAllowlist: [],
        messageApiSignatureMaxAgeSeconds: 300,
        messageApiMaxBodyBytes: 8192,
        messageApiMaxTextLength: 2000,
        messageApiQueueLimit: 500,
        messageApiBatchSize: 25,
        messageApiDefaultTtlSeconds: 3600,
        messageApiMinTtlSeconds: 30,
        messageApiMaxTtlSeconds: 86400,
        messageApiIdempotencyTtlSeconds: 86400,
        messageApiRateLimitPerMinute: 30,
        messageApiRateLimitBurst: 10,
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
    assert.equal(fallbackResolved.commitmentSafe, ENV_SAFE);
    assert.equal(fallbackResolved.ogModule, ENV_OG);

    const configPath = path.join(tmpDir, 'config.json');
    await writeFile(
        configPath,
        JSON.stringify(
            {
                policyName: 'fast-withdraw',
                commitmentSafe: FILE_SAFE,
                watchAssets: [FILE_ERC20],
                messageApi: {
                    enabled: true,
                    host: '0.0.0.0',
                    port: 9999,
                    requireSignerAllowlist: true,
                    signerAllowlist: [FILE_SIGNER],
                    rateLimitPerMinute: 12,
                    keys: {
                        ops: 'root-token',
                    },
                },
                byChain: {
                    '11155111': {
                        ogModule: FILE_OG,
                        watchAssets: [FILE_CHAIN_ERC20],
                        messageApi: {
                            port: 9898,
                            requireSignerAllowlist: false,
                            signerAllowlist: [CHAIN_SIGNER],
                            batchSize: 7,
                        },
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
    assert.equal(resolved.commitmentSafe, FILE_SAFE);
    assert.equal(resolved.ogModule, FILE_OG);
    assert.equal(resolved.agentConfig.commitmentSafe, FILE_SAFE);
    assert.equal(resolved.agentConfig.ogModule, FILE_OG);
    assert.equal(resolved.messageApiEnabled, true);
    assert.equal(resolved.messageApiHost, '0.0.0.0');
    assert.equal(resolved.messageApiPort, 9898);
    assert.deepEqual(resolved.messageApiKeys, { ops: 'root-token' });
    assert.equal(resolved.messageApiRequireSignerAllowlist, false);
    assert.deepEqual(resolved.messageApiSignerAllowlist, [getAddress(CHAIN_SIGNER)]);
    assert.equal(resolved.messageApiBatchSize, 7);
    assert.equal(resolved.messageApiRateLimitPerMinute, 12);
    assert.deepEqual(resolved.agentConfig.messageApi.signerAllowlist, [getAddress(CHAIN_SIGNER)]);

    await writeFile(
        configPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        commitmentSafe: null,
                        ogModule: null,
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const nullFallbackFile = await loadAgentConfigFile(configPath);
    const nullFallbackResolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile: nullFallbackFile,
        chainId: 11155111,
    });
    assert.equal(nullFallbackResolved.commitmentSafe, ENV_SAFE);
    assert.equal(nullFallbackResolved.ogModule, ENV_OG);
    assert.equal(nullFallbackResolved.agentConfig.commitmentSafe, ENV_SAFE);
    assert.equal(nullFallbackResolved.agentConfig.ogModule, ENV_OG);
    assert.equal(nullFallbackResolved.messageApiEnabled, false);
    assert.equal(nullFallbackResolved.messageApiPort, 8787);

    await writeFile(
        configPath,
        JSON.stringify(
            {
                messageApi: {
                    enabled: true,
                    requireSignerAllowlist: true,
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const invalidMessageApiFile = await loadAgentConfigFile(configPath);
    assert.throws(
        () =>
            resolveAgentRuntimeConfig({
                baseConfig,
                agentConfigFile: invalidMessageApiFile,
                chainId: 11155111,
            }),
        /requires signerAllowlist when enabled=true and requireSignerAllowlist=true/
    );

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
