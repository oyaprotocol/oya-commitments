import assert from 'node:assert/strict';
import { MessagePublicationValidationError } from '../../../agent/src/lib/message-publication-validation.js';
import { validatePublishedMessage } from './agent.js';

const TEST_AGENT = '0x2967C076182F0303037072670e744e26Ed4A830f';
const TEST_COMMITMENT_SAFE = '0x1111111111111111111111111111111111111111';
const TEST_OG_MODULE = '0x2222222222222222222222222222222222222222';
const TEST_USER = '0x3333333333333333333333333333333333333333';
const TEST_TRADING_WALLET = '0x4444444444444444444444444444444444444444';
const TEST_CHAIN_ID = 137;
const TEST_RULES = `Staked External Polymarket Execution
---
The designated agent at address ${TEST_AGENT} must deposit a stake of 1000 USDC to be considered the active agent.

To track this external trading, the agent will periodically sign an updated log documenting all of their trades, and send to the node at address 0x5555555555555555555555555555555555555555 for a second signature, and publication to IPFS.

Trades must be logged within 15 minutes of trade execution to be considered valid for reimbursement.
`;

const BASE_CONFIG = {
    chainId: TEST_CHAIN_ID,
    commitmentSafe: TEST_COMMITMENT_SAFE,
    ogModule: TEST_OG_MODULE,
    agentConfig: {
        polymarketStakedExternalSettlement: {
            authorizedAgent: TEST_AGENT,
            tradingWallet: TEST_TRADING_WALLET,
        },
    },
};

const mockPublicClient = {
    async readContract({ functionName }) {
        assert.equal(functionName, 'rules');
        return TEST_RULES;
    },
};

function buildTrade({
    tradeId,
    executedAtMs,
    tradeEntryKind = 'initiated',
    externalTradeId = undefined,
} = {}) {
    return {
        tradeId,
        executedAtMs,
        tradeEntryKind,
        ...(externalTradeId ? { externalTradeId } : {}),
    };
}

function buildTradeLogMessage({
    requestId = 'trade-log-1',
    sequence = 1,
    previousCid = null,
    trades = [],
    marketId = 'market-1',
    tradingWallet = TEST_TRADING_WALLET,
} = {}) {
    return {
        chainId: TEST_CHAIN_ID,
        requestId,
        commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
        agentAddress: TEST_AGENT,
        kind: 'polymarketTradeLog',
        payload: {
            stream: {
                commitmentSafe: TEST_COMMITMENT_SAFE,
                ogModule: TEST_OG_MODULE,
                user: TEST_USER,
                marketId,
                tradingWallet,
            },
            sequence,
            previousCid,
            trades,
        },
    };
}

function buildPublishedRecord({ message, cid }) {
    return {
        signer: TEST_AGENT.toLowerCase(),
        chainId: TEST_CHAIN_ID,
        requestId: message.requestId,
        cid,
        artifact: {
            signedMessage: {
                envelope: {
                    message,
                },
            },
        },
    };
}

async function run() {
    const firstSeenAtMs = 1_800_000_000_000;

    {
        const validation = await validatePublishedMessage({
            config: BASE_CONFIG,
            publicClient: mockPublicClient,
            message: buildTradeLogMessage({
                trades: [
                    buildTrade({
                        tradeId: 'trade-1',
                        executedAtMs: firstSeenAtMs - 5 * 60_000,
                    }),
                ],
            }),
            receivedAtMs: firstSeenAtMs,
            publishedAtMs: firstSeenAtMs + 1_000,
            listRecords: async () => [],
        });

        assert.equal(validation.validatorId, 'polymarket_trade_log_timeliness');
        assert.equal(validation.status, 'accepted');
        assert.deepEqual(validation.classifications, [
            {
                id: 'trade-1',
                classification: 'reimbursable',
                firstSeenAtMs,
            },
        ]);
        assert.equal(validation.summary.loggingWindowMinutes, 15);
        assert.equal(validation.summary.newTradeCount, 1);
        assert.equal(validation.summary.lateTradeCount, 0);
    }

    {
        const validation = await validatePublishedMessage({
            config: BASE_CONFIG,
            publicClient: mockPublicClient,
            message: buildTradeLogMessage({
                requestId: 'trade-log-late',
                trades: [
                    buildTrade({
                        tradeId: 'trade-late',
                        executedAtMs: firstSeenAtMs - 20 * 60_000,
                    }),
                ],
            }),
            receivedAtMs: firstSeenAtMs,
            publishedAtMs: firstSeenAtMs + 1_000,
            listRecords: async () => [],
        });

        assert.equal(validation.classifications[0].classification, 'non_reimbursable_late');
        assert.match(validation.classifications[0].reason, /limit is 15 minute/);
        assert.equal(validation.summary.lateTradeCount, 1);
    }

    {
        await assert.rejects(
            () =>
                validatePublishedMessage({
                    config: BASE_CONFIG,
                    publicClient: mockPublicClient,
                    message: buildTradeLogMessage({
                        requestId: 'trade-log-wallet-mismatch',
                        trades: [
                            buildTrade({
                                tradeId: 'trade-wallet-mismatch',
                                executedAtMs: firstSeenAtMs - 5 * 60_000,
                            }),
                        ],
                        marketId: 'market-wallet-mismatch',
                        tradingWallet: '0x5555555555555555555555555555555555555555',
                    }),
                    receivedAtMs: firstSeenAtMs,
                    publishedAtMs: firstSeenAtMs + 1_000,
                    listRecords: async () => [],
                }).then(() => {
                    throw new Error('expected wallet mismatch to fail');
                }),
            (error) => {
                assert.ok(error instanceof MessagePublicationValidationError);
                assert.equal(error.code, 'message_payload_invalid');
                assert.match(error.message, /tradingWallet/);
                return true;
            }
        );
    }

    {
        await assert.rejects(
            () =>
                validatePublishedMessage({
                    config: BASE_CONFIG,
                    publicClient: mockPublicClient,
                    envelope: {
                        address: '0x5555555555555555555555555555555555555555',
                    },
                    message: buildTradeLogMessage({
                        requestId: 'trade-log-signer-mismatch',
                        trades: [
                            buildTrade({
                                tradeId: 'trade-signer-mismatch',
                                executedAtMs: firstSeenAtMs - 5 * 60_000,
                            }),
                        ],
                    }),
                    receivedAtMs: firstSeenAtMs,
                    publishedAtMs: firstSeenAtMs + 1_000,
                    listRecords: async () => [],
                }),
            (error) => {
                assert.ok(error instanceof MessagePublicationValidationError);
                assert.equal(error.code, 'message_payload_invalid');
                assert.match(error.message, /authenticated signing address/);
                return true;
            }
        );
    }

    {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            throw new Error('rpc offline');
        };
        try {
            await assert.rejects(
                () =>
                    validatePublishedMessage({
                        config: {
                            ...BASE_CONFIG,
                            rpcUrl: 'http://rpc.test.local',
                        },
                        message: buildTradeLogMessage({
                            requestId: 'trade-log-runtime-init-failure',
                            trades: [
                                buildTrade({
                                    tradeId: 'trade-runtime-init-failure',
                                    executedAtMs: firstSeenAtMs - 5 * 60_000,
                                }),
                            ],
                        }),
                        receivedAtMs: firstSeenAtMs,
                        publishedAtMs: firstSeenAtMs + 1_000,
                        listRecords: async () => [],
                    }),
                (error) => {
                    assert.ok(error instanceof MessagePublicationValidationError);
                    assert.equal(error.code, 'message_validation_unavailable');
                    assert.equal(error.statusCode, 503);
                    assert.match(error.message, /read-only runtime/i);
                    assert.match(error.message, /rpc offline/i);
                    return true;
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    {
        const priorMessage = buildTradeLogMessage({
            requestId: 'trade-log-prior',
            sequence: 1,
            trades: [
                buildTrade({
                    tradeId: 'trade-old',
                    executedAtMs: firstSeenAtMs - 20 * 60_000,
                }),
            ],
        });
        const priorRecord = buildPublishedRecord({
            message: priorMessage,
            cid: 'bafy-prior-trade-log',
        });

        const laterSeenAtMs = firstSeenAtMs + 4 * 60 * 60_000;
        const validation = await validatePublishedMessage({
            config: BASE_CONFIG,
            publicClient: mockPublicClient,
            message: buildTradeLogMessage({
                requestId: 'trade-log-next',
                sequence: 2,
                previousCid: priorRecord.cid,
                trades: [
                    ...priorMessage.payload.trades,
                    buildTrade({
                        tradeId: 'trade-new',
                        executedAtMs: laterSeenAtMs - 5 * 60_000,
                        tradeEntryKind: 'continuation',
                    }),
                ],
            }),
            receivedAtMs: laterSeenAtMs,
            publishedAtMs: laterSeenAtMs + 1_000,
            listRecords: async () => [priorRecord],
        });

        assert.deepEqual(validation.classifications, [
            {
                id: 'trade-new',
                classification: 'reimbursable',
                firstSeenAtMs: laterSeenAtMs,
            },
        ]);
        assert.equal(validation.summary.previousPublishedCid, priorRecord.cid);
        assert.equal(validation.summary.newTradeCount, 1);
    }

    {
        const priorMessage = buildTradeLogMessage({
            requestId: 'trade-log-prev-cid',
            sequence: 1,
            trades: [
                buildTrade({
                    tradeId: 'trade-prev',
                    executedAtMs: firstSeenAtMs - 2 * 60_000,
                }),
            ],
        });
        const priorRecord = buildPublishedRecord({
            message: priorMessage,
            cid: 'bafy-prev-cid',
        });

        await assert.rejects(
            () =>
                validatePublishedMessage({
                    config: BASE_CONFIG,
                    publicClient: mockPublicClient,
                    message: buildTradeLogMessage({
                        requestId: 'trade-log-bad-sequence',
                        sequence: 2,
                        previousCid: 'bafy-wrong-cid',
                        trades: [
                            ...priorMessage.payload.trades,
                            buildTrade({
                                tradeId: 'trade-next',
                                executedAtMs: firstSeenAtMs + 60_000,
                            }),
                        ],
                    }),
                    receivedAtMs: firstSeenAtMs + 5 * 60_000,
                    publishedAtMs: firstSeenAtMs + 5 * 60_000 + 1_000,
                    listRecords: async () => [priorRecord],
                }),
            (error) => {
                assert.ok(error instanceof MessagePublicationValidationError);
                assert.equal(error.code, 'message_sequence_invalid');
                return true;
            }
        );
    }

    {
        const validation = await validatePublishedMessage({
            config: BASE_CONFIG,
            publicClient: mockPublicClient,
            message: {
                chainId: TEST_CHAIN_ID,
                requestId: 'not-a-trade-log',
                commitmentAddresses: [TEST_COMMITMENT_SAFE],
                agentAddress: TEST_AGENT,
                kind: 'otherMessageKind',
                payload: {},
            },
            receivedAtMs: firstSeenAtMs,
            publishedAtMs: firstSeenAtMs,
            listRecords: async () => [],
        });
        assert.equal(validation, null);
    }

    console.log('[test] polymarket-staked-external-settlement validator OK');
}

run().catch((error) => {
    console.error(
        '[test] polymarket-staked-external-settlement validator failed:',
        error?.message ?? error
    );
    process.exit(1);
});
