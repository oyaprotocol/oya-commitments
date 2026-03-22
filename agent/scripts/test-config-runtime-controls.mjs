import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
};

const MANAGED_ENV_KEYS = [
    ...Object.keys(REQUIRED_BASE_ENV),
    'POLL_INTERVAL_MS',
    'LOG_CHUNK_SIZE',
    'DISPUTE_RETRY_MS',
    'PROPOSAL_HASH_RESOLVE_TIMEOUT_MS',
    'PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS',
    'POLYMARKET_CLOB_REQUEST_TIMEOUT_MS',
    'POLYMARKET_CLOB_MAX_RETRIES',
    'POLYMARKET_CLOB_RETRY_DELAY_MS',
    'POLYMARKET_RELAYER_CHAIN_ID',
    'POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS',
    'POLYMARKET_RELAYER_POLL_INTERVAL_MS',
    'POLYMARKET_RELAYER_POLL_TIMEOUT_MS',
    'PROPOSE_ENABLED',
    'DISPUTE_ENABLED',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_REQUEST_TIMEOUT_MS',
];

function withManagedEnv(overrides, fn) {
    const previous = new Map();
    for (const key of MANAGED_ENV_KEYS) {
        previous.set(key, process.env[key]);
    }

    try {
        for (const [key, value] of Object.entries(REQUIRED_BASE_ENV)) {
            process.env[key] = value;
        }
        for (const key of MANAGED_ENV_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
            const nextValue = overrides[key];
            if (nextValue === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = String(nextValue);
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
    withManagedEnv(
        {
            POLL_INTERVAL_MS: '1500',
            LOG_CHUNK_SIZE: '64',
            DISPUTE_RETRY_MS: '45000',
            PROPOSAL_HASH_RESOLVE_TIMEOUT_MS: '0',
            PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS: '750',
            POLYMARKET_CLOB_REQUEST_TIMEOUT_MS: '0',
            POLYMARKET_CLOB_MAX_RETRIES: '0',
            POLYMARKET_CLOB_RETRY_DELAY_MS: '125',
            POLYMARKET_RELAYER_CHAIN_ID: '137',
            POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS: '0',
            POLYMARKET_RELAYER_POLL_INTERVAL_MS: '2500',
            POLYMARKET_RELAYER_POLL_TIMEOUT_MS: '0',
            PROPOSE_ENABLED: 'false',
            DISPUTE_ENABLED: 'false',
            OPENAI_MODEL: 'gpt-5',
            OPENAI_BASE_URL: 'https://example.invalid/v1',
            OPENAI_REQUEST_TIMEOUT_MS: '1',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.pollIntervalMs, 10_000);
            assert.equal(config.logChunkSize, undefined);
            assert.equal(config.disputeRetryMs, 60_000);
            assert.equal(config.proposalHashResolveTimeoutMs, 15_000);
            assert.equal(config.proposalHashResolvePollIntervalMs, 1_500);
            assert.equal(config.polymarketClobRequestTimeoutMs, 15_000);
            assert.equal(config.polymarketClobMaxRetries, 1);
            assert.equal(config.polymarketClobRetryDelayMs, 250);
            assert.equal(config.polymarketRelayerChainId, undefined);
            assert.equal(config.polymarketRelayerRequestTimeoutMs, 15_000);
            assert.equal(config.polymarketRelayerPollIntervalMs, 2_000);
            assert.equal(config.polymarketRelayerPollTimeoutMs, 120_000);
            assert.equal(config.proposeEnabled, true);
            assert.equal(config.disputeEnabled, true);
            assert.equal(config.openAiModel, 'gpt-4.1-mini');
            assert.equal(config.openAiBaseUrl, 'https://api.openai.com/v1');
            assert.equal(config.openAiRequestTimeoutMs, 60_000);
        }
    );

    withManagedEnv(
        {
            POLL_INTERVAL_MS: 'abc',
            LOG_CHUNK_SIZE: '0',
            POLYMARKET_RELAYER_CHAIN_ID: '0',
        },
        () => {
            assert.doesNotThrow(() => buildConfig());
        }
    );

    console.log('[test] config runtime controls OK');
}

run().catch((error) => {
    console.error('[test] config runtime controls failed:', error?.message ?? error);
    process.exit(1);
});
