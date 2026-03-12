import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
    COMMITMENT_SAFE: '0x1111111111111111111111111111111111111111',
    OG_MODULE: '0x2222222222222222222222222222222222222222',
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
        },
        () => {
            const config = buildConfig();
            assert.equal(config.pollIntervalMs, 1500);
            assert.equal(config.logChunkSize, 64n);
            assert.equal(config.disputeRetryMs, 45000);
            assert.equal(config.proposalHashResolveTimeoutMs, 0);
            assert.equal(config.proposalHashResolvePollIntervalMs, 750);
            assert.equal(config.polymarketClobRequestTimeoutMs, 0);
            assert.equal(config.polymarketClobMaxRetries, 0);
            assert.equal(config.polymarketClobRetryDelayMs, 125);
            assert.equal(config.polymarketRelayerChainId, 137);
            assert.equal(config.polymarketRelayerRequestTimeoutMs, 0);
            assert.equal(config.polymarketRelayerPollIntervalMs, 2500);
            assert.equal(config.polymarketRelayerPollTimeoutMs, 0);
        }
    );

    withManagedEnv(
        {
            POLL_INTERVAL_MS: '0',
        },
        () => {
            assert.throws(() => buildConfig(), /POLL_INTERVAL_MS must be >= 1/);
        }
    );

    withManagedEnv(
        {
            POLL_INTERVAL_MS: 'abc',
        },
        () => {
            assert.throws(() => buildConfig(), /POLL_INTERVAL_MS must be an integer/);
        }
    );

    withManagedEnv(
        {
            LOG_CHUNK_SIZE: '0',
        },
        () => {
            assert.throws(() => buildConfig(), /LOG_CHUNK_SIZE must be a positive integer/);
        }
    );

    withManagedEnv(
        {
            PROPOSAL_HASH_RESOLVE_TIMEOUT_MS: '-1',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /PROPOSAL_HASH_RESOLVE_TIMEOUT_MS must be >= 0/
            );
        }
    );

    withManagedEnv(
        {
            DISPUTE_RETRY_MS: '-1',
        },
        () => {
            assert.throws(() => buildConfig(), /DISPUTE_RETRY_MS must be >= 1/);
        }
    );

    withManagedEnv(
        {
            PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS: '0',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS must be >= 1/
            );
        }
    );

    withManagedEnv(
        {
            POLYMARKET_CLOB_REQUEST_TIMEOUT_MS: '-1',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /POLYMARKET_CLOB_REQUEST_TIMEOUT_MS must be >= 0/
            );
        }
    );

    withManagedEnv(
        {
            POLYMARKET_CLOB_MAX_RETRIES: '-1',
        },
        () => {
            assert.throws(() => buildConfig(), /POLYMARKET_CLOB_MAX_RETRIES must be >= 0/);
        }
    );

    withManagedEnv(
        {
            POLYMARKET_CLOB_RETRY_DELAY_MS: '-1',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /POLYMARKET_CLOB_RETRY_DELAY_MS must be >= 0/
            );
        }
    );

    withManagedEnv(
        {
            POLYMARKET_RELAYER_CHAIN_ID: '0',
        },
        () => {
            assert.throws(() => buildConfig(), /POLYMARKET_RELAYER_CHAIN_ID must be >= 1/);
        }
    );

    withManagedEnv(
        {
            POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS: '-1',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS must be >= 0/
            );
        }
    );

    withManagedEnv(
        {
            POLYMARKET_RELAYER_POLL_INTERVAL_MS: '0',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /POLYMARKET_RELAYER_POLL_INTERVAL_MS must be >= 1/
            );
        }
    );

    console.log('[test] config runtime controls OK');
}

run().catch((error) => {
    console.error('[test] config runtime controls failed:', error?.message ?? error);
    process.exit(1);
});
