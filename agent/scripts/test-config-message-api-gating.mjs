import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';
import { resolveAgentRuntimeConfig } from '../src/lib/agent-config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
};

const MANAGED_ENV_KEYS = [
    ...Object.keys(REQUIRED_BASE_ENV),
    'MESSAGE_API_ENABLED',
    'MESSAGE_API_KEYS_JSON',
    'MESSAGE_API_SIGNER_ALLOWLIST',
    'MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST',
    'MESSAGE_API_HOST',
    'MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS',
    'MESSAGE_API_PORT',
    'MESSAGE_API_MAX_BODY_BYTES',
    'MESSAGE_API_BATCH_SIZE',
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
    withManagedEnv(
        {
            MESSAGE_API_ENABLED: 'true',
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

    withManagedEnv(
        {
            MESSAGE_API_HOST: 'env-host.local',
            MESSAGE_API_PORT: '9555',
            MESSAGE_API_BATCH_SIZE: '7',
            MESSAGE_API_KEYS_JSON: '{"ops":"k_config"}',
            MESSAGE_API_SIGNER_ALLOWLIST: '0x3333333333333333333333333333333333333333',
        },
        () => {
            const config = buildConfig();
            Object.assign(
                config,
                resolveAgentRuntimeConfig({
                    baseConfig: config,
                    agentConfigFile: {
                        raw: {
                            messageApi: {
                                enabled: true,
                                host: 'config-host.local',
                                port: 9898,
                                batchSize: 11,
                                requireSignerAllowlist: false,
                            },
                        },
                    },
                    chainId: 11155111,
                })
            );
            assert.equal(config.messageApiEnabled, true);
            assert.equal(config.messageApiHost, 'config-host.local');
            assert.equal(config.messageApiPort, 9898);
            assert.equal(config.messageApiBatchSize, 11);
            assert.equal(config.messageApiRequireSignerAllowlist, false);
            assert.deepEqual(config.messageApiKeys, { ops: 'k_config' });
            assert.deepEqual(config.messageApiSignerAllowlist, []);
        }
    );

    withManagedEnv(
        {
            MESSAGE_API_KEYS_JSON: '{"ops":"k_config"}',
            MESSAGE_API_SIGNER_ALLOWLIST: '0x3333333333333333333333333333333333333333',
        },
        () => {
            const config = buildConfig();
            assert.throws(
                () =>
                    resolveAgentRuntimeConfig({
                        baseConfig: config,
                        agentConfigFile: {
                            raw: {
                                messageApi: {
                                    enabled: true,
                                },
                            },
                        },
                        chainId: 11155111,
                    }),
                /field "messageApi" requires signerAllowlist when enabled=true and requireSignerAllowlist=true/
            );
        }
    );

    withManagedEnv(
        {
            MESSAGE_API_KEYS_JSON: '{"ops":"k_config"}',
            MESSAGE_API_SIGNER_ALLOWLIST: 'not-an-address',
        },
        () => {
            const config = buildConfig();
            Object.assign(
                config,
                resolveAgentRuntimeConfig({
                    baseConfig: config,
                    agentConfigFile: {
                        raw: {
                            messageApi: {
                                enabled: true,
                                signerAllowlist: [
                                    '0x3333333333333333333333333333333333333333',
                                ],
                            },
                        },
                    },
                    chainId: 11155111,
                })
            );
            assert.equal(config.messageApiEnabled, true);
            assert.deepEqual(config.messageApiKeys, { ops: 'k_config' });
            assert.deepEqual(config.messageApiSignerAllowlist, [
                '0x3333333333333333333333333333333333333333',
            ]);
        }
    );

    console.log('[test] config MESSAGE_API gating OK');
}

run().catch((error) => {
    console.error('[test] config MESSAGE_API gating failed:', error?.message ?? error);
    process.exit(1);
});
