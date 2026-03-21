import assert from 'node:assert/strict';
import {
    buildHarnessAgentChildEnv,
    formatMessageApiBaseUrl,
} from './lib/testnet-harness-agent.mjs';

async function run() {
    assert.equal(formatMessageApiBaseUrl('127.0.0.1', 9888), 'http://127.0.0.1:9888');
    assert.equal(formatMessageApiBaseUrl('agent.local', 9888), 'http://agent.local:9888');
    assert.equal(formatMessageApiBaseUrl('::1', 9888), 'http://[::1]:9888');
    assert.equal(
        formatMessageApiBaseUrl('[2001:db8::1]', 9888),
        'http://[2001:db8::1]:9888'
    );

    const childEnv = buildHarnessAgentChildEnv({
        env: {
            COMMITMENT_SAFE: '0xlegacy',
            OG_MODULE: '0xlegacyOg',
            MESSAGE_API_ENABLED: 'true',
            AGENT_CONFIG_OVERLAY_PATHS: '/tmp/legacy-overlay-a.json,/tmp/legacy-overlay-b.json',
            PRIVATE_KEY: '0xold',
            KEEP_ME: 'yes',
        },
        agentRef: 'default',
        rpcUrl: 'http://127.0.0.1:8545',
        signerRole: {
            privateKey: '0xnew',
        },
        overlayPath: '/tmp/overlay.json',
    });
    assert.equal(childEnv.COMMITMENT_SAFE, '');
    assert.equal(childEnv.OG_MODULE, '');
    assert.equal(childEnv.MESSAGE_API_ENABLED, '');
    assert.equal(childEnv.AGENT_CONFIG_OVERLAY_PATHS, '');
    assert.equal(childEnv.KEEP_ME, 'yes');
    assert.equal(childEnv.RPC_URL, 'http://127.0.0.1:8545');
    assert.equal(childEnv.PRIVATE_KEY, '0xnew');
    assert.equal(childEnv.AGENT_MODULE, 'default');
    assert.equal(childEnv.AGENT_CONFIG_OVERLAY_PATH, '/tmp/overlay.json');

    const pathRefChildEnv = buildHarnessAgentChildEnv({
        env: {
            COPY_TRADING_SOURCE_USER: '0xlegacySource',
            COPY_TRADING_MARKET: 'legacy-market',
            KEEP_ME: 'yes',
        },
        agentRef: 'agent-library/agents/copy-trading/agent.js',
        rpcUrl: 'http://127.0.0.1:8545',
        signerRole: {
            privateKey: '0xnew',
        },
        overlayPath: '/tmp/overlay.json',
    });
    assert.equal(pathRefChildEnv.COPY_TRADING_SOURCE_USER, '');
    assert.equal(pathRefChildEnv.COPY_TRADING_MARKET, '');
    assert.equal(pathRefChildEnv.KEEP_ME, 'yes');

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
