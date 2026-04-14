import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
    resolvePolicy,
} from './trade-ledger.js';

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
        messagePublishApiKeys: {},
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
        await resetModuleStateForTest({ config });
    }

    console.log('[test] polymarket-staked-external-settlement agent OK');
}

run().catch((error) => {
    console.error('[test] polymarket-staked-external-settlement agent failed:', error?.message ?? error);
    process.exit(1);
});
