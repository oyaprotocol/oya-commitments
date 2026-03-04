import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
    COMMITMENT_SAFE: '0x1111111111111111111111111111111111111111',
    OG_MODULE: '0x2222222222222222222222222222222222222222',
};

const MANAGED_ENV_KEYS = [
    ...Object.keys(REQUIRED_BASE_ENV),
    'MESSAGE_API_ENABLED',
    'MESSAGE_API_KEYS_JSON',
    'MESSAGE_API_PORT',
    'MESSAGE_API_MAX_BODY_BYTES',
    'MESSAGE_API_RATE_LIMIT_PER_MINUTE',
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
    // Disabled API should not parse optional numeric fields from env.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'false',
            MESSAGE_API_PORT: 'abc',
            MESSAGE_API_MAX_BODY_BYTES: 'not-a-number',
            MESSAGE_API_RATE_LIMIT_PER_MINUTE: '??',
            MESSAGE_API_KEYS_JSON: '{not-json}',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiEnabled, false);
            assert.equal(config.messageApiPort, 8787);
            assert.equal(config.messageApiMaxBodyBytes, 8192);
            assert.equal(config.messageApiRateLimitPerMinute, 30);
        }
    );

    // Enabled API should continue to enforce numeric validation.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_test"}',
            MESSAGE_API_PORT: 'abc',
        },
        () => {
            assert.throws(() => buildConfig(), /MESSAGE_API_PORT must be an integer/);
        }
    );

    console.log('[test] config MESSAGE_API gating OK');
}

run().catch((error) => {
    console.error('[test] config MESSAGE_API gating failed:', error?.message ?? error);
    process.exit(1);
});
