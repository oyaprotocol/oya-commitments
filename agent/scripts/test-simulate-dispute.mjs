import assert from 'node:assert/strict';
import { applySimulateDisputeRuntimeEnv } from './simulate-dispute.mjs';

async function run() {
    const env = {
        COMMITMENT_SAFE: '0xlegacy',
        OG_MODULE: '0xlegacyOg',
        WATCH_ASSETS: '0xlegacyAsset',
        COPY_TRADING_MARKET: 'legacy-market',
        MESSAGE_API_KEYS_JSON: '{"ops":"secret"}',
        KEEP_ME: 'yes',
    };

    applySimulateDisputeRuntimeEnv({
        env,
        agentRef: 'agent-library/agents/copy-trading/agent.js',
        overlayPath: '/tmp/simulate-dispute-overlay.json',
    });

    assert.equal(env.AGENT_MODULE, 'agent-library/agents/copy-trading/agent.js');
    assert.equal(env.AGENT_CONFIG_OVERLAY_PATH, '/tmp/simulate-dispute-overlay.json');
    assert.equal(env.COMMITMENT_SAFE, '');
    assert.equal(env.OG_MODULE, '');
    assert.equal(env.WATCH_ASSETS, '');
    assert.equal(env.COPY_TRADING_MARKET, '');
    assert.equal(env.MESSAGE_API_KEYS_JSON, '{"ops":"secret"}');
    assert.equal(env.KEEP_ME, 'yes');

    console.log('[test] simulate dispute runtime env OK');
}

run().catch((error) => {
    console.error('[test] simulate dispute runtime env failed:', error?.message ?? error);
    process.exit(1);
});
