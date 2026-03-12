import assert from 'node:assert/strict';
import { buildConfig } from '../src/lib/config.js';

const REQUIRED_BASE_ENV = {
    RPC_URL: 'http://127.0.0.1:8545',
    COMMITMENT_SAFE: '0x1111111111111111111111111111111111111111',
    OG_MODULE: '0x2222222222222222222222222222222222222222',
};

const MANAGED_ENV_KEYS = [
    ...Object.keys(REQUIRED_BASE_ENV),
    'WATCH_ERC1155_ASSETS_JSON',
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
            WATCH_ERC1155_ASSETS_JSON: undefined,
        },
        () => {
            const config = buildConfig();
            assert.deepEqual(config.watchErc1155Assets, []);
        }
    );

    withManagedEnv(
        {
            WATCH_ERC1155_ASSETS_JSON: '{not-json}',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /WATCH_ERC1155_ASSETS_JSON must be valid JSON array/
            );
        }
    );

    withManagedEnv(
        {
            WATCH_ERC1155_ASSETS_JSON: '{"token":"0x3333333333333333333333333333333333333333"}',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /WATCH_ERC1155_ASSETS_JSON must be a JSON array/
            );
        }
    );

    withManagedEnv(
        {
            WATCH_ERC1155_ASSETS_JSON:
                '[{"token":"0x3333333333333333333333333333333333333333","tokenId":"42","symbol":" TEST-42 "},{"token":"0x4444444444444444444444444444444444444444","tokenId":7}]',
        },
        () => {
            const config = buildConfig();
            assert.deepEqual(config.watchErc1155Assets, [
                {
                    token: '0x3333333333333333333333333333333333333333',
                    tokenId: '42',
                    symbol: 'TEST-42',
                },
                {
                    token: '0x4444444444444444444444444444444444444444',
                    tokenId: '7',
                    symbol: undefined,
                },
            ]);
        }
    );

    withManagedEnv(
        {
            WATCH_ERC1155_ASSETS_JSON:
                '[{"token":"0x3333333333333333333333333333333333333333","tokenId":"-1"}]',
        },
        () => {
            assert.throws(
                () => buildConfig(),
                /WATCH_ERC1155_ASSETS_JSON\[0\]\.tokenId must be a non-negative integer/
            );
        }
    );

    console.log('[test] config ERC1155 watch assets OK');
}

run().catch((error) => {
    console.error('[test] config ERC1155 watch assets failed:', error?.message ?? error);
    process.exit(1);
});
