import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeToolCalls } from '../../../agent/src/lib/tools.js';
import {
    getDeterministicToolCalls,
    getModuleState,
    onToolOutput,
    resetModuleStateForTest,
    setModuleStateForTest,
    validatePublishedMessage,
} from './agent.js';
import {
    buildTradeLogMessage,
    buildStateScope,
    createEmptyMarketState,
    computeOutstandingSettlementWei,
    POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
    resolvePolicy,
} from './trade-ledger.js';
import { createEmptyState, writePersistedState } from './state-store.js';

const TEST_AGENT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const TEST_CHAIN_ID = 137;
const TEST_COMMITMENT_SAFE = '0x1111111111111111111111111111111111111111';
const TEST_OG_MODULE = '0x2222222222222222222222222222222222222222';
const TEST_USER = '0x3333333333333333333333333333333333333333';
const TEST_TRADING_WALLET = '0x4444444444444444444444444444444444444444';
const TEST_CTF_CONTRACT = '0x6666666666666666666666666666666666666666';
const TEST_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const TEST_RULES = `Staked External Polymarket Execution
---
The designated agent at address ${TEST_AGENT.address} must deposit a stake of 1000 USDC to be considered the active agent.

To track this external trading, the agent will periodically sign an updated log documenting all of their trades, and send to the node at address 0x5555555555555555555555555555555555555555 for a second signature, and publication to IPFS.

Trades must be logged within 15 minutes of trade execution to be considered valid for reimbursement.
`;

function buildBaseConfig(overrides = {}) {
    return {
        chainId: TEST_CHAIN_ID,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        ogModule: TEST_OG_MODULE,
        ipfsEnabled: true,
        proposeEnabled: true,
        disputeEnabled: true,
        watchAssets: [TEST_USDC],
        messagePublishApiHost: '127.0.0.1',
        messagePublishApiPort: 0,
        messagePublishApiKeys: {
            ops: 'k_message_publish_ops',
        },
        messagePublishApiSignerAllowlist: [TEST_AGENT.address],
        messagePublishApiRequireSignerAllowlist: true,
        messagePublishApiSignatureMaxAgeSeconds: 300,
        messagePublishApiMaxBodyBytes: 65_536,
        ipfsApiUrl: 'http://ipfs.mock',
        ipfsHeaders: {
            Authorization: 'Bearer ipfs-test-token',
        },
        ipfsRequestTimeoutMs: 1_000,
        ipfsMaxRetries: 0,
        ipfsRetryDelayMs: 0,
        agentConfig: {
            polymarketStakedExternalSettlement: {
                authorizedAgent: TEST_AGENT.address,
                userAddress: TEST_USER,
                tradingWallet: TEST_TRADING_WALLET,
                collateralToken: TEST_USDC,
                marketsById: {
                    'market-1': {
                        label: 'Test market',
                    },
                },
            },
        },
        ...overrides,
    };
}

function buildSignal({
    requestId,
    command,
    args,
    text = command,
    receivedAtMs = Date.now(),
}) {
    return {
        kind: 'userMessage',
        messageId: `msg-${requestId}`,
        requestId,
        chainId: TEST_CHAIN_ID,
        command,
        args,
        text,
        sender: {
            authType: 'eip191',
            address: TEST_AGENT.address,
            signature: `0x${'a'.repeat(130)}`,
            signedAtMs: receivedAtMs,
        },
        receivedAtMs,
        expiresAtMs: receivedAtMs + 300_000,
    };
}

function parseToolOutput(output) {
    return JSON.parse(output.output);
}

function textResponse(status, text, statusText = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        async json() {
            return JSON.parse(text);
        },
        async text() {
            return text;
        },
    };
}

function createMockDirectExecutionFetch({
    activity = [],
    marketById = {},
    orderById = {},
    tradesByOrderId = {},
}) {
    const originalFetch = globalThis.fetch;

    function resolveMockPayload(map, key) {
        const raw = map[key];
        if (Array.isArray(raw)) {
            if (raw.length === 0) {
                return undefined;
            }
            const next = raw.shift();
            return next;
        }
        return raw;
    }

    globalThis.fetch = async (url) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.hostname === 'data-api.polymarket.com') {
            return textResponse(200, JSON.stringify(activity));
        }
        if (
            parsedUrl.hostname === 'clob.polymarket.com' &&
            parsedUrl.pathname.startsWith('/data/order/')
        ) {
            const orderId = decodeURIComponent(parsedUrl.pathname.slice('/data/order/'.length));
            const order = orderById[orderId];
            if (!order) {
                return textResponse(404, JSON.stringify({ error: 'missing order' }), 'Not Found');
            }
            return textResponse(200, JSON.stringify(order));
        }
        if (
            parsedUrl.hostname === 'gamma-api.polymarket.com' &&
            parsedUrl.pathname.startsWith('/markets/')
        ) {
            const lookupKey = decodeURIComponent(parsedUrl.pathname.slice('/markets/'.length));
            const market = resolveMockPayload(marketById, lookupKey);
            if (!market) {
                return textResponse(404, JSON.stringify({ error: 'missing market' }), 'Not Found');
            }
            return textResponse(200, JSON.stringify(market));
        }
        if (
            parsedUrl.hostname === 'clob.polymarket.com' &&
            parsedUrl.pathname === '/data/trades'
        ) {
            const trades = Object.values(tradesByOrderId).flat();
            return textResponse(200, JSON.stringify(trades));
        }
        return originalFetch(url);
    };

    return {
        stop() {
            globalThis.fetch = originalFetch;
        },
    };
}

function createMockPublicationFetch(config) {
    const originalFetch = globalThis.fetch;
    const records = [];
    const byKey = new Map();
    const expectedBearerToken = config.messagePublishApiKeys?.ops ?? null;

    const mockPublicClient = {
        async readContract({ functionName }) {
            assert.equal(functionName, 'rules');
            return TEST_RULES;
        },
    };

    globalThis.fetch = async (url, options = {}) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.pathname !== '/v1/messages/publish') {
            return originalFetch(url, options);
        }
        if (expectedBearerToken) {
            assert.equal(options?.headers?.Authorization, `Bearer ${expectedBearerToken}`);
        }
        const body = JSON.parse(String(options.body));
        const signer = String(body?.auth?.address ?? '').toLowerCase();
        const requestId = String(body?.message?.requestId ?? '');
        const key = `${signer}:${requestId}`;
        const canonical = JSON.stringify(body.message);
        const existing = byKey.get(key);

        if (existing && existing.canonical === canonical) {
            return textResponse(
                200,
                JSON.stringify({
                    status: 'duplicate',
                    cid: existing.record.cid,
                    uri: existing.record.uri,
                    validation: existing.validation,
                    requestId,
                })
            );
        }
        const receivedAtMs = Date.now();
        const publishedAtMs = receivedAtMs + 1;
        const validation = await validatePublishedMessage({
            config,
            envelope: {
                address: body.auth.address,
            },
            message: body.message,
            receivedAtMs,
            publishedAtMs,
            listRecords: async () => records,
            publicClient: mockPublicClient,
        });
        const cid = `bafy${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
        const record = {
            signer,
            chainId: TEST_CHAIN_ID,
            requestId,
            cid,
            uri: `ipfs://${cid}`,
            artifact: {
                signedMessage: {
                    envelope: {
                        message: body.message,
                    },
                },
            },
        };
        records.push(record);
        byKey.set(key, {
            canonical,
            validation,
            record,
        });
        return textResponse(
            202,
            JSON.stringify({
                status: 'published',
                cid,
                uri: record.uri,
                validation,
                requestId,
            })
        );
    };

    return {
        stop() {
            globalThis.fetch = originalFetch;
        },
    };
}

async function runPublishCall({ toolCall, publicClient, config }) {
    const walletClient = {
        async signMessage({ message }) {
            return TEST_AGENT.signMessage({ message });
        },
    };
    const outputs = await executeToolCalls({
        toolCalls: [toolCall],
        publicClient,
        walletClient,
        account: TEST_AGENT,
        config,
        ogContext: null,
    });
    assert.equal(outputs.length, 1);
    return parseToolOutput(outputs[0]);
}

async function run() {
    const publicClient = {
        async readContract({ functionName }) {
            if (functionName === 'balanceOf') {
                return 0n;
            }
            throw new Error(`Unsupported readContract function in test: ${functionName}`);
        },
        async getTransactionReceipt({ hash }) {
            return {
                transactionHash: hash,
                status: 1n,
                logs: [],
            };
        },
    };

    const config = buildBaseConfig({
        messagePublishApiPort: 9892,
    });
    const mockNode = createMockPublicationFetch(config);
    const firstSeenAtMs = Date.now();

    const perMarketOnlyPolicy = resolvePolicy({
        chainId: TEST_CHAIN_ID,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        ogModule: TEST_OG_MODULE,
        watchAssets: [TEST_USDC],
        agentConfig: {
            polymarketStakedExternalSettlement: {
                authorizedAgent: TEST_AGENT.address,
                tradingWallet: TEST_TRADING_WALLET,
                collateralToken: TEST_USDC,
                marketsById: {
                    'market-1': {
                        label: 'Per-market user',
                        userAddress: TEST_USER,
                    },
                },
            },
        },
    });
    assert.equal(perMarketOnlyPolicy.ready, true);
    assert.equal(
        perMarketOnlyPolicy.marketsById['market-1'].userAddress,
        TEST_USER.toLowerCase()
    );
    const incompleteDirectPolicy = resolvePolicy({
        chainId: TEST_CHAIN_ID,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        ogModule: TEST_OG_MODULE,
        watchAssets: [TEST_USDC],
        agentConfig: {
            polymarketStakedExternalSettlement: {
                authorizedAgent: TEST_AGENT.address,
                tradingWallet: TEST_TRADING_WALLET,
                collateralToken: TEST_USDC,
                marketsById: {
                    'market-1': {
                        label: 'Incomplete direct market',
                        userAddress: TEST_USER,
                        sourceUser: TEST_USER,
                        yesTokenId: '11',
                        noTokenId: '22',
                        initiatedCollateralAmountWei: '1000000',
                    },
                },
            },
        },
    });
    assert.equal(incompleteDirectPolicy.ready, false);
    assert.ok(
        incompleteDirectPolicy.errors.some((error) =>
            /sourceUser, sourceMarket, yesTokenId, noTokenId, and initiatedCollateralAmountWei/.test(
                error
            )
        )
    );
    const conditionalTokensPolicy = resolvePolicy({
        chainId: 10,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        ogModule: TEST_OG_MODULE,
        watchAssets: [TEST_USDC],
        polymarketConditionalTokens: TEST_CTF_CONTRACT,
        agentConfig: {
            polymarketStakedExternalSettlement: {
                authorizedAgent: TEST_AGENT.address,
                tradingWallet: TEST_TRADING_WALLET,
                collateralToken: TEST_USDC,
                marketsById: {
                    'market-1': {
                        label: 'Conditional tokens market',
                        userAddress: TEST_USER,
                    },
                },
            },
        },
    });
    assert.equal(conditionalTokensPolicy.ctfContract, TEST_CTF_CONTRACT.toLowerCase());
    const scopeTmpDir = await mkdtemp(path.join(tmpdir(), 'oya-poly-scope-'));
    const scopeStateFile = path.join(scopeTmpDir, 'module-state.json');
    const scopeBaseModuleConfig = {
        authorizedAgent: TEST_AGENT.address,
        tradingWallet: TEST_TRADING_WALLET,
        collateralToken: TEST_USDC,
        stateFile: scopeStateFile,
        marketsById: {
            'market-1': {
                label: 'Scoped market',
                userAddress: TEST_USER,
            },
        },
    };

    try {
        await resetModuleStateForTest({ config });
        let toolCalls;

        const directExecutionConfig = buildBaseConfig({
            messagePublishApiPort: 9892,
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    marketsById: {
                        'market-1': {
                            label: 'Direct market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const directExecutionTrade = {
            id: 'source-trade-1',
            side: 'BUY',
            outcome: 'YES',
            price: 0.4,
            timestamp: new Date(firstSeenAtMs - 30_000).toISOString(),
        };
        const directExecutionFetch = createMockDirectExecutionFetch({
            activity: [directExecutionTrade],
            orderById: {
                'direct-order-1': {
                    order: {
                        id: 'direct-order-1',
                        status: 'MATCHED',
                        original_size: 2.5,
                        size_matched: 2.5,
                    },
                },
            },
            tradesByOrderId: {
                'direct-order-1': [
                    {
                        id: 'trade-fill-1',
                        status: 'CONFIRMED',
                        taker_order_id: 'direct-order-1',
                        price: '0.4',
                        size: '2.5',
                    },
                ],
            },
        });
        const directMockNode = createMockPublicationFetch(directExecutionConfig);
        try {
            await resetModuleStateForTest({ config: directExecutionConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: directExecutionConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
            const directOrderArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(directOrderArgs.side, 'BUY');
            assert.equal(directOrderArgs.tokenId, '11');
            assert.equal(directOrderArgs.makerAmount, '1000000');
            assert.equal(directOrderArgs.takerAmount, '2500000');
            assert.equal(directOrderArgs.maker, TEST_TRADING_WALLET);
            assert.equal(directExecutionConfig.polymarketClobAddress, TEST_TRADING_WALLET);

            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: 'direct-order-1',
                            status: 'LIVE',
                        },
                    },
                },
                config: directExecutionConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: directExecutionConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const directPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient,
                config: directExecutionConfig,
            });
            assert.equal(
                directPublication.status,
                'published',
                JSON.stringify(directPublication)
            );
            assert.equal(
                directPublication.validation.classifications[0].classification,
                'reimbursable'
            );
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: directPublication,
                config: directExecutionConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            const directState = getModuleState();
            const directMarket = directState.markets['market-1'];
            assert.equal(directMarket.trades.length, 1);
            assert.equal(directMarket.trades[0].tradeId, 'clob:direct-order-1');
            assert.equal(directMarket.trades[0].tradeEntryKind, 'initiated');
            assert.equal(directMarket.trades[0].principalContributionWei, '1000000');
            assert.equal(directMarket.trades[0].shareAmount, '2500000');
            assert.equal(directMarket.execution.observedSourceTradeId, 'source-trade-1');
            assert.equal(directMarket.execution.currentSourceTradeId, null);
            assert.equal(directMarket.lastPublishedSequence, 1);
        } finally {
            directMockNode.stop();
            directExecutionFetch.stop();
        }

        const orderSummaryFallbackConfig = buildBaseConfig({
            messagePublishApiPort: 9892,
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    marketsById: {
                        'market-1': {
                            label: 'Order summary fallback market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const orderSummaryFallbackFetch = createMockDirectExecutionFetch({
            activity: [directExecutionTrade],
            orderById: {
                'direct-order-fallback-1': {
                    order: {
                        id: 'direct-order-fallback-1',
                        status: 'MATCHED',
                        original_size: 2.5,
                        size_matched: 2.5,
                        maker_amount_filled: '1000000',
                        taker_amount_filled: '2500000',
                        fee: '100000',
                    },
                },
            },
            tradesByOrderId: {
                'direct-order-fallback-1': [],
            },
        });
        const orderSummaryFallbackMockNode = createMockPublicationFetch(orderSummaryFallbackConfig);
        try {
            await resetModuleStateForTest({ config: orderSummaryFallbackConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: orderSummaryFallbackConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');

            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: 'direct-order-fallback-1',
                            status: 'LIVE',
                        },
                    },
                },
                config: orderSummaryFallbackConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: orderSummaryFallbackConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const orderSummaryFallbackPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient,
                config: orderSummaryFallbackConfig,
            });
            assert.equal(
                orderSummaryFallbackPublication.status,
                'published',
                JSON.stringify(orderSummaryFallbackPublication)
            );
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: orderSummaryFallbackPublication,
                config: orderSummaryFallbackConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            const orderSummaryFallbackState = getModuleState();
            assert.equal(orderSummaryFallbackState.markets['market-1'].trades.length, 1);
            assert.equal(
                orderSummaryFallbackState.markets['market-1'].trades[0].tradeId,
                'clob:direct-order-fallback-1'
            );
            assert.equal(
                orderSummaryFallbackState.markets['market-1'].trades[0].principalContributionWei,
                '1000000'
            );
            assert.equal(
                orderSummaryFallbackState.markets['market-1'].trades[0].shareAmount,
                '2400000'
            );
        } finally {
            orderSummaryFallbackMockNode.stop();
            orderSummaryFallbackFetch.stop();
        }

        const staleDirectOrderConfig = buildBaseConfig({
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    dispatchGraceMs: 1,
                    marketsById: {
                        'market-1': {
                            label: 'Stale direct order market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const staleDirectOrderFetch = createMockDirectExecutionFetch({
            activity: [
                {
                    id: 'source-stale-order-1',
                    side: 'BUY',
                    outcome: 'YES',
                    price: 0.4,
                    timestamp: new Date(firstSeenAtMs - 15_000).toISOString(),
                },
            ],
        });
        const originalStaleDirectOrderDateNow = Date.now;
        try {
            await resetModuleStateForTest({ config: staleDirectOrderConfig });
            Date.now = () => firstSeenAtMs + 40_000;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDirectOrderConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');

            let staleDirectState = getModuleState();
            assert.equal(
                staleDirectState.markets['market-1'].execution.currentSourceTradeId,
                'source-stale-order-1'
            );
            assert.equal(
                staleDirectState.markets['market-1'].execution.orderDispatchAtMs,
                firstSeenAtMs + 40_000
            );

            Date.now = () => firstSeenAtMs + 40_010;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDirectOrderConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');

            staleDirectState = getModuleState();
            assert.equal(
                staleDirectState.markets['market-1'].execution.currentSourceTradeId,
                'source-stale-order-1'
            );
            assert.equal(
                staleDirectState.markets['market-1'].execution.orderDispatchAtMs,
                firstSeenAtMs + 40_010
            );
            assert.deepEqual(staleDirectState.markets['market-1'].execution.pendingOrderArgs, {
                side: 'BUY',
                tokenId: '11',
                orderType: 'FOK',
                makerAmount: '1000000',
                takerAmount: '2500000',
                maker: TEST_TRADING_WALLET,
                chainId: TEST_CHAIN_ID,
            });

            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'error',
                    message: 'bad creds',
                },
                config: staleDirectOrderConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });
            staleDirectState = getModuleState();
            assert.equal(
                staleDirectState.markets['market-1'].execution.orderDispatchAtMs,
                firstSeenAtMs + 40_010
            );
            assert.equal(staleDirectState.markets['market-1'].execution.orderError, 'bad creds');

            Date.now = () => firstSeenAtMs + 40_011;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDirectOrderConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
            staleDirectState = getModuleState();
            assert.equal(
                staleDirectState.markets['market-1'].execution.orderDispatchAtMs,
                firstSeenAtMs + 40_010
            );

            Date.now = () => firstSeenAtMs + 40_013;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDirectOrderConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
            staleDirectState = getModuleState();
            assert.equal(
                staleDirectState.markets['market-1'].execution.orderDispatchAtMs,
                firstSeenAtMs + 40_013
            );
            assert.equal(
                staleDirectState.markets['market-1'].execution.currentSourceTradeId,
                'source-stale-order-1'
            );
        } finally {
            Date.now = originalStaleDirectOrderDateNow;
            staleDirectOrderFetch.stop();
        }

        const legacyDirectOrderConfig = buildBaseConfig({
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'legacy-direct-order-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Legacy direct order market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const legacyDirectOrderFetch = createMockDirectExecutionFetch({
            activity: [
                {
                    id: 'legacy-source-trade-1',
                    side: 'BUY',
                    outcome: 'YES',
                    price: 0.4,
                    timestamp: new Date(firstSeenAtMs - 20_000).toISOString(),
                },
            ],
        });
        try {
            await resetModuleStateForTest({ config: legacyDirectOrderConfig });
            const legacyDirectOrderPolicy = resolvePolicy(legacyDirectOrderConfig);
            const legacyDirectOrderScope = buildStateScope({
                config: legacyDirectOrderConfig,
                policy: legacyDirectOrderPolicy,
                chainId: legacyDirectOrderConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const legacyPersistedState = createEmptyState(legacyDirectOrderScope);
            const legacyMarketState = createEmptyMarketState({
                policy: legacyDirectOrderPolicy,
                config: legacyDirectOrderConfig,
                marketId: 'market-1',
            });
            delete legacyMarketState.execution;
            legacyPersistedState.markets['market-1'] = legacyMarketState;
            await writePersistedState(
                legacyDirectOrderConfig.agentConfig.polymarketStakedExternalSettlement.stateFile,
                legacyPersistedState
            );

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: legacyDirectOrderConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
            const legacyState = getModuleState();
            assert.equal(
                legacyState.markets['market-1'].execution.currentSourceTradeId,
                'legacy-source-trade-1'
            );
            assert.deepEqual(legacyState.markets['market-1'].execution.pendingOrderArgs, {
                side: 'BUY',
                tokenId: '11',
                orderType: 'FOK',
                makerAmount: '1000000',
                takerAmount: '2500000',
                maker: TEST_TRADING_WALLET,
                chainId: TEST_CHAIN_ID,
            });
        } finally {
            legacyDirectOrderFetch.stop();
        }

        const directSettlementConfig = buildBaseConfig({
            messagePublishApiPort: 9892,
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    marketsById: {
                        'market-1': {
                            label: 'Direct settlement market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const directSettlementPublicClient = {
            async readContract({ functionName, args }) {
                if (functionName === 'balanceOf') {
                    assert.equal(args?.[0], TEST_TRADING_WALLET);
                    const tokenId = BigInt(args?.[1] ?? 0n).toString();
                    if (tokenId === '11') {
                        return 2_500_000n;
                    }
                    return 0n;
                }
                throw new Error(`Unsupported readContract function in test: ${functionName}`);
            },
            async getTransactionReceipt({ hash }) {
                return {
                    transactionHash: hash,
                    status: 1n,
                    logs: [],
                };
            },
        };
        const directSettlementFetch = createMockDirectExecutionFetch({
            activity: [
                {
                    id: 'source-settlement-trade-1',
                    side: 'BUY',
                    outcome: 'YES',
                    price: 0.4,
                    timestamp: new Date(firstSeenAtMs - 30_000).toISOString(),
                },
            ],
            marketById: {
                'market-1': [
                    {
                        id: 'market-1',
                        outcomePrices: '["0.5","0.5"]',
                        outcomes: '["Yes","No"]',
                        closed: false,
                        umaResolutionStatus: 'pending',
                    },
                    {
                        id: 'market-1',
                        outcomePrices: '["1","0"]',
                        outcomes: '["Yes","No"]',
                        closed: true,
                        umaResolutionStatus: 'resolved',
                        closedTime: new Date(firstSeenAtMs + 120_000).toISOString(),
                        clobTokenIds: '["11","22"]',
                    },
                ],
            },
            orderById: {
                'direct-settlement-order-1': {
                    order: {
                        id: 'direct-settlement-order-1',
                        status: 'MATCHED',
                        original_size: 2.5,
                        size_matched: 2.5,
                    },
                },
            },
            tradesByOrderId: {
                'direct-settlement-order-1': [
                    {
                        id: 'trade-settlement-fill-1',
                        status: 'CONFIRMED',
                        taker_order_id: 'direct-settlement-order-1',
                        price: '0.4',
                        size: '2.5',
                    },
                ],
            },
        });
        const directSettlementMockNode = createMockPublicationFetch(directSettlementConfig);
        try {
            await resetModuleStateForTest({ config: directSettlementConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');

            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: 'direct-settlement-order-1',
                            status: 'LIVE',
                        },
                    },
                },
                config: directSettlementConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const firstDirectSettlementArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(
                firstDirectSettlementArgs.message.payload.summary.finalSettlementValueWei,
                null
            );
            assert.equal(
                firstDirectSettlementArgs.message.payload.summary.settlementKind,
                null
            );
            const firstDirectSettlementPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(
                firstDirectSettlementPublication.status,
                'published',
                JSON.stringify(firstDirectSettlementPublication)
            );
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: firstDirectSettlementPublication,
                config: directSettlementConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const observedSettlementPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(
                observedSettlementPublication.status,
                'published',
                JSON.stringify(observedSettlementPublication)
            );
            const observedSettlementArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(
                observedSettlementArgs.message.payload.summary.finalSettlementValueWei,
                '2500000'
            );
            assert.equal(
                observedSettlementArgs.message.payload.summary.settlementKind,
                'resolved'
            );
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: observedSettlementPublication,
                config: directSettlementConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: directSettlementPublicClient,
                config: directSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'make_deposit');
            const directSettlementDepositArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(directSettlementDepositArgs.amountWei, '2500000');
        } finally {
            directSettlementMockNode.stop();
            directSettlementFetch.stop();
        }

        const preservedDepositSettlementConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'preserved-direct-settlement-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Preserved paid settlement market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const preservedDepositSettlementFetch = createMockDirectExecutionFetch({
            marketById: {
                'market-1': {
                    id: 'market-1',
                    outcomePrices: '["1","0"]',
                    outcomes: '["Yes","No"]',
                    closed: true,
                    umaResolutionStatus: 'resolved',
                    closedTime: new Date(firstSeenAtMs + 180_000).toISOString(),
                    clobTokenIds: '["11","22"]',
                },
            },
        });
        const preservedDepositSettlementPublicClient = {
            async readContract({ functionName, args }) {
                if (functionName === 'balanceOf') {
                    assert.equal(args?.[0], TEST_TRADING_WALLET);
                    return BigInt(args?.[1] ?? 0n) === 11n ? 2_500_000n : 0n;
                }
                throw new Error(`Unsupported readContract function in test: ${functionName}`);
            },
            async getTransactionReceipt({ hash }) {
                return {
                    transactionHash: hash,
                    status: 1n,
                    logs: [],
                };
            },
        };
        try {
            await resetModuleStateForTest({ config: preservedDepositSettlementConfig });
            const preservedPolicy = resolvePolicy(preservedDepositSettlementConfig);
            const preservedScope = buildStateScope({
                config: preservedDepositSettlementConfig,
                policy: preservedPolicy,
                chainId: preservedDepositSettlementConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const preservedState = createEmptyState(preservedScope);
            const preservedMarket = createEmptyMarketState({
                policy: preservedPolicy,
                config: preservedDepositSettlementConfig,
                marketId: 'market-1',
            });
            preservedMarket.revision = 1;
            preservedMarket.publishedRevision = 1;
            preservedMarket.lastPublishedSequence = 1;
            preservedMarket.lastPublishedCid = 'bafy-preserved-paid-settlement';
            preservedMarket.trades = [
                {
                    tradeId: 'preserved-paid-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs - 60_000,
                    principalContributionWei: '1000000',
                    collateralAmountWei: '1000000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            preservedMarket.tradeClassifications['preserved-paid-trade-1'] = {
                classification: 'reimbursable',
                firstSeenAtMs,
                reason: null,
                cid: 'bafy-preserved-paid-classification',
            };
            preservedMarket.settlement.finalSettlementValueWei = '700000';
            preservedMarket.settlement.settledAtMs = firstSeenAtMs + 120_000;
            preservedMarket.settlement.settlementKind = 'resolved';
            preservedMarket.settlement.depositTxHash = `0x${'d'.repeat(64)}`;
            preservedMarket.settlement.depositConfirmedAtMs = firstSeenAtMs + 121_000;
            preservedState.markets['market-1'] = preservedMarket;
            await setModuleStateForTest({
                config: preservedDepositSettlementConfig,
                state: preservedState,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: preservedDepositSettlementPublicClient,
                config: preservedDepositSettlementConfig,
            });
            const preservedStateAfter = getModuleState();
            assert.equal(
                preservedStateAfter.markets['market-1'].settlement.finalSettlementValueWei,
                '700000'
            );
            assert.equal(
                preservedStateAfter.markets['market-1'].settlement.settledAtMs,
                firstSeenAtMs + 120_000
            );
            assert.equal(
                preservedStateAfter.markets['market-1'].settlement.depositTxHash,
                `0x${'d'.repeat(64)}`
            );
            assert.equal(
                preservedStateAfter.markets['market-1'].settlement.depositConfirmedAtMs,
                firstSeenAtMs + 121_000
            );
        } finally {
            await resetModuleStateForTest({ config: preservedDepositSettlementConfig });
            preservedDepositSettlementFetch.stop();
        }

        const inFlightSettlementConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'in-flight-direct-settlement-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'In-flight paid settlement market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const inFlightSettlementFetch = createMockDirectExecutionFetch({
            marketById: {
                'market-1': {
                    id: 'market-1',
                    outcomePrices: '["1","0"]',
                    outcomes: '["Yes","No"]',
                    closed: true,
                    umaResolutionStatus: 'resolved',
                    closedTime: new Date(firstSeenAtMs + 240_000).toISOString(),
                    clobTokenIds: '["11","22"]',
                },
            },
        });
        let inFlightBalanceReadCount = 0;
        const inFlightSettlementPublicClient = {
            async readContract({ functionName }) {
                if (functionName === 'balanceOf') {
                    inFlightBalanceReadCount += 1;
                    return 0n;
                }
                throw new Error(`Unsupported readContract function in test: ${functionName}`);
            },
            async getTransactionReceipt() {
                throw new Error('receipt unavailable');
            },
        };
        try {
            await resetModuleStateForTest({ config: inFlightSettlementConfig });
            const inFlightPolicy = resolvePolicy(inFlightSettlementConfig);
            const inFlightScope = buildStateScope({
                config: inFlightSettlementConfig,
                policy: inFlightPolicy,
                chainId: inFlightSettlementConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const inFlightState = createEmptyState(inFlightScope);
            const inFlightMarket = createEmptyMarketState({
                policy: inFlightPolicy,
                config: inFlightSettlementConfig,
                marketId: 'market-1',
            });
            inFlightMarket.revision = 1;
            inFlightMarket.publishedRevision = 1;
            inFlightMarket.lastPublishedSequence = 1;
            inFlightMarket.lastPublishedCid = 'bafy-in-flight-settlement';
            inFlightMarket.trades = [
                {
                    tradeId: 'in-flight-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs - 60_000,
                    principalContributionWei: '1000000',
                    collateralAmountWei: '1000000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            inFlightMarket.tradeClassifications['in-flight-trade-1'] = {
                classification: 'reimbursable',
                firstSeenAtMs,
                reason: null,
                cid: 'bafy-in-flight-classification',
            };
            inFlightMarket.settlement.finalSettlementValueWei = '700000';
            inFlightMarket.settlement.settledAtMs = firstSeenAtMs + 120_000;
            inFlightMarket.settlement.settlementKind = 'resolved';
            inFlightMarket.settlement.depositTxHash = `0x${'e'.repeat(64)}`;
            inFlightMarket.settlement.depositSubmittedAtMs = firstSeenAtMs + 121_000;
            inFlightState.markets['market-1'] = inFlightMarket;
            await setModuleStateForTest({
                config: inFlightSettlementConfig,
                state: inFlightState,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: inFlightSettlementPublicClient,
                config: inFlightSettlementConfig,
            });
            assert.equal(inFlightBalanceReadCount, 0);
            assert.equal(toolCalls.length, 0);
            const inFlightStateAfter = getModuleState();
            assert.equal(
                inFlightStateAfter.markets['market-1'].settlement.finalSettlementValueWei,
                '700000'
            );
            assert.equal(
                inFlightStateAfter.markets['market-1'].settlement.settledAtMs,
                firstSeenAtMs + 120_000
            );
            assert.equal(
                inFlightStateAfter.markets['market-1'].settlement.depositTxHash,
                `0x${'e'.repeat(64)}`
            );
            assert.equal(
                inFlightStateAfter.markets['market-1'].settlement.depositSubmittedAtMs,
                firstSeenAtMs + 121_000
            );
            assert.equal(
                inFlightStateAfter.markets['market-1'].settlement.depositConfirmedAtMs,
                null
            );
        } finally {
            await resetModuleStateForTest({ config: inFlightSettlementConfig });
            inFlightSettlementFetch.stop();
        }

        const fractionalSettlementConfig = buildBaseConfig({
            messagePublishApiPort: 9892,
            polymarketClobEnabled: true,
            polymarketClobApiKey: 'clob-key',
            polymarketClobApiSecret: 'clob-secret',
            polymarketClobApiPassphrase: 'clob-passphrase',
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    marketsById: {
                        'market-1': {
                            label: 'Fractional settlement market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const fractionalSettlementPublicClient = {
            async readContract({ functionName, args }) {
                if (functionName === 'balanceOf') {
                    const tokenId = BigInt(args?.[1] ?? 0n).toString();
                    if (tokenId === '11') {
                        return 1n;
                    }
                    return 0n;
                }
                throw new Error(`Unsupported readContract function in test: ${functionName}`);
            },
            async getTransactionReceipt({ hash }) {
                return {
                    transactionHash: hash,
                    status: 1n,
                    logs: [],
                };
            },
        };
        const fractionalSettlementFetch = createMockDirectExecutionFetch({
            activity: [
                {
                    id: 'source-fractional-trade-1',
                    side: 'BUY',
                    outcome: 'YES',
                    price: 0.4,
                    timestamp: new Date(firstSeenAtMs - 30_000).toISOString(),
                },
            ],
            marketById: {
                'market-1': [
                    {
                        id: 'market-1',
                        outcomePrices: '["0.4","0.6"]',
                        outcomes: '["Yes","No"]',
                        closed: false,
                        umaResolutionStatus: 'pending',
                    },
                    {
                        id: 'market-1',
                        outcomePrices: '["0.5","0.5"]',
                        outcomes: '["Yes","No"]',
                        closed: true,
                        umaResolutionStatus: 'resolved',
                        closedTime: new Date(firstSeenAtMs + 180_000).toISOString(),
                        clobTokenIds: '["11","22"]',
                    },
                ],
            },
            orderById: {
                'direct-fractional-order-1': {
                    order: {
                        id: 'direct-fractional-order-1',
                        status: 'MATCHED',
                        original_size: 2.5,
                        size_matched: 2.5,
                    },
                },
            },
            tradesByOrderId: {
                'direct-fractional-order-1': [
                    {
                        id: 'trade-fractional-fill-1',
                        status: 'CONFIRMED',
                        taker_order_id: 'direct-fractional-order-1',
                        price: '0.4',
                        size: '2.5',
                    },
                ],
            },
        });
        const fractionalSettlementMockNode = createMockPublicationFetch(fractionalSettlementConfig);
        try {
            await resetModuleStateForTest({ config: fractionalSettlementConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: fractionalSettlementPublicClient,
                config: fractionalSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');

            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: 'direct-fractional-order-1',
                            status: 'LIVE',
                        },
                    },
                },
                config: fractionalSettlementConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: fractionalSettlementPublicClient,
                config: fractionalSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const firstFractionalPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient: fractionalSettlementPublicClient,
                config: fractionalSettlementConfig,
            });
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: firstFractionalPublication,
                config: fractionalSettlementConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: fractionalSettlementPublicClient,
                config: fractionalSettlementConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const fractionalSettlementArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(
                fractionalSettlementArgs.message.payload.summary.finalSettlementValueWei,
                '0'
            );
            assert.equal(
                fractionalSettlementArgs.message.payload.summary.settlementKind,
                'resolved'
            );
        } finally {
            fractionalSettlementMockNode.stop();
            fractionalSettlementFetch.stop();
        }

        const bootstrapSettledConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'bootstrap-settled-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Bootstrap settled market',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                    },
                },
            },
        });
        const bootstrapSettledFetch = createMockDirectExecutionFetch({});
        try {
            await resetModuleStateForTest({ config: bootstrapSettledConfig });
            const bootstrapSettledPolicy = resolvePolicy(bootstrapSettledConfig);
            const bootstrapSettledScope = buildStateScope({
                config: bootstrapSettledConfig,
                policy: bootstrapSettledPolicy,
                chainId: bootstrapSettledConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const bootstrapSettledState = createEmptyState(bootstrapSettledScope);
            const bootstrapSettledMarket = createEmptyMarketState({
                policy: bootstrapSettledPolicy,
                config: bootstrapSettledConfig,
                marketId: 'market-1',
            });
            bootstrapSettledMarket.revision = 1;
            bootstrapSettledMarket.publishedRevision = 1;
            bootstrapSettledMarket.lastPublishedSequence = 1;
            bootstrapSettledMarket.lastPublishedCid = 'bafy-bootstrap-settled';
            bootstrapSettledMarket.trades = [
                {
                    tradeId: 'bootstrap-settled-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs - 60_000,
                    principalContributionWei: '1000000',
                    collateralAmountWei: '1000000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            bootstrapSettledMarket.tradeClassifications['bootstrap-settled-trade-1'] = {
                classification: 'reimbursable',
                firstSeenAtMs,
                reason: null,
                cid: 'bafy-bootstrap-classification',
            };
            bootstrapSettledMarket.settlement.finalSettlementValueWei = '700000';
            bootstrapSettledMarket.settlement.settledAtMs = firstSeenAtMs + 120_000;
            bootstrapSettledMarket.settlement.settlementKind = 'resolved';
            bootstrapSettledMarket.settlement.depositConfirmedAtMs = firstSeenAtMs + 121_000;
            bootstrapSettledMarket.reimbursement.requestId = 'bootstrap-reimbursement-1';
            bootstrapSettledMarket.reimbursement.requestDispatchAtMs = firstSeenAtMs + 122_000;
            bootstrapSettledMarket.reimbursement.pendingMessage = {
                chainId: TEST_CHAIN_ID,
                requestId: 'bootstrap-reimbursement-1',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
                payload: {
                    stream: bootstrapSettledMarket.stream,
                    snapshotCid: 'bafy-bootstrap-settled',
                },
            };
            bootstrapSettledState.markets['market-1'] = bootstrapSettledMarket;
            await writePersistedState(
                bootstrapSettledConfig.agentConfig.polymarketStakedExternalSettlement.stateFile,
                bootstrapSettledState
            );
            await resetModuleStateForTest({ config });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: bootstrapSettledConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const bootstrapSettledArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(
                bootstrapSettledArgs.message.kind,
                POLYMARKET_REIMBURSEMENT_REQUEST_KIND
            );
            assert.equal(
                bootstrapSettledArgs.message.requestId,
                'bootstrap-reimbursement-1'
            );
            assert.equal(
                bootstrapSettledArgs.message.payload.snapshotCid,
                'bafy-bootstrap-settled'
            );
        } finally {
            await resetModuleStateForTest({ config: bootstrapSettledConfig });
            bootstrapSettledFetch.stop();
        }

        const directPreflightFailureConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'direct-preflight-failure-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Direct market missing CLOB config',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                        'market-2': {
                            label: 'Bootstrap reimbursement market',
                            userAddress: TEST_USER,
                        },
                    },
                },
            },
        });
        const directPreflightFailureFetch = createMockDirectExecutionFetch({
            activity: [
                {
                    id: 'source-preflight-trade-1',
                    side: 'BUY',
                    outcome: 'YES',
                    price: 0.4,
                    timestamp: new Date(firstSeenAtMs - 30_000).toISOString(),
                },
            ],
        });
        try {
            await resetModuleStateForTest({ config: directPreflightFailureConfig });
            const directPreflightFailurePolicy = resolvePolicy(directPreflightFailureConfig);
            const directPreflightFailureScope = buildStateScope({
                config: directPreflightFailureConfig,
                policy: directPreflightFailurePolicy,
                chainId: directPreflightFailureConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const directPreflightFailureState = createEmptyState(directPreflightFailureScope);
            directPreflightFailureState.markets['market-1'] = createEmptyMarketState({
                policy: directPreflightFailurePolicy,
                config: directPreflightFailureConfig,
                marketId: 'market-1',
            });
            const bootstrapPreflightMarket = createEmptyMarketState({
                policy: directPreflightFailurePolicy,
                config: directPreflightFailureConfig,
                marketId: 'market-2',
            });
            bootstrapPreflightMarket.revision = 1;
            bootstrapPreflightMarket.publishedRevision = 1;
            bootstrapPreflightMarket.lastPublishedSequence = 1;
            bootstrapPreflightMarket.lastPublishedCid = 'bafy-preflight-failure-snapshot';
            bootstrapPreflightMarket.trades = [
                {
                    tradeId: 'bootstrap-preflight-failure-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs - 60_000,
                    principalContributionWei: '1000000',
                    collateralAmountWei: '1000000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            bootstrapPreflightMarket.tradeClassifications[
                'bootstrap-preflight-failure-trade-1'
            ] = {
                classification: 'reimbursable',
                firstSeenAtMs,
                reason: null,
                cid: 'bafy-preflight-failure-classification',
            };
            bootstrapPreflightMarket.settlement.finalSettlementValueWei = '700000';
            bootstrapPreflightMarket.settlement.settledAtMs = firstSeenAtMs + 120_000;
            bootstrapPreflightMarket.settlement.settlementKind = 'resolved';
            bootstrapPreflightMarket.settlement.depositConfirmedAtMs =
                firstSeenAtMs + 121_000;
            bootstrapPreflightMarket.reimbursement.requestId =
                'bootstrap-preflight-failure-reimbursement-1';
            bootstrapPreflightMarket.reimbursement.requestDispatchAtMs =
                firstSeenAtMs + 122_000;
            bootstrapPreflightMarket.reimbursement.pendingMessage = {
                chainId: TEST_CHAIN_ID,
                requestId: 'bootstrap-preflight-failure-reimbursement-1',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
                payload: {
                    stream: bootstrapPreflightMarket.stream,
                    snapshotCid: 'bafy-preflight-failure-snapshot',
                },
            };
            directPreflightFailureState.markets['market-2'] = bootstrapPreflightMarket;
            await setModuleStateForTest({
                config: directPreflightFailureConfig,
                state: directPreflightFailureState,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: directPreflightFailureConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const directPreflightFailureStateAfter = getModuleState();
            assert.match(
                directPreflightFailureStateAfter.markets['market-1'].execution.orderError,
                /polymarketClobEnabled=true is required before direct Polymarket execution/i
            );
        } finally {
            await resetModuleStateForTest({ config: directPreflightFailureConfig });
            directPreflightFailureFetch.stop();
        }
        const sourceFetchFailureConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'source-fetch-failure-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Direct market with failing source fetch',
                            sourceUser: TEST_USER,
                            sourceMarket: 'market-1',
                            yesTokenId: '11',
                            noTokenId: '22',
                            initiatedCollateralAmountWei: '1000000',
                        },
                        'market-2': {
                            label: 'Bootstrap reimbursement market',
                            userAddress: TEST_USER,
                        },
                    },
                },
            },
        });
        const originalFetchForSourceFailure = globalThis.fetch;
        globalThis.fetch = async (url) => {
            const parsedUrl = new URL(String(url));
            if (parsedUrl.hostname === 'data-api.polymarket.com') {
                return textResponse(503, JSON.stringify({ error: 'down' }), 'Service Unavailable');
            }
            return originalFetchForSourceFailure(url);
        };
        try {
            await resetModuleStateForTest({ config: sourceFetchFailureConfig });
            const sourceFetchFailurePolicy = resolvePolicy(sourceFetchFailureConfig);
            const sourceFetchFailureScope = buildStateScope({
                config: sourceFetchFailureConfig,
                policy: sourceFetchFailurePolicy,
                chainId: sourceFetchFailureConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const sourceFetchFailureState = createEmptyState(sourceFetchFailureScope);
            sourceFetchFailureState.markets['market-1'] = createEmptyMarketState({
                policy: sourceFetchFailurePolicy,
                config: sourceFetchFailureConfig,
                marketId: 'market-1',
            });
            const bootstrapReimbursementMarket = createEmptyMarketState({
                policy: sourceFetchFailurePolicy,
                config: sourceFetchFailureConfig,
                marketId: 'market-2',
            });
            bootstrapReimbursementMarket.revision = 1;
            bootstrapReimbursementMarket.publishedRevision = 1;
            bootstrapReimbursementMarket.lastPublishedSequence = 1;
            bootstrapReimbursementMarket.lastPublishedCid = 'bafy-fetch-failure-snapshot';
            bootstrapReimbursementMarket.trades = [
                {
                    tradeId: 'bootstrap-fetch-failure-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs - 60_000,
                    principalContributionWei: '1000000',
                    collateralAmountWei: '1000000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            bootstrapReimbursementMarket.tradeClassifications[
                'bootstrap-fetch-failure-trade-1'
            ] = {
                classification: 'reimbursable',
                firstSeenAtMs,
                reason: null,
                cid: 'bafy-fetch-failure-classification',
            };
            bootstrapReimbursementMarket.settlement.finalSettlementValueWei = '700000';
            bootstrapReimbursementMarket.settlement.settledAtMs = firstSeenAtMs + 120_000;
            bootstrapReimbursementMarket.settlement.settlementKind = 'resolved';
            bootstrapReimbursementMarket.settlement.depositConfirmedAtMs =
                firstSeenAtMs + 121_000;
            bootstrapReimbursementMarket.reimbursement.requestId =
                'bootstrap-fetch-failure-reimbursement-1';
            bootstrapReimbursementMarket.reimbursement.requestDispatchAtMs =
                firstSeenAtMs + 122_000;
            bootstrapReimbursementMarket.reimbursement.pendingMessage = {
                chainId: TEST_CHAIN_ID,
                requestId: 'bootstrap-fetch-failure-reimbursement-1',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
                payload: {
                    stream: bootstrapReimbursementMarket.stream,
                    snapshotCid: 'bafy-fetch-failure-snapshot',
                },
            };
            sourceFetchFailureState.markets['market-2'] = bootstrapReimbursementMarket;
            await writePersistedState(
                sourceFetchFailureConfig.agentConfig.polymarketStakedExternalSettlement.stateFile,
                sourceFetchFailureState
            );
            await resetModuleStateForTest({ config });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: sourceFetchFailureConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const sourceFetchFailureStateAfter = getModuleState();
            assert.match(
                sourceFetchFailureStateAfter.markets['market-1'].execution.orderError,
                /Data API request failed \(503\)/
            );
        } finally {
            await resetModuleStateForTest({ config: sourceFetchFailureConfig });
            globalThis.fetch = originalFetchForSourceFailure;
        }
        await resetModuleStateForTest({ config });

        const timelyTradeSignal = buildSignal({
            requestId: 'trade-1',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs,
            text: 'Timely initiated trade',
            args: {
                marketId: 'market-1',
                tradeId: 'trade-1',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs - 5 * 60_000,
                principalContributionWei: '1000000',
                collateralAmountWei: '1000000',
                side: 'BUY',
                outcome: 'YES',
            },
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [timelyTradeSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        assert.equal(JSON.parse(toolCalls[0].arguments).bearerToken, 'k_message_publish_ops');
        const firstPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        assert.equal(firstPublication.status, 'published', JSON.stringify(firstPublication));
        assert.equal(firstPublication.validation.classifications[0].classification, 'reimbursable');
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: firstPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const lateTradeSignal = buildSignal({
            requestId: 'trade-2',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs + 60_000,
            text: 'Late initiated trade',
            args: {
                marketId: 'market-1',
                tradeId: 'trade-2',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs - 20 * 60_000,
                principalContributionWei: '500000',
                collateralAmountWei: '500000',
                side: 'BUY',
                outcome: 'NO',
            },
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [lateTradeSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const secondPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        assert.equal(
            secondPublication.validation.classifications[0].classification,
            'non_reimbursable_late'
        );
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: secondPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const settlementSignal = buildSignal({
            requestId: 'settlement-1',
            command: 'polymarket_settlement',
            receivedAtMs: firstSeenAtMs + 120_000,
            text: 'Market resolved with proceeds owed to the user',
            args: {
                marketId: 'market-1',
                finalSettlementValueWei: '700000',
                settledAtMs: firstSeenAtMs + 120_000,
                settlementKind: 'resolved',
            },
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [settlementSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const settlementPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: settlementPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        for (let attempts = 0; attempts < 3 && toolCalls[0].name === 'publish_signed_message'; attempts += 1) {
            const followUpPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient,
                config,
            });
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: followUpPublication,
                config,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config,
            });
        }
        assert.equal(toolCalls[0].name, 'make_deposit');
        assert.equal(JSON.parse(toolCalls[0].arguments).amountWei, '700000');
        await onToolOutput({
            name: 'make_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: `0x${'d'.repeat(64)}`,
            },
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const postDepositPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: postDepositPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const reimbursementRequestArgs = JSON.parse(toolCalls[0].arguments);
        assert.equal(
            reimbursementRequestArgs.message.kind,
            POLYMARKET_REIMBURSEMENT_REQUEST_KIND
        );
        assert.equal(
            reimbursementRequestArgs.message.payload.snapshotCid,
            postDepositPublication.cid
        );
        const delayedReimbursementRequestPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        let delayedSuccessState = getModuleState();
        const dispatchedReimbursementRevision =
            delayedSuccessState.markets['market-1'].reimbursement.pendingRevision;
        assert.equal(
            dispatchedReimbursementRevision,
            delayedSuccessState.markets['market-1'].revision
        );
        const settlementMetadataUpdateSignal = buildSignal({
            requestId: 'settlement-note-2',
            command: 'polymarket_settlement',
            receivedAtMs: firstSeenAtMs + 180_000,
            text: 'Settlement note update after reimbursement dispatch',
            args: {
                marketId: 'market-1',
                finalSettlementValueWei: '700000',
                settledAtMs: firstSeenAtMs + 120_000,
                settlementKind: 'resolved',
            },
        });
        toolCalls = await getDeterministicToolCalls({
            signals: [settlementMetadataUpdateSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const revisionBumpPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: revisionBumpPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: delayedReimbursementRequestPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });
        delayedSuccessState = getModuleState();
        assert.equal(
            delayedSuccessState.markets['market-1'].reimbursement.requestedRevision,
            dispatchedReimbursementRevision
        );
        assert.equal(delayedSuccessState.markets['market-1'].reimbursement.pendingRevision, null);
        assert.ok(
            delayedSuccessState.markets['market-1'].revision >
                delayedSuccessState.markets['market-1'].reimbursement.requestedRevision
        );
        toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const refreshedReimbursementArgs = JSON.parse(toolCalls[0].arguments);
        assert.equal(
            refreshedReimbursementArgs.message.kind,
            POLYMARKET_REIMBURSEMENT_REQUEST_KIND
        );
        assert.equal(
            refreshedReimbursementArgs.message.payload.snapshotCid,
            revisionBumpPublication.cid
        );
        assert.match(refreshedReimbursementArgs.message.requestId, /reimbursement:5$/);
        const reimbursementRequestPublication = await runPublishCall({
            toolCall: toolCalls[0],
            publicClient,
            config,
        });
        assert.equal(
            reimbursementRequestPublication.validation.validatorId,
            'polymarket_reimbursement_request'
        );
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: reimbursementRequestPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const state = getModuleState();
        assert.equal(state.markets['market-1'].tradeClassifications['trade-1'].classification, 'reimbursable');
        assert.equal(
            state.markets['market-1'].tradeClassifications['trade-2'].classification,
            'non_reimbursable_late'
        );
        assert.equal(
            state.markets['market-1'].reimbursement.requestCid,
            reimbursementRequestPublication.cid
        );
        const updatedSettlementSignal = buildSignal({
            requestId: 'settlement-reset-2',
            command: 'polymarket_settlement',
            receivedAtMs: firstSeenAtMs + 181_000,
            text: 'Updated settlement for reset test',
            args: {
                marketId: 'market-1',
                finalSettlementValueWei: '900000',
                settledAtMs: firstSeenAtMs + 181_000,
                settlementKind: 'resolved',
            },
        });
        toolCalls = await getDeterministicToolCalls({
            signals: [updatedSettlementSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const resetSettlementState = getModuleState();
        assert.equal(
            resetSettlementState.markets['market-1'].settlement.finalSettlementValueWei,
            '900000'
        );
        assert.equal(resetSettlementState.markets['market-1'].settlement.depositTxHash, null);
        assert.equal(
            resetSettlementState.markets['market-1'].settlement.depositConfirmedAtMs,
            null
        );
        assert.equal(
            computeOutstandingSettlementWei(resetSettlementState.markets['market-1']),
            '900000'
        );

        const staleDispatchConfig = buildBaseConfig({
            messagePublishApiPort: 9892,
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    dispatchGraceMs: 1,
                    marketsById: {
                        'stale-market-1': {
                            label: 'Stale dispatch market',
                        },
                    },
                },
            },
        });
        const staleTradeSignalA = buildSignal({
            requestId: 'stale-trade-1',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs + 210_000,
            text: 'Initial stale dispatch trade',
            args: {
                marketId: 'stale-market-1',
                tradeId: 'stale-trade-1',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs + 209_000,
                principalContributionWei: '100',
                collateralAmountWei: '100',
                side: 'BUY',
                outcome: 'YES',
            },
        });
        const staleTradeSignalB = buildSignal({
            requestId: 'stale-trade-2',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs + 220_000,
            text: 'Replacement stale dispatch trade',
            args: {
                marketId: 'stale-market-1',
                tradeId: 'stale-trade-2',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs + 219_000,
                principalContributionWei: '200',
                collateralAmountWei: '200',
                side: 'BUY',
                outcome: 'NO',
            },
        });
        const staleBaseNow = firstSeenAtMs + 230_000;
        const originalStaleDateNow = Date.now;
        const staleMockNode = createMockPublicationFetch(staleDispatchConfig);
        try {
            Date.now = () => staleBaseNow;
            await resetModuleStateForTest({ config: staleDispatchConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [staleTradeSignalA],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDispatchConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const firstStaleToolCall = toolCalls[0];
            const firstStalePublishArgs = JSON.parse(toolCalls[0].arguments);
            assert.match(firstStalePublishArgs.message.requestId, /:seq:1:rev:1$/);
            Date.now = () => staleBaseNow + 10;
            toolCalls = await getDeterministicToolCalls({
                signals: [staleTradeSignalB],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDispatchConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const secondStalePublishArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(secondStalePublishArgs.message.payload.sequence, 1);
            assert.notEqual(
                secondStalePublishArgs.message.requestId,
                firstStalePublishArgs.message.requestId
            );
            assert.match(secondStalePublishArgs.message.requestId, /:seq:1:rev:2$/);

            const lateFirstPublication = await runPublishCall({
                toolCall: firstStaleToolCall,
                publicClient,
                config: staleDispatchConfig,
            });
            assert.equal(
                lateFirstPublication.status,
                'published',
                JSON.stringify(lateFirstPublication)
            );
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: lateFirstPublication,
                config: staleDispatchConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            const reconciledState = getModuleState();
            assert.equal(reconciledState.markets['stale-market-1'].lastPublishedSequence, 1);
            assert.equal(reconciledState.markets['stale-market-1'].publishedRevision, 1);
            assert.equal(reconciledState.markets['stale-market-1'].pendingPublication, null);

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDispatchConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const recoveredPublishArgs = JSON.parse(toolCalls[0].arguments);
            assert.equal(recoveredPublishArgs.message.payload.sequence, 2);
            assert.match(recoveredPublishArgs.message.requestId, /:seq:2:rev:2$/);

            const recoveredPublication = await runPublishCall({
                toolCall: toolCalls[0],
                publicClient,
                config: staleDispatchConfig,
            });
            assert.equal(
                recoveredPublication.status,
                'published',
                'late reconciliation should unblock the next sequence instead of looping on sequence 1'
            );
        } finally {
            staleMockNode.stop();
            Date.now = originalStaleDateNow;
        }

        const timeoutConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    pendingTxTimeoutMs: 1,
                    marketsById: {
                        'market-1': {
                            label: 'Timeout retry market',
                        },
                    },
                },
            },
        });
        const timeoutSettlementSignal = buildSignal({
            requestId: 'timeout-settlement-1',
            command: 'polymarket_settlement',
            receivedAtMs: firstSeenAtMs + 240_000,
            text: 'Settlement for deposit timeout retry test',
            args: {
                marketId: 'market-1',
                finalSettlementValueWei: '300000',
                settledAtMs: firstSeenAtMs + 240_000,
                settlementKind: 'resolved',
            },
        });
        const timeoutTradeSignal = buildSignal({
            requestId: 'timeout-trade-1',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs + 239_000,
            text: 'Trade for deposit timeout retry test',
            args: {
                marketId: 'market-1',
                tradeId: 'timeout-trade-1',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs + 238_000,
                principalContributionWei: '300000',
                collateralAmountWei: '300000',
                side: 'BUY',
                outcome: 'YES',
            },
        });
        const timeoutSubmissionHash = `0x${'7'.repeat(64)}`;
        const timeoutBaseNow = Date.now();
        const originalDateNow = Date.now;
        const timeoutPublicClient = {
            async getTransactionReceipt({ hash }) {
                if (String(hash).toLowerCase() === timeoutSubmissionHash) {
                    throw new Error('receipt unavailable');
                }
                return publicClient.getTransactionReceipt({ hash });
            },
        };
        try {
            Date.now = () => timeoutBaseNow;
            await resetModuleStateForTest({ config: timeoutConfig });
            toolCalls = await getDeterministicToolCalls({
                signals: [timeoutTradeSignal, timeoutSettlementSignal],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: timeoutConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const timeoutPublicationArgs = JSON.parse(toolCalls[0].arguments);
            const timeoutPublication = {
                status: 'published',
                requestId: timeoutPublicationArgs.message.requestId,
                cid: 'bafy-timeout-publication-1',
                validation: {
                    validatorId: 'polymarket_trade_log_timeliness',
                    classifications: [
                        {
                            id: 'timeout-trade-1',
                            classification: 'reimbursable',
                            firstSeenAtMs: timeoutBaseNow,
                        },
                    ],
                },
            };
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: timeoutPublication,
                config: timeoutConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: timeoutConfig,
            });
            for (
                let attempts = 0;
                attempts < 10 && toolCalls[0].name === 'publish_signed_message';
                attempts += 1
            ) {
                const followUpPublication = await runPublishCall({
                    toolCall: toolCalls[0],
                    publicClient,
                    config: timeoutConfig,
                });
                await onToolOutput({
                    name: 'publish_signed_message',
                    parsedOutput: followUpPublication,
                    config: timeoutConfig,
                    commitmentSafe: TEST_COMMITMENT_SAFE,
                });
                toolCalls = await getDeterministicToolCalls({
                    signals: [],
                    commitmentSafe: TEST_COMMITMENT_SAFE,
                    agentAddress: TEST_AGENT.address,
                    publicClient,
                    config: timeoutConfig,
                });
            }
            assert.equal(toolCalls.length, 1);
            assert.equal(
                toolCalls[0].name,
                'make_deposit',
                'timeout path should reach initial make_deposit after draining follow-up publications'
            );
            await onToolOutput({
                name: 'make_deposit',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: timeoutSubmissionHash,
                },
                config: timeoutConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });

            Date.now = () => timeoutBaseNow + 10;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: timeoutPublicClient,
                config: timeoutConfig,
            });
            const timeoutState = getModuleState();
            assert.equal(
                timeoutState.markets['market-1'].settlement.depositTxHash,
                timeoutSubmissionHash
            );
            assert.equal(
                timeoutState.markets['market-1'].settlement.depositSubmittedAtMs,
                null
            );
            assert.equal(
                timeoutState.markets['market-1'].settlement.depositConfirmedAtMs,
                null
            );
            assert.match(
                timeoutState.markets['market-1'].settlement.depositError,
                /automatic retry is blocked until the original tx hash is reconciled/i
            );
            assert.equal(
                toolCalls.length,
                1,
                'timeout path should publish the updated blocked state to the node'
            );
            assert.equal(toolCalls[0].name, 'publish_signed_message');
            const timeoutRecoveryPublicationArgs = JSON.parse(toolCalls[0].arguments);
            const timeoutRecoveryPublication = {
                status: 'published',
                requestId: timeoutRecoveryPublicationArgs.message.requestId,
                cid: 'bafy-timeout-publication-2',
                validation: {
                    validatorId: 'polymarket_trade_log_timeliness',
                    classifications: [
                        {
                            id: 'timeout-trade-1',
                            classification: 'reimbursable',
                            firstSeenAtMs: timeoutBaseNow,
                        },
                    ],
                },
            };
            await onToolOutput({
                name: 'publish_signed_message',
                parsedOutput: timeoutRecoveryPublication,
                config: timeoutConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: timeoutPublicClient,
                config: timeoutConfig,
            });
            assert.equal(
                toolCalls.length,
                0,
                'timeout path should stay blocked behind the original deposit tx hash instead of dispatching a second deposit'
            );
        } finally {
            Date.now = originalDateNow;
        }

        const staleDepositDispatchConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'stale-deposit-dispatch-state.json'),
                    dispatchGraceMs: 1,
                    marketsById: {
                        'market-1': {
                            label: 'Stale deposit dispatch market',
                        },
                    },
                },
            },
        });
        const staleDepositBaseNow = Date.now();
        const originalStaleDepositDateNow = Date.now;
        try {
            Date.now = () => staleDepositBaseNow;
            await resetModuleStateForTest({ config });
            const staleDepositPolicy = resolvePolicy(staleDepositDispatchConfig);
            const staleDepositScope = buildStateScope({
                config: staleDepositDispatchConfig,
                policy: staleDepositPolicy,
                chainId: staleDepositDispatchConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const persistedStaleDepositState = createEmptyState(staleDepositScope);
            const staleMarketState = createEmptyMarketState({
                policy: staleDepositPolicy,
                config: staleDepositDispatchConfig,
                marketId: 'market-1',
            });
            staleMarketState.revision = 1;
            staleMarketState.publishedRevision = 1;
            staleMarketState.lastPublishedSequence = 1;
            staleMarketState.trades = [
                {
                    tradeId: 'stale-deposit-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs + 259_000,
                    principalContributionWei: '400000',
                    collateralAmountWei: '400000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            staleMarketState.tradeClassifications['stale-deposit-trade-1'] = {
                classification: 'reimbursable',
                firstSeenAtMs: firstSeenAtMs + 260_000,
                reason: null,
                cid: 'bafy-stale-deposit-fixture',
            };
            staleMarketState.settlement.finalSettlementValueWei = '400000';
            staleMarketState.settlement.settledAtMs = firstSeenAtMs + 261_000;
            staleMarketState.settlement.settlementKind = 'resolved';
            staleMarketState.settlement.depositDispatchAtMs = staleDepositBaseNow;
            persistedStaleDepositState.markets['market-1'] = staleMarketState;
            await writePersistedState(
                staleDepositDispatchConfig.agentConfig.polymarketStakedExternalSettlement.stateFile,
                persistedStaleDepositState
            );

            Date.now = () => staleDepositBaseNow + 10;
            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: staleDepositDispatchConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'make_deposit');
            const staleDepositState = getModuleState();
            assert.equal(
                staleDepositState.markets['market-1'].settlement.depositTxHash,
                null
            );
            assert.equal(
                staleDepositState.markets['market-1'].settlement.depositDispatchAtMs,
                staleDepositBaseNow + 10
            );
            assert.match(
                staleDepositState.markets['market-1'].settlement.depositError,
                /dispatch expired before tool output arrived/i
            );
        } finally {
            Date.now = originalStaleDepositDateNow;
        }

        const blockedPublicationConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    stateFile: path.join(scopeTmpDir, 'blocked-publication-state.json'),
                    marketsById: {
                        'market-1': {
                            label: 'Blocked publication market',
                        },
                    },
                },
            },
        });
        const blockedPublicationNow = firstSeenAtMs + 280_000;
        const originalBlockedPublicationDateNow = Date.now;
        try {
            Date.now = () => blockedPublicationNow;
            await resetModuleStateForTest({ config });
            const blockedPublicationPolicy = resolvePolicy(blockedPublicationConfig);
            const blockedPublicationScope = buildStateScope({
                config: blockedPublicationConfig,
                policy: blockedPublicationPolicy,
                chainId: blockedPublicationConfig.chainId,
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
            });
            const persistedBlockedPublicationState = createEmptyState(blockedPublicationScope);
            const blockedMarketState = createEmptyMarketState({
                policy: blockedPublicationPolicy,
                config: blockedPublicationConfig,
                marketId: 'market-1',
            });
            blockedMarketState.revision = 1;
            blockedMarketState.publishedRevision = 0;
            blockedMarketState.lastPublishedSequence = 0;
            blockedMarketState.trades = [
                {
                    tradeId: 'blocked-publication-trade-1',
                    tradeEntryKind: 'initiated',
                    executedAtMs: firstSeenAtMs + 270_000,
                    principalContributionWei: '250000',
                    collateralAmountWei: '250000',
                    side: 'BUY',
                    outcome: 'YES',
                },
            ];
            blockedMarketState.tradeClassifications['blocked-publication-trade-1'] = {
                classification: 'reimbursable',
                firstSeenAtMs: blockedPublicationNow,
                reason: null,
                cid: 'bafy-blocked-publication-fixture',
            };
            blockedMarketState.settlement.finalSettlementValueWei = '250000';
            blockedMarketState.settlement.settledAtMs = firstSeenAtMs + 275_000;
            blockedMarketState.settlement.settlementKind = 'resolved';
            const blockedPublicationMessage = buildTradeLogMessage({
                market: blockedMarketState,
                config: blockedPublicationConfig,
                agentAddress: TEST_AGENT.address,
                revision: blockedMarketState.revision,
            });
            blockedMarketState.pendingPublication = {
                requestId: blockedPublicationMessage.requestId,
                sequence: blockedPublicationMessage.payload.sequence,
                revision: blockedMarketState.revision,
                dispatchAtMs: blockedPublicationNow - 1,
                message: blockedPublicationMessage,
            };
            persistedBlockedPublicationState.markets['market-1'] = blockedMarketState;
            await writePersistedState(
                blockedPublicationConfig.agentConfig.polymarketStakedExternalSettlement.stateFile,
                persistedBlockedPublicationState
            );

            toolCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: blockedPublicationConfig,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(
                toolCalls[0].name,
                'make_deposit',
                'retrying a blocked publication should not starve settlement repayment'
            );
            const blockedPublicationState = getModuleState();
            assert.equal(
                blockedPublicationState.markets['market-1'].pendingPublication.requestId,
                blockedPublicationMessage.requestId
            );
            assert.equal(
                typeof blockedPublicationState.markets['market-1'].settlement.depositDispatchAtMs,
                'number'
            );
        } finally {
            Date.now = originalBlockedPublicationDateNow;
        }

        const scopeConfigA = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: scopeBaseModuleConfig,
            },
        });
        const scopeConfigB = buildBaseConfig({
            watchAssets: ['0x5555555555555555555555555555555555555555'],
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    ...scopeBaseModuleConfig,
                    collateralToken: '0x5555555555555555555555555555555555555555',
                    marketsById: {
                        'market-1': {
                            label: 'Scoped market',
                            userAddress: '0x6666666666666666666666666666666666666666',
                        },
                    },
                },
            },
        });
        const scopeSignal = buildSignal({
            requestId: 'scope-trade-1',
            command: 'polymarket_trade',
            receivedAtMs: firstSeenAtMs,
            text: 'Scope test initiated trade',
            args: {
                marketId: 'market-1',
                tradeId: 'scope-trade-1',
                tradeEntryKind: 'initiated',
                executedAtMs: firstSeenAtMs - 60_000,
                principalContributionWei: '1',
                collateralAmountWei: '1',
                side: 'BUY',
                outcome: 'YES',
            },
        });
        await resetModuleStateForTest({ config: scopeConfigA });
        await getDeterministicToolCalls({
            signals: [scopeSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config: scopeConfigA,
        });
        await assert.rejects(
            async () =>
                getDeterministicToolCalls({
                    signals: [],
                    commitmentSafe: TEST_COMMITMENT_SAFE,
                    agentAddress: TEST_AGENT.address,
                    publicClient,
                    config: scopeConfigB,
                }),
            /Persisted module state scope/
        );
        await resetModuleStateForTest({ config: scopeConfigA });

        await resetModuleStateForTest({ config });
        const replayToolCalls = await getDeterministicToolCalls({
            signals: [timelyTradeSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        const replayPublication = await runPublishCall({
            toolCall: replayToolCalls[0],
            publicClient,
            config,
        });
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: replayPublication,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const withdrawalProposalSignal = {
            kind: 'proposal',
            proposalHash: `0x${'9'.repeat(64)}`,
            assertionId: `0x${'8'.repeat(64)}`,
            proposer: TEST_USER,
            transactions: [
                {
                    to: TEST_USDC,
                    value: 0n,
                    operation: 0,
                    data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'transfer',
                        args: [TEST_USER, 1_000_000n],
                    }),
                },
            ],
            explanation: 'User withdrawal while unsettled market remains.',
        };

        toolCalls = await getDeterministicToolCalls({
            signals: [withdrawalProposalSignal],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            onchainPendingProposal: true,
        });
        assert.equal(toolCalls.length, 0);
    } finally {
        mockNode.stop();
        await rm(scopeTmpDir, { recursive: true, force: true });
        await resetModuleStateForTest({ config });
    }

    console.log('[test] polymarket-staked-external-settlement agent OK');
}

run().catch((error) => {
    console.error('[test] polymarket-staked-external-settlement agent failed:', error?.message ?? error);
    process.exit(1);
});
