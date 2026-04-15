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
    validatePublishedMessage,
} from './agent.js';
import {
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
        async text() {
            return text;
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

        let toolCalls = await getDeterministicToolCalls({
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
        assert.equal(firstPublication.status, 'published');
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
            assert.equal(lateFirstPublication.status, 'published');
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
