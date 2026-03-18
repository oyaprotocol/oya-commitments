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
    'MESSAGE_API_SIGNER_ALLOWLIST',
    'MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST',
    'MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS',
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
            MESSAGE_API_SIGNER_ALLOWLIST: 'not-an-address',
            MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS: 'not-an-int',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiEnabled, false);
            assert.equal(config.messageApiPort, 8787);
            assert.equal(config.messageApiMaxBodyBytes, 8192);
            assert.equal(config.messageApiRateLimitPerMinute, 30);
            assert.equal(config.messageApiSignatureMaxAgeSeconds, 300);
        }
    );

    // Blank values should not implicitly enable the API.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: '',
            MESSAGE_API_PORT: 'abc',
            MESSAGE_API_KEYS_JSON: '{not-json}',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiEnabled, false);
            assert.equal(config.messageApiPort, 8787);
        }
    );

    // Whitespace-only values should also resolve to the fallback (disabled).
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: '   ',
            MESSAGE_API_MAX_BODY_BYTES: 'not-a-number',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiEnabled, false);
            assert.equal(config.messageApiMaxBodyBytes, 8192);
        }
    );

    // Enabled API should continue to enforce numeric validation once signer auth is configured.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_SIGNER_ALLOWLIST: '0x3333333333333333333333333333333333333333',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_test"}',
            MESSAGE_API_PORT: 'abc',
        },
        () => {
            assert.throws(() => buildConfig(), /MESSAGE_API_PORT must be an integer/);
        }
    );

    // Enabled API requires signer allowlist auth by default, even when bearer keys are present.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_test"}',
            MESSAGE_API_SIGNER_ALLOWLIST: undefined,
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /MESSAGE_API_ENABLED=true with MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST=true requires MESSAGE_API_SIGNER_ALLOWLIST/
            );
        }
    );

    // Enabled API can opt into open signed access without a signer allowlist.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST: 'false',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_test"}',
            MESSAGE_API_SIGNER_ALLOWLIST: undefined,
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiRequireSignerAllowlist, false);
            assert.deepEqual(config.messageApiSignerAllowlist, []);
            assert.deepEqual(config.messageApiKeys, { ops: 'k_test' });
        }
    );

    // Enabled API can run with signer allowlist auth even without bearer keys.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_KEYS_JSON: undefined,
            MESSAGE_API_SIGNER_ALLOWLIST: '0x3333333333333333333333333333333333333333',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.messageApiRequireSignerAllowlist, true);
            assert.equal(config.messageApiSignerAllowlist.length, 1);
            assert.equal(config.messageApiSignerAllowlist[0], '0x3333333333333333333333333333333333333333');
        }
    );

    // Bearer gating remains optional once signer auth is configured.
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_test"}',
            MESSAGE_API_SIGNER_ALLOWLIST: '0x3333333333333333333333333333333333333333',
        },
        () => {
            const config = buildConfig();
            assert.deepEqual(config.messageApiKeys, { ops: 'k_test' });
            assert.equal(config.messageApiSignerAllowlist.length, 1);
        }
    );

    console.log('[test] config MESSAGE_API gating OK');
}

run().catch((error) => {
    console.error('[test] config MESSAGE_API gating failed:', error?.message ?? error);
    process.exit(1);
});
