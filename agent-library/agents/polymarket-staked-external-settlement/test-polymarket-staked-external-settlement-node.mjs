import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    encodeFunctionData,
    erc20Abi,
    keccak256,
    padHex,
    stringToHex,
    toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeErc20TransferCallData } from '../../../agent/src/lib/utils.js';
import {
    getDeterministicToolCalls,
    getNodeDeterministicToolCalls,
    getNodeState,
    onNodeProposalEvents,
    onNodeToolOutput,
    onToolOutput,
    resetModuleStateForTest,
    resetNodeStateForTest,
    validatePublishedMessage,
} from './agent.js';

const TEST_AGENT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const TEST_CHAIN_ID = 137;
const TEST_COMMITMENT_SAFE = '0x1111111111111111111111111111111111111111';
const TEST_OG_MODULE = '0x2222222222222222222222222222222222222222';
const TEST_USER = '0x3333333333333333333333333333333333333333';
const TEST_FOREIGN_USER = '0x7777777777777777777777777777777777777777';
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
        proposalPublishApiEnabled: true,
        proposalPublishApiHost: '127.0.0.1',
        proposalPublishApiPort: 9890,
        proposalPublishApiMode: 'propose',
        proposalPublishApiKeys: {
            ops: 'k_proposal_publish_ops',
        },
        watchAssets: [TEST_USDC],
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

function buildMockPublicClient() {
    return {
        async readContract({ functionName }) {
            assert.equal(functionName, 'rules');
            return TEST_RULES;
        },
        async getTransactionReceipt({ hash }) {
            if (String(hash).toLowerCase() === `0x${'d'.repeat(64)}`) {
                return {
                    transactionHash: hash,
                    status: 1n,
                    logs: [
                        {
                            address: TEST_USDC,
                            topics: [
                                keccak256(stringToHex('Transfer(address,address,uint256)')),
                                padHex(TEST_AGENT.address.toLowerCase(), { size: 32 }),
                                padHex(TEST_COMMITMENT_SAFE.toLowerCase(), { size: 32 }),
                            ],
                            data: toHex(700000n, { size: 32 }),
                        },
                    ],
                };
            }
            return {
                transactionHash: hash,
                status: 1n,
                logs: [],
            };
        },
    };
}

async function publishToolCallToRecords({
    toolCall,
    config,
    records,
    publicClient,
}) {
    const args = JSON.parse(toolCall.arguments);
    return publishMessageToRecords({
        message: args.message,
        config,
        records,
        publicClient,
    });
}

async function publishMessageToRecords({
    message,
    config,
    records,
    publicClient,
}) {
    const receivedAtMs = Date.now();
    const publishedAtMs = receivedAtMs + 1;
    const validation = await validatePublishedMessage({
        config,
        envelope: {
            address: TEST_AGENT.address,
        },
        message,
        receivedAtMs,
        publishedAtMs,
        listRecords: async () => records,
        publicClient,
    });
    const canonical = JSON.stringify(message);
    const cid = `bafy${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
    records.push({
        signer: TEST_AGENT.address.toLowerCase(),
        chainId: TEST_CHAIN_ID,
        requestId: message.requestId,
        receivedAtMs,
        publishedAtMs,
        createdAtMs: publishedAtMs,
        updatedAtMs: publishedAtMs,
        cid,
        uri: `ipfs://${cid}`,
        pinned: true,
        signature: `0x${'b'.repeat(130)}`,
        canonicalMessage: canonical,
        artifact: {
            publication: {
                receivedAtMs,
                publishedAtMs,
                validation,
            },
            signedMessage: {
                envelope: {
                    message,
                },
            },
        },
    });
    return {
        status: 'published',
        cid,
        uri: `ipfs://${cid}`,
        validation,
        requestId: message.requestId,
    };
}

function appendPublishedRecord({
    message,
    validation,
    records,
    publishedAtMs = Date.now(),
}) {
    const canonical = JSON.stringify(message);
    const cid = `bafy${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
    records.push({
        signer: TEST_AGENT.address.toLowerCase(),
        chainId: TEST_CHAIN_ID,
        requestId: message.requestId,
        receivedAtMs: publishedAtMs - 1,
        publishedAtMs,
        createdAtMs: publishedAtMs,
        updatedAtMs: publishedAtMs,
        cid,
        uri: `ipfs://${cid}`,
        pinned: true,
        signature: `0x${'c'.repeat(130)}`,
        canonicalMessage: canonical,
        artifact: {
            publication: {
                receivedAtMs: publishedAtMs - 1,
                publishedAtMs,
                validation,
            },
            signedMessage: {
                envelope: {
                    message,
                },
            },
        },
    });
    return cid;
}

async function publishNextAgentMessage({
    signals,
    config,
    publicClient,
    records,
}) {
    const toolCalls = await getDeterministicToolCalls({
        signals,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        agentAddress: TEST_AGENT.address,
        publicClient,
        config,
    });
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'publish_signed_message');
    const publication = await publishToolCallToRecords({
        toolCall: toolCalls[0],
        config,
        records,
        publicClient,
    });
    await onToolOutput({
        name: 'publish_signed_message',
        parsedOutput: publication,
        config,
        commitmentSafe: TEST_COMMITMENT_SAFE,
    });
    return publication;
}

async function run() {
    const config = buildBaseConfig();
    const publicClient = buildMockPublicClient();
    const records = [];
    const messagePublicationStore = {
        async listRecords() {
            return records;
        },
    };
    const firstSeenAtMs = Date.now();

    try {
        await resetModuleStateForTest({ config });
        await resetNodeStateForTest({ config });

        await assert.rejects(
            async () =>
                getNodeDeterministicToolCalls({
                    signals: [],
                    commitmentSafe: TEST_COMMITMENT_SAFE,
                    agentAddress: '0x9999999999999999999999999999999999999999',
                    publicClient,
                    config,
                    messagePublicationStore,
                    onchainPendingProposal: false,
                }),
            /control node may only be served by authorized agent/i
        );

        await publishNextAgentMessage({
            signals: [
                buildSignal({
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
                }),
            ],
            config,
            publicClient,
            records,
        });

        const prematureReimbursementRequest = await publishMessageToRecords({
            message: {
                chainId: TEST_CHAIN_ID,
                requestId: 'premature-reimbursement-request',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: 'polymarketReimbursementRequest',
                payload: {
                    stream: {
                        commitmentSafe: TEST_COMMITMENT_SAFE,
                        ogModule: TEST_OG_MODULE,
                        user: TEST_USER,
                        marketId: 'market-1',
                        tradingWallet: TEST_TRADING_WALLET,
                    },
                    snapshotCid: records[0].cid,
                },
            },
            config,
            records,
            publicClient,
        });
        assert.equal(
            prematureReimbursementRequest.validation.validatorId,
            'polymarket_reimbursement_request'
        );
        let toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 0);

        toolCalls = await getNodeDeterministicToolCalls({
            signals: [
                {
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
                },
            ],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: true,
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'dispute_assertion');
        const disputeArgs = JSON.parse(toolCalls[0].arguments);
        assert.equal(disputeArgs.assertionId, `0x${'8'.repeat(64)}`);

        await onNodeToolOutput({
            callId: toolCalls[0].callId,
            name: toolCalls[0].name,
            parsedOutput: {
                status: 'submitted',
            },
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        await resetNodeStateForTest({ config });

        await publishNextAgentMessage({
            signals: [
                buildSignal({
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
                }),
            ],
            config,
            publicClient,
            records,
        });

        toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls[0].name, 'make_deposit');
        await onToolOutput({
            name: 'make_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: `0x${'d'.repeat(64)}`,
            },
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const postDepositPublication = await publishNextAgentMessage({
            signals: [],
            config,
            publicClient,
            records,
        });

        const reimbursementRequestPublication = await publishNextAgentMessage({
            signals: [],
            config,
            publicClient,
            records,
        });
        assert.equal(
            reimbursementRequestPublication.validation.validatorId,
            'polymarket_reimbursement_request'
        );
        assert.equal(
            reimbursementRequestPublication.validation.summary.snapshotCid,
            postDepositPublication.cid
        );

        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_proposal');
        const reimbursementArgs = JSON.parse(toolCalls[0].arguments);
        assert.equal(reimbursementArgs.timeoutMs, 10000);
        assert.equal(reimbursementArgs.bearerToken, 'k_proposal_publish_ops');
        assert.equal(
            reimbursementArgs.proposal.requestId,
            `polymarket-staked-external-settlement:market-1:proposal:${reimbursementRequestPublication.cid}`
        );
        assert.equal(reimbursementArgs.proposal.chainId, TEST_CHAIN_ID);
        assert.equal(reimbursementArgs.proposal.commitmentSafe, TEST_COMMITMENT_SAFE);
        assert.equal(reimbursementArgs.proposal.ogModule, TEST_OG_MODULE);
        assert.equal(reimbursementArgs.proposal.transactions.length, 1);
        const decodedTransfer = decodeErc20TransferCallData(
            reimbursementArgs.proposal.transactions[0].data
        );
        assert.equal(decodedTransfer?.amount?.toString(), '1000000');
        assert.equal(decodedTransfer?.to, TEST_AGENT.address.toLowerCase());
        assert.equal(
            reimbursementArgs.proposal.metadata.reimbursementRequestCid,
            reimbursementRequestPublication.cid
        );
        assert.equal(
            reimbursementArgs.proposal.metadata.publishedTradeLogCid,
            postDepositPublication.cid
        );
        assert.match(reimbursementArgs.proposal.explanation, /requestCid=/);

        await onNodeToolOutput({
            callId: toolCalls[0].callId,
            name: toolCalls[0].name,
            parsedOutput: {
                status: 'published',
                mode: 'propose',
                submission: {
                    status: 'resolved',
                    transactionHash: `0x${'e'.repeat(64)}`,
                    ogProposalHash: `0x${'f'.repeat(64)}`,
                },
            },
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });
        let nodeState = getNodeState();
        assert.equal(
            nodeState.markets['market-1'].reimbursement.proposalHash,
            `0x${'f'.repeat(64)}`
        );

        onNodeProposalEvents({
            executedProposals: [`0x${'f'.repeat(64)}`],
            deletedProposals: [],
        });
        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 0);
        nodeState = getNodeState();
        assert.equal(
            typeof nodeState.markets['market-1'].reimbursement.reimbursedAtMs,
            'number'
        );

        const hashlessUncertainConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    dispatchGraceMs: 1,
                    marketsById: {
                        'market-1': {
                            label: 'Test market',
                        },
                    },
                },
            },
        });
        const hashlessBaseNow = Date.now();
        const originalHashlessDateNow = Date.now;
        try {
            Date.now = () => hashlessBaseNow;
            await resetNodeStateForTest({ config: hashlessUncertainConfig });
            toolCalls = await getNodeDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: hashlessUncertainConfig,
                messagePublicationStore,
                onchainPendingProposal: false,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_proposal');
            await onNodeToolOutput({
                callId: toolCalls[0].callId,
                name: toolCalls[0].name,
                parsedOutput: {
                    status: 'published',
                    mode: 'propose',
                    submission: {
                        status: 'uncertain',
                        transactionHash: null,
                        ogProposalHash: null,
                    },
                },
                config: hashlessUncertainConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });
            nodeState = getNodeState();
            assert.equal(nodeState.markets['market-1'].reimbursement.submissionTxHash, null);
            assert.equal(nodeState.markets['market-1'].reimbursement.proposalHash, null);
            assert.equal(nodeState.markets['market-1'].reimbursement.submittedAtMs, null);
            assert.equal(
                typeof nodeState.markets['market-1'].reimbursement.dispatchAtMs,
                'number'
            );
            assert.match(
                nodeState.markets['market-1'].reimbursement.lastError,
                /did not return a transaction or proposal hash/i
            );
            toolCalls = await getNodeDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: hashlessUncertainConfig,
                messagePublicationStore,
                onchainPendingProposal: false,
            });
            assert.equal(toolCalls.length, 0);
            Date.now = () => hashlessBaseNow + 10;
            toolCalls = await getNodeDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: hashlessUncertainConfig,
                messagePublicationStore,
                onchainPendingProposal: false,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_proposal');
        } finally {
            Date.now = originalHashlessDateNow;
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
                            label: 'Test market',
                        },
                    },
                },
            },
        });
        const timeoutSubmissionHash = `0x${'1'.repeat(64)}`;
        const timeoutBaseNow = Date.now();
        const originalDateNow = Date.now;
        const timeoutPublicClient = buildMockPublicClient();
        const originalTimeoutGetReceipt =
            timeoutPublicClient.getTransactionReceipt.bind(timeoutPublicClient);
        timeoutPublicClient.getTransactionReceipt = async ({ hash }) => {
            if (String(hash).toLowerCase() === timeoutSubmissionHash) {
                throw new Error('receipt unavailable');
            }
            return originalTimeoutGetReceipt({ hash });
        };
        try {
            Date.now = () => timeoutBaseNow;
            await resetNodeStateForTest({ config: timeoutConfig });
            toolCalls = await getNodeDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient,
                config: timeoutConfig,
                messagePublicationStore,
                onchainPendingProposal: false,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_proposal');
            await onNodeToolOutput({
                callId: toolCalls[0].callId,
                name: toolCalls[0].name,
                parsedOutput: {
                    status: 'published',
                    mode: 'propose',
                    submission: {
                        status: 'submitted',
                        transactionHash: timeoutSubmissionHash,
                        ogProposalHash: null,
                    },
                },
                config: timeoutConfig,
                commitmentSafe: TEST_COMMITMENT_SAFE,
            });
            Date.now = () => timeoutBaseNow + 10;
            toolCalls = await getNodeDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_COMMITMENT_SAFE,
                agentAddress: TEST_AGENT.address,
                publicClient: timeoutPublicClient,
                config: timeoutConfig,
                messagePublicationStore,
                onchainPendingProposal: false,
            });
            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0].name, 'publish_signed_proposal');
            nodeState = getNodeState();
            assert.equal(nodeState.markets['market-1'].reimbursement.submissionTxHash, null);
            assert.equal(nodeState.markets['market-1'].reimbursement.submittedAtMs, null);
            assert.equal(
                typeof nodeState.markets['market-1'].reimbursement.dispatchAtMs,
                'number'
            );
            assert.match(
                nodeState.markets['market-1'].reimbursement.lastError,
                /could not be reconciled before timeout/i
            );
        } finally {
            Date.now = originalDateNow;
        }

        const sharedDepositConfig = buildBaseConfig({
            agentConfig: {
                polymarketStakedExternalSettlement: {
                    authorizedAgent: TEST_AGENT.address,
                    userAddress: TEST_USER,
                    tradingWallet: TEST_TRADING_WALLET,
                    collateralToken: TEST_USDC,
                    marketsById: {
                        'market-1': {
                            label: 'Shared deposit market one',
                        },
                        'market-2': {
                            label: 'Shared deposit market two',
                        },
                    },
                },
            },
        });
        await resetNodeStateForTest({ config: sharedDepositConfig });
        records.length = 0;
        for (const marketId of ['market-1', 'market-2']) {
            const tradeLogMessage = {
                chainId: TEST_CHAIN_ID,
                requestId: `${marketId}-shared-deposit-trade-log`,
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: 'polymarketTradeLog',
                payload: {
                    stream: {
                        commitmentSafe: TEST_COMMITMENT_SAFE,
                        ogModule: TEST_OG_MODULE,
                        user: TEST_USER,
                        marketId,
                        tradingWallet: TEST_TRADING_WALLET,
                    },
                    sequence: 1,
                    previousCid: null,
                    trades: [
                        {
                            tradeId: `${marketId}-trade-1`,
                            tradeEntryKind: 'initiated',
                            executedAtMs: firstSeenAtMs - 5 * 60_000,
                            principalContributionWei: '500000',
                        },
                    ],
                    summary: {
                        finalSettlementValueWei: '400000',
                        settledAtMs: firstSeenAtMs,
                        settlementKind: 'resolved',
                        settlementDepositTxHash: `0x${'d'.repeat(64)}`,
                        settlementDepositConfirmedAtMs: firstSeenAtMs,
                    },
                },
            };
            const tradeLogCid = appendPublishedRecord({
                message: tradeLogMessage,
                validation: {
                    validatorId: 'polymarket_trade_log_timeliness',
                    status: 'accepted',
                    classifications: [
                        {
                            id: `${marketId}-trade-1`,
                            classification: 'reimbursable',
                            firstSeenAtMs,
                        },
                    ],
                    summary: {
                        stream: tradeLogMessage.payload.stream,
                        sequence: 1,
                        previousCid: null,
                        settlement: tradeLogMessage.payload.summary,
                        loggingWindowMinutes: 15,
                        evaluationBasis: 'receivedAtMs',
                        previousPublishedCid: null,
                        publishedAtMs: firstSeenAtMs,
                        newTradeCount: 1,
                        lateTradeCount: 0,
                    },
                },
                records,
                publishedAtMs: firstSeenAtMs,
            });
            appendPublishedRecord({
                message: {
                    chainId: TEST_CHAIN_ID,
                    requestId: `${marketId}-shared-deposit-reimbursement-request`,
                    commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                    agentAddress: TEST_AGENT.address,
                    kind: 'polymarketReimbursementRequest',
                    payload: {
                        stream: tradeLogMessage.payload.stream,
                        snapshotCid: tradeLogCid,
                    },
                },
                validation: {
                    validatorId: 'polymarket_reimbursement_request',
                    status: 'accepted',
                    summary: {
                        stream: tradeLogMessage.payload.stream,
                        snapshotCid: tradeLogCid,
                        previousPublishedCid: tradeLogCid,
                    },
                },
                records,
                publishedAtMs: firstSeenAtMs + 1_000,
            });
        }
        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config: sharedDepositConfig,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 0);
        nodeState = getNodeState();
        assert.equal(nodeState.markets['market-1'].reimbursement.dispatchAtMs, null);
        assert.equal(nodeState.markets['market-2'].reimbursement.dispatchAtMs, null);

        await resetNodeStateForTest({ config });
        records.length = 0;
        const unconfiguredTradeLogMessage = {
            chainId: TEST_CHAIN_ID,
            requestId: 'unconfigured-market-trade-log',
            commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
            agentAddress: TEST_AGENT.address,
            kind: 'polymarketTradeLog',
            payload: {
                stream: {
                    commitmentSafe: TEST_COMMITMENT_SAFE,
                    ogModule: TEST_OG_MODULE,
                    user: TEST_USER,
                    marketId: 'market-unconfigured',
                    tradingWallet: TEST_TRADING_WALLET,
                },
                sequence: 1,
                previousCid: null,
                trades: [
                    {
                        tradeId: 'trade-unconfigured',
                        tradeEntryKind: 'initiated',
                        executedAtMs: firstSeenAtMs - 5 * 60_000,
                        principalContributionWei: '1000000',
                    },
                ],
                summary: {
                    finalSettlementValueWei: '0',
                    settledAtMs: firstSeenAtMs,
                    settlementKind: 'resolved',
                    settlementDepositTxHash: null,
                    settlementDepositConfirmedAtMs: null,
                },
            },
        };
        const unconfiguredTradeLogCid = appendPublishedRecord({
            message: unconfiguredTradeLogMessage,
            validation: {
                validatorId: 'polymarket_trade_log_timeliness',
                status: 'accepted',
                classifications: [
                    {
                        id: 'trade-unconfigured',
                        classification: 'reimbursable',
                        firstSeenAtMs,
                    },
                ],
                summary: {
                    stream: unconfiguredTradeLogMessage.payload.stream,
                    sequence: 1,
                    previousCid: null,
                    settlement: unconfiguredTradeLogMessage.payload.summary,
                    loggingWindowMinutes: 15,
                    evaluationBasis: 'receivedAtMs',
                    previousPublishedCid: null,
                    publishedAtMs: firstSeenAtMs,
                    newTradeCount: 1,
                    lateTradeCount: 0,
                },
            },
            records,
            publishedAtMs: firstSeenAtMs,
        });
        appendPublishedRecord({
            message: {
                chainId: TEST_CHAIN_ID,
                requestId: 'unconfigured-market-reimbursement-request',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: 'polymarketReimbursementRequest',
                payload: {
                    stream: unconfiguredTradeLogMessage.payload.stream,
                    snapshotCid: unconfiguredTradeLogCid,
                },
            },
            validation: {
                validatorId: 'polymarket_reimbursement_request',
                status: 'accepted',
                summary: {
                    stream: unconfiguredTradeLogMessage.payload.stream,
                    snapshotCid: unconfiguredTradeLogCid,
                    previousPublishedCid: unconfiguredTradeLogCid,
                },
            },
            records,
            publishedAtMs: firstSeenAtMs + 1_000,
        });

        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 0);
        nodeState = getNodeState();
        assert.equal(nodeState.markets['market-unconfigured'], undefined);

        await resetNodeStateForTest({ config });
        records.length = 0;
        const foreignStream = {
            commitmentSafe: TEST_COMMITMENT_SAFE,
            ogModule: TEST_OG_MODULE,
            user: TEST_FOREIGN_USER,
            marketId: 'market-1',
            tradingWallet: TEST_TRADING_WALLET,
        };
        const foreignTradeLogMessage = {
            chainId: TEST_CHAIN_ID,
            requestId: 'foreign-scope-trade-log',
            commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
            agentAddress: TEST_AGENT.address,
            kind: 'polymarketTradeLog',
            payload: {
                stream: foreignStream,
                sequence: 1,
                previousCid: null,
                trades: [
                    {
                        tradeId: 'trade-foreign-scope',
                        tradeEntryKind: 'initiated',
                        executedAtMs: firstSeenAtMs - 5 * 60_000,
                        principalContributionWei: '1000000',
                    },
                ],
                summary: {
                    finalSettlementValueWei: '0',
                    settledAtMs: firstSeenAtMs,
                    settlementKind: 'resolved',
                    settlementDepositTxHash: null,
                    settlementDepositConfirmedAtMs: null,
                },
            },
        };
        const foreignTradeLogCid = appendPublishedRecord({
            message: foreignTradeLogMessage,
            validation: {
                validatorId: 'polymarket_trade_log_timeliness',
                status: 'accepted',
                classifications: [
                    {
                        id: 'trade-foreign-scope',
                        classification: 'reimbursable',
                        firstSeenAtMs,
                    },
                ],
                summary: {
                    stream: foreignStream,
                    sequence: 1,
                    previousCid: null,
                    settlement: foreignTradeLogMessage.payload.summary,
                    loggingWindowMinutes: 15,
                    evaluationBasis: 'receivedAtMs',
                    previousPublishedCid: null,
                    publishedAtMs: firstSeenAtMs,
                    newTradeCount: 1,
                    lateTradeCount: 0,
                },
            },
            records,
            publishedAtMs: firstSeenAtMs,
        });
        appendPublishedRecord({
            message: {
                chainId: TEST_CHAIN_ID,
                requestId: 'foreign-scope-reimbursement-request',
                commitmentAddresses: [TEST_COMMITMENT_SAFE, TEST_OG_MODULE],
                agentAddress: TEST_AGENT.address,
                kind: 'polymarketReimbursementRequest',
                payload: {
                    stream: foreignStream,
                    snapshotCid: foreignTradeLogCid,
                },
            },
            validation: {
                validatorId: 'polymarket_reimbursement_request',
                status: 'accepted',
                summary: {
                    stream: foreignStream,
                    snapshotCid: foreignTradeLogCid,
                    previousPublishedCid: foreignTradeLogCid,
                },
            },
            records,
            publishedAtMs: firstSeenAtMs + 2_000,
        });

        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 0);
        nodeState = getNodeState();
        assert.equal(nodeState.markets['market-1'], undefined);
    } finally {
        await resetModuleStateForTest({ config });
        await resetNodeStateForTest({ config });
    }

    console.log('[test] polymarket-staked-external-settlement node controller OK');
}

run().catch((error) => {
    console.error(
        '[test] polymarket-staked-external-settlement node controller failed:',
        error?.message ?? error
    );
    process.exit(1);
});
