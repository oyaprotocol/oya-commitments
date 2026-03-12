import assert from 'node:assert/strict';
import { createSignerClient } from '../src/lib/signer.js';

function createTimeoutError() {
    if (typeof DOMException === 'function') {
        return new DOMException('The operation was aborted due to timeout.', 'TimeoutError');
    }
    const error = new Error('The operation was aborted due to timeout.');
    error.name = 'TimeoutError';
    return error;
}

async function withMockFetch(mockFetch, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function withEnv(overrides, fn) {
    const entries = Object.entries(overrides);
    const previous = new Map(entries.map(([key]) => [key, process.env[key]]));
    for (const [key, value] of entries) {
        process.env[key] = value;
    }
    try {
        await fn();
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
    let observedSignal = null;
    let thrown;

    await withEnv(
        {
            SIGNER_TYPE: 'vault',
            VAULT_ADDR: 'https://vault.example',
            VAULT_TOKEN: 'token',
            VAULT_SECRET_PATH: 'secret/data/agent',
            VAULT_SECRET_KEY: 'private_key',
            VAULT_REQUEST_TIMEOUT_MS: '10',
        },
        async () => {
            await withMockFetch(
                async (_url, options) => {
                    observedSignal = options?.signal ?? null;
                    return new Promise((_resolve, reject) => {
                        observedSignal.addEventListener(
                            'abort',
                            () => {
                                reject(createTimeoutError());
                            },
                            { once: true }
                        );
                    });
                },
                async () => {
                    try {
                        await createSignerClient({
                            rpcUrl: 'http://127.0.0.1:8545',
                        });
                    } catch (error) {
                        thrown = error;
                    }
                }
            );
        }
    );

    assert.ok(observedSignal);
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.name, 'TimeoutError');

    console.log('[test] signer vault timeout OK');
}

run().catch((error) => {
    console.error('[test] signer vault timeout failed:', error?.message ?? error);
    process.exit(1);
});
