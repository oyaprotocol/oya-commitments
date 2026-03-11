import assert from 'node:assert/strict';
import { executeToolCalls, toolDefinitions } from '../src/lib/tools.js';

const TEST_ACCOUNT = { address: '0x1111111111111111111111111111111111111111' };

function parseOutput(result) {
    return JSON.parse(result.output);
}

function buildConfig(overrides = {}) {
    return {
        proposeEnabled: false,
        disputeEnabled: false,
        polymarketClobEnabled: false,
        ipfsEnabled: true,
        ipfsApiUrl: 'http://127.0.0.1:5001',
        ipfsHeaders: {
            Authorization: 'Bearer test-token',
        },
        ipfsRequestTimeoutMs: 1_000,
        ipfsMaxRetries: 1,
        ipfsRetryDelayMs: 0,
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
        ...overrides,
    };
}

function textResponse(status, text, statusText = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        async text() {
            return text;
        },
    };
}

async function run() {
    const disabledDefs = toolDefinitions({
        proposeEnabled: false,
        disputeEnabled: false,
        clobEnabled: false,
        ipfsEnabled: false,
        onchainToolsEnabled: false,
    });
    assert.equal(disabledDefs.find((tool) => tool.name === 'ipfs_publish'), undefined);

    const enabledDefs = toolDefinitions({
        proposeEnabled: false,
        disputeEnabled: false,
        clobEnabled: false,
        ipfsEnabled: true,
        onchainToolsEnabled: false,
    });
    const ipfsToolDef = enabledDefs.find((tool) => tool.name === 'ipfs_publish');
    assert.ok(ipfsToolDef);
    assert.equal(ipfsToolDef.parameters.properties.pin.type[0], 'boolean');
    assert.equal(ipfsToolDef.parameters.properties.json.type[0], 'string');

    const disabledOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'ipfs-disabled',
                name: 'ipfs_publish',
                arguments: {
                    content: 'hello world',
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config: buildConfig({ ipfsEnabled: false }),
        ogContext: null,
    });
    assert.equal(disabledOutputs.length, 1);
    const disabledOut = parseOutput(disabledOutputs[0]);
    assert.equal(disabledOut.status, 'skipped');
    assert.equal(disabledOut.reason, 'ipfs disabled');

    const originalFetch = globalThis.fetch;
    try {
        let addAttempts = 0;
        let pinAttempts = 0;
        let publishedJsonText = null;
        globalThis.fetch = async (url, options = {}) => {
            const urlString = String(url);
            if (urlString.includes('/api/v0/add')) {
                addAttempts += 1;
                assert.equal(options.method, 'POST');
                assert.equal(options.headers.Authorization, 'Bearer test-token');
                assert.ok(options.body instanceof FormData);
                const uploaded = options.body.get('file');
                publishedJsonText = await uploaded.text();
                if (addAttempts === 1) {
                    return textResponse(500, '{"error":"temporary add failure"}', 'Internal Server Error');
                }
                return textResponse(
                    200,
                    '{"Name":"artifact.json","Hash":"bafytestcid","Size":"16"}'
                );
            }
            if (urlString.includes('/api/v0/pin/add')) {
                pinAttempts += 1;
                assert.equal(options.method, 'POST');
                assert.equal(options.headers.Authorization, 'Bearer test-token');
                assert.ok(urlString.includes('arg=bafytestcid'));
                return textResponse(200, '{"Pins":["bafytestcid"]}');
            }
            throw new Error(`Unexpected fetch URL: ${urlString}`);
        };

        const publishOutputs = await executeToolCalls({
            toolCalls: [
                {
                    callId: 'ipfs-publish',
                    name: 'ipfs_publish',
                    arguments: {
                        json: JSON.stringify({
                            z: 2,
                            a: 1,
                        }),
                        filename: 'artifact.json',
                        pin: true,
                    },
                },
            ],
            publicClient: {},
            walletClient: {},
            account: TEST_ACCOUNT,
            config: buildConfig(),
            ogContext: null,
        });
        assert.equal(publishOutputs.length, 1);
        const publishOut = parseOutput(publishOutputs[0]);
        assert.equal(publishOut.status, 'published');
        assert.equal(publishOut.cid, 'bafytestcid');
        assert.equal(publishOut.uri, 'ipfs://bafytestcid');
        assert.equal(publishOut.pinned, true);
        assert.deepEqual(publishOut.pinResult, { Pins: ['bafytestcid'] });
        assert.equal(addAttempts, 2);
        assert.equal(pinAttempts, 1);
        assert.equal(publishedJsonText, '{"a":1,"z":2}');

        globalThis.fetch = async () => {
            throw new TypeError('failed to fetch');
        };
        const errorOutputs = await executeToolCalls({
            toolCalls: [
                {
                    callId: 'ipfs-error',
                    name: 'ipfs_publish',
                    arguments: {
                        content: 'hello world',
                    },
                },
            ],
            publicClient: {},
            walletClient: {},
            account: TEST_ACCOUNT,
            config: buildConfig({ ipfsMaxRetries: 0 }),
            ogContext: null,
        });
        assert.equal(errorOutputs.length, 1);
        const errorOut = parseOutput(errorOutputs[0]);
        assert.equal(errorOut.status, 'error');
        assert.equal(errorOut.retryable, true);
        assert.equal(errorOut.sideEffectsLikelyCommitted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log('[test] IPFS tooling OK');
}

run().catch((error) => {
    console.error('[test] IPFS tooling failed:', error?.message ?? error);
    process.exit(1);
});
