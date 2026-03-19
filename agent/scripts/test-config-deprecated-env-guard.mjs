import assert from 'node:assert/strict';
import {
    assertNoDeprecatedConfigEnvVars,
    findDeprecatedConfigEnvVars,
} from '../src/lib/config.js';

async function run() {
    assert.deepEqual(
        findDeprecatedConfigEnvVars({
            env: {
                POLL_INTERVAL_MS: '1500',
                MESSAGE_API_KEYS_JSON: '{"ops":"secret"}',
            },
            agentModuleName: 'default',
        }),
        ['POLL_INTERVAL_MS']
    );

    assert.deepEqual(
        findDeprecatedConfigEnvVars({
            env: {
                COPY_TRADING_MARKET: 'market-1',
                MESSAGE_API_KEYS_JSON: '{"ops":"secret"}',
            },
            agentModuleName: 'copy-trading',
        }),
        ['COPY_TRADING_MARKET']
    );

    assert.throws(
        () =>
            assertNoDeprecatedConfigEnvVars({
                env: {
                    CHAIN_ID: '11155111',
                    MESSAGE_API_ENABLED: 'true',
                    COPY_TRADING_SOURCE_USER: '0x1111111111111111111111111111111111111111',
                },
                agentModuleName: 'copy-trading',
            }),
        /Legacy non-secret env config is no longer supported.*CHAIN_ID, MESSAGE_API_ENABLED, COPY_TRADING_SOURCE_USER/
    );

    assert.doesNotThrow(() =>
        assertNoDeprecatedConfigEnvVars({
            env: {
                RPC_URL: 'https://sepolia.example',
                PRIVATE_KEY: '0xabc',
                MESSAGE_API_KEYS_JSON: '{"ops":"secret"}',
                IPFS_HEADERS_JSON: '{"Authorization":"Bearer secret"}',
            },
            agentModuleName: 'default',
        })
    );

    console.log('[test] deprecated config env guard OK');
}

run().catch((error) => {
    console.error('[test] deprecated config env guard failed:', error?.message ?? error);
    process.exit(1);
});
