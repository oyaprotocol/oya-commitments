import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';
import { resolveAgentRuntimeConfig } from '../src/lib/agent-config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
};

const MANAGED_ENV_KEYS = [
    ...Object.keys(REQUIRED_BASE_ENV),
    'IPFS_ENABLED',
    'IPFS_API_URL',
    'IPFS_HEADERS_JSON',
    'IPFS_REQUEST_TIMEOUT_MS',
    'IPFS_MAX_RETRIES',
    'IPFS_RETRY_DELAY_MS',
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
            if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
                continue;
            }
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
            IPFS_ENABLED: 'true',
            IPFS_API_URL: ' not a url ',
            IPFS_HEADERS_JSON: '{not-json}',
            IPFS_REQUEST_TIMEOUT_MS: 'abc',
            IPFS_MAX_RETRIES: 'abc',
            IPFS_RETRY_DELAY_MS: 'abc',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.ipfsEnabled, false);
            assert.equal(config.ipfsApiUrl, 'http://127.0.0.1:5001');
            assert.deepEqual(config.ipfsHeaders, {});
            assert.equal(config.ipfsRequestTimeoutMs, 15_000);
            assert.equal(config.ipfsMaxRetries, 1);
            assert.equal(config.ipfsRetryDelayMs, 250);
        }
    );

    withManagedEnv(
        {
            IPFS_HEADERS_JSON: '{not-json}',
        },
        () => {
            assert.doesNotThrow(() => buildConfig());
        }
    );

    withManagedEnv(
        {
            IPFS_API_URL: 'https://ipfs.example.com',
            IPFS_HEADERS_JSON: '{"Authorization":"Bearer token"}',
            IPFS_REQUEST_TIMEOUT_MS: '5000',
            IPFS_MAX_RETRIES: '2',
            IPFS_RETRY_DELAY_MS: '10',
        },
        () => {
            const config = buildConfig();
            assert.equal(config.ipfsEnabled, false);
            assert.equal(config.ipfsApiUrl, 'http://127.0.0.1:5001');
            assert.deepEqual(config.ipfsHeaders, {});
            assert.equal(config.ipfsRequestTimeoutMs, 15_000);
            assert.equal(config.ipfsMaxRetries, 1);
            assert.equal(config.ipfsRetryDelayMs, 250);
        }
    );

    withManagedEnv(
        {
            IPFS_API_URL: 'https://ipfs.config-env.example',
            IPFS_HEADERS_JSON: '{"Authorization":"Bearer config-token"}',
            IPFS_REQUEST_TIMEOUT_MS: '5001',
            IPFS_MAX_RETRIES: '3',
            IPFS_RETRY_DELAY_MS: '11',
        },
        () => {
            const config = buildConfig();
            Object.assign(
                config,
                resolveAgentRuntimeConfig({
                    baseConfig: config,
                    agentConfigFile: {
                        raw: {
                            ipfsEnabled: true,
                            ipfsApiUrl: 'https://ipfs.config.example',
                            ipfsRequestTimeoutMs: 7000,
                            ipfsMaxRetries: 6,
                            ipfsRetryDelayMs: 33,
                        },
                    },
                    chainId: 11155111,
                })
            );
            assert.equal(config.ipfsEnabled, true);
            assert.equal(config.ipfsApiUrl, 'https://ipfs.config.example');
            assert.deepEqual(config.ipfsHeaders, {
                Authorization: 'Bearer config-token',
            });
            assert.equal(config.ipfsRequestTimeoutMs, 7000);
            assert.equal(config.ipfsMaxRetries, 6);
            assert.equal(config.ipfsRetryDelayMs, 33);
        }
    );

    withManagedEnv(
        {
            IPFS_API_URL: ' not a valid host ',
            IPFS_HEADERS_JSON: '{"Authorization":"Bearer config-token"}',
        },
        () => {
            const config = buildConfig();
            Object.assign(
                config,
                resolveAgentRuntimeConfig({
                    baseConfig: config,
                    agentConfigFile: {
                        raw: {
                            ipfsEnabled: true,
                            ipfsApiUrl: 'https://ipfs.config.example',
                        },
                    },
                    chainId: 11155111,
                })
            );
            assert.equal(config.ipfsEnabled, true);
            assert.equal(config.ipfsApiUrl, 'https://ipfs.config.example');
            assert.deepEqual(config.ipfsHeaders, {
                Authorization: 'Bearer config-token',
            });
        }
    );

    console.log('[test] config IPFS gating OK');
}

run().catch((error) => {
    console.error('[test] config IPFS gating failed:', error?.message ?? error);
    process.exit(1);
});
