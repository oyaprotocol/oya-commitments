import assert from 'node:assert/strict';
import { buildConfigMigrationPatch, mergePlainObjects } from './lib/config-migration.mjs';

async function run() {
    const patch = buildConfigMigrationPatch({
        moduleName: 'copy-trading',
        chainId: '11155111',
        env: {
            COMMITMENT_SAFE: '0x1111111111111111111111111111111111111111',
            OG_MODULE: '0x2222222222222222222222222222222222222222',
            WATCH_ASSETS: '0x3333333333333333333333333333333333333333,0x4444444444444444444444444444444444444444',
            PROPOSE_ENABLED: 'false',
            MESSAGE_API_PORT: '9555',
            MESSAGE_API_SIGNER_ALLOWLIST: '0x5555555555555555555555555555555555555555',
            COPY_TRADING_SOURCE_USER: '0x6666666666666666666666666666666666666666',
            COPY_TRADING_MARKET: 'market-1',
            COPY_TRADING_YES_TOKEN_ID: '123',
            COPY_TRADING_NO_TOKEN_ID: '456',
            MESSAGE_API_KEYS_JSON: '{"ops":"secret-token"}',
        },
    });

    assert.deepEqual(patch, {
        byChain: {
            '11155111': {
                commitmentSafe: '0x1111111111111111111111111111111111111111',
                ogModule: '0x2222222222222222222222222222222222222222',
                watchAssets: [
                    '0x3333333333333333333333333333333333333333',
                    '0x4444444444444444444444444444444444444444',
                ],
                proposeEnabled: false,
                messageApi: {
                    port: 9555,
                    signerAllowlist: ['0x5555555555555555555555555555555555555555'],
                },
                copyTrading: {
                    sourceUser: '0x6666666666666666666666666666666666666666',
                    market: 'market-1',
                    yesTokenId: '123',
                    noTokenId: '456',
                },
            },
        },
    });

    const merged = mergePlainObjects(
        {
            chainId: 137,
            byChain: {
                '11155111': {
                    copyTrading: {
                        market: 'old-market',
                        collateralToken: '0x7777777777777777777777777777777777777777',
                    },
                    disputeEnabled: true,
                },
            },
        },
        patch
    );
    assert.deepEqual(merged, {
        chainId: 137,
        byChain: {
            '11155111': {
                commitmentSafe: '0x1111111111111111111111111111111111111111',
                ogModule: '0x2222222222222222222222222222222222222222',
                watchAssets: [
                    '0x3333333333333333333333333333333333333333',
                    '0x4444444444444444444444444444444444444444',
                ],
                disputeEnabled: true,
                proposeEnabled: false,
                messageApi: {
                    port: 9555,
                    signerAllowlist: ['0x5555555555555555555555555555555555555555'],
                },
                copyTrading: {
                    sourceUser: '0x6666666666666666666666666666666666666666',
                    market: 'market-1',
                    yesTokenId: '123',
                    noTokenId: '456',
                    collateralToken: '0x7777777777777777777777777777777777777777',
                },
            },
        },
    });

    const topLevelPatch = buildConfigMigrationPatch({
        moduleName: 'default',
        env: {
            COMMITMENT_SAFE: '0x8888888888888888888888888888888888888888',
            OG_MODULE: '0x9999999999999999999999999999999999999999',
            POLL_INTERVAL_MS: '15000',
        },
    });
    assert.deepEqual(topLevelPatch, {
        commitmentSafe: '0x8888888888888888888888888888888888888888',
        ogModule: '0x9999999999999999999999999999999999999999',
        pollIntervalMs: 15000,
    });

    const deterministicDcaPathPatch = buildConfigMigrationPatch({
        moduleName: 'agent-library/agents/deterministic-dca-agent/agent.js',
        env: {
            DETERMINISTIC_DCA_POLICY_PRESET: 'mainnet',
            DETERMINISTIC_DCA_LOG_CHUNK_SIZE: '5000',
        },
    });
    assert.deepEqual(deterministicDcaPathPatch, {
        deterministicDcaPolicyPreset: 'mainnet',
        deterministicDcaLogChunkSize: '5000',
    });

    const chainScopedPatch = buildConfigMigrationPatch({
        moduleName: 'default',
        chainId: '11155111',
        env: {
            COMMITMENT_SAFE: '0x8888888888888888888888888888888888888888',
        },
    });
    assert.deepEqual(chainScopedPatch, {
        byChain: {
            '11155111': {
                commitmentSafe: '0x8888888888888888888888888888888888888888',
            },
        },
    });

    console.log('[test] config migration OK');
}

run().catch((error) => {
    console.error('[test] config migration failed:', error?.message ?? error);
    process.exit(1);
});
