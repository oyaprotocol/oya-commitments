import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
    decodeFunctionData,
    erc20Abi,
    keccak256,
    padHex,
    parseAbi,
    stringToHex,
    toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeToolCalls } from '../../../agent/src/lib/tools.js';
import { createMessagePublicationApiServer } from '../../../agent/src/lib/message-publication-api.js';
import { createMessagePublicationStore } from '../../../agent/src/lib/message-publication-store.js';
import { createProposalPublicationApiServer } from '../../../agent/src/lib/proposal-publication-api.js';
import { createProposalPublicationStore } from '../../../agent/src/lib/proposal-publication-store.js';
import {
    derivePublishedMessageLockKeys,
    getDeterministicToolCalls,
    getNodeDeterministicToolCalls,
    getNodeState,
    onNodeToolOutput,
    onToolOutput,
    resetModuleStateForTest,
    resetNodeStateForTest,
    validatePublishedMessage,
} from './agent.js';

const TEST_AGENT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const TEST_NODE = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const TEST_CHAIN_ID = 137;
const TEST_COMMITMENT_SAFE = '0x1111111111111111111111111111111111111111';
const TEST_OG_MODULE = '0x2222222222222222222222222222222222222222';
const TEST_USER = '0x3333333333333333333333333333333333333333';
const TEST_TRADING_WALLET = '0x4444444444444444444444444444444444444444';
const TEST_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const TEST_RULES = `Staked External Polymarket Execution
---
The designated agent at address ${TEST_AGENT.address} must deposit a stake of 1000 USDC to be considered the active agent.

To track this external trading, the agent will periodically sign an updated log documenting all of their trades, and send to the node at address ${TEST_NODE.address} for a second signature, and publication to IPFS.

Trades must be logged within 15 minutes of trade execution to be considered valid for reimbursement.
`;
const SETTLEMENT_DEPOSIT_TX_HASH = `0x${'d'.repeat(64)}`;
const REIMBURSEMENT_PROPOSAL_TX_HASH = `0x${'e'.repeat(64)}`;
const REIMBURSEMENT_PROPOSAL_HASH = `0x${'f'.repeat(64)}`;
const transferEventAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function getHarnessDefinition() {
    return {
        scenario: 'polymarket-staked-external-settlement-smoke',
        description:
            'Runs an in-process smoke scenario for the staked external settlement module: trade-log publication, settlement deposit, reimbursement request publication, and node-side reimbursement proposal publication.',
    };
}

function buildBaseConfig(tempDir) {
    return {
        chainId: TEST_CHAIN_ID,
        commitmentSafe: TEST_COMMITMENT_SAFE,
        ogModule: TEST_OG_MODULE,
        ipfsEnabled: true,
        proposeEnabled: true,
        disputeEnabled: true,
        messagePublishApiEnabled: true,
        messagePublishApiHost: '127.0.0.1',
        messagePublishApiPort: 0,
        messagePublishApiKeys: {
            ops: 'k_message_publish_ops',
        },
        messagePublishApiRequireSignerAllowlist: true,
        messagePublishApiSignerAllowlist: [TEST_AGENT.address],
        messagePublishApiSignatureMaxAgeSeconds: 300,
        proposalPublishApiEnabled: true,
        proposalPublishApiHost: '127.0.0.1',
        proposalPublishApiPort: 0,
        proposalPublishApiMode: 'propose',
        proposalPublishApiKeys: {
            ops: 'k_proposal_publish_ops',
        },
        proposalPublishApiRequireSignerAllowlist: true,
        proposalPublishApiSignerAllowlist: [TEST_AGENT.address],
        proposalPublishApiSignatureMaxAgeSeconds: 300,
        proposalVerificationMode: 'off',
        polymarketClobEnabled: true,
        polymarketClobApiKey: 'clob-key',
        polymarketClobApiSecret: 'clob-secret',
        polymarketClobApiPassphrase: 'clob-passphrase',
        watchAssets: [TEST_USDC],
        ipfsApiUrl: 'http://ipfs.mock',
        agentConfig: {
            polymarketStakedExternalSettlement: {
                authorizedAgent: TEST_AGENT.address,
                userAddress: TEST_USER,
                tradingWallet: TEST_TRADING_WALLET,
                collateralToken: TEST_USDC,
                stateFile: path.join(tempDir, 'module-state.json'),
                nodeStateFile: path.join(tempDir, 'node-state.json'),
                marketsById: {
                    'market-1': {
                        label: 'Smoke market',
                        sourceUser: TEST_USER,
                        sourceMarket: 'market-1',
                        yesTokenId: '11',
                        noTokenId: '22',
                        initiatedCollateralAmountWei: '1000000',
                    },
                },
            },
        },
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

function buildTransferLog({ from, to, value }) {
    return {
        address: TEST_USDC,
        topics: [
            keccak256(stringToHex('Transfer(address,address,uint256)')),
            padHex(String(from).toLowerCase(), { size: 32 }),
            padHex(String(to).toLowerCase(), { size: 32 }),
        ],
        data: toHex(BigInt(value), { size: 32 }),
    };
}

function buildMockPublicClient() {
    return {
        async readContract({ functionName, args }) {
            if (functionName === 'rules') {
                return TEST_RULES;
            }
            if (functionName === 'balanceOf') {
                const tokenId = BigInt(args?.[1] ?? 0n).toString();
                if (tokenId === '11') {
                    return 2_500_000n;
                }
                return 0n;
            }
            throw new Error(`Unsupported readContract function in smoke harness: ${functionName}`);
        },
        async getTransactionReceipt({ hash }) {
            if (String(hash).toLowerCase() === SETTLEMENT_DEPOSIT_TX_HASH.toLowerCase()) {
                return {
                    transactionHash: hash,
                    status: 1n,
                    logs: [
                        buildTransferLog({
                            from: TEST_AGENT.address,
                            to: TEST_COMMITMENT_SAFE,
                            value: 2_500_000n,
                        }),
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

function createIpfsFetchMock() {
    const originalFetch = globalThis.fetch;
    const artifactsByCid = new Map();

    globalThis.fetch = async (url, options = {}) => {
        const urlString = String(url);
        if (!urlString.startsWith('http://ipfs.mock')) {
            return originalFetch(url, options);
        }

        const textResponse = (status, payload) => ({
            ok: status >= 200 && status < 300,
            status,
            statusText: '',
            async text() {
                return JSON.stringify(payload);
            },
        });

        if (urlString.includes('/api/v0/add')) {
            const uploaded = options.body.get('file');
            const uploadedText = await uploaded.text();
            const artifact = JSON.parse(uploadedText);
            const cid = `bafy${createHash('sha256').update(uploadedText).digest('hex').slice(0, 24)}`;
            artifactsByCid.set(cid, artifact);
            return textResponse(200, {
                Name: 'artifact.json',
                Hash: cid,
                Size: String(uploadedText.length),
            });
        }

        if (urlString.includes('/api/v0/pin/add')) {
            const parsed = new URL(urlString);
            return textResponse(200, {
                Pins: [parsed.searchParams.get('arg')],
            });
        }

        throw new Error(`Unexpected mock IPFS request: ${urlString}`);
    };

    return {
        artifactsByCid,
        stop() {
            globalThis.fetch = originalFetch;
        },
    };
}

function createDirectExecutionFetchMock({
    activity = [],
    marketById = {},
    placedOrder = { orderID: 'direct-order-1', status: 'LIVE' },
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
            return raw.shift();
        }
        return raw;
    }

    globalThis.fetch = async (url, options = {}) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.hostname === 'data-api.polymarket.com') {
            return textResponse(200, JSON.stringify(activity));
        }
        if (parsedUrl.hostname === 'clob.polymarket.com' && parsedUrl.pathname === '/order') {
            return textResponse(200, JSON.stringify(placedOrder));
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
            parsedUrl.hostname === 'clob.polymarket.com' &&
            parsedUrl.pathname === '/data/trades'
        ) {
            const trades = Object.values(tradesByOrderId).flat();
            return textResponse(200, JSON.stringify(trades));
        }
        return originalFetch(url, options);
    };

    return {
        stop() {
            globalThis.fetch = originalFetch;
        },
    };
}

async function runToolCall({ toolCall, publicClient, walletClient, account, config }) {
    const outputs = await executeToolCalls({
        toolCalls: [toolCall],
        publicClient,
        walletClient,
        account,
        config,
        ogContext: null,
    });
    assert.equal(outputs.length, 1);
    return parseToolOutput(outputs[0]);
}

function decodeReimbursementAmount(transaction) {
    const decoded = decodeFunctionData({
        abi: erc20Abi,
        data: transaction.data,
    });
    assert.equal(decoded.functionName, 'transfer');
    return {
        to: String(decoded.args[0]).toLowerCase(),
        amountWei: BigInt(decoded.args[1]).toString(),
    };
}

function assertPublishedResult(result, label) {
    if (result?.status !== 'published') {
        throw new Error(`${label} failed: ${JSON.stringify(result)}`);
    }
}

async function runSmokeScenario() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'poly-settlement-smoke-'));
    const config = buildBaseConfig(tempDir);
    const publicClient = buildMockPublicClient();
    const walletClient = {
        async signMessage({ message }) {
            return await TEST_AGENT.signMessage({ message });
        },
        async signTypedData(parameters) {
            return await TEST_AGENT.signTypedData(parameters);
        },
    };
    const account = TEST_AGENT;
    const nodeSigner = {
        address: TEST_NODE.address,
        async signMessage(message) {
            return await TEST_NODE.signMessage({ message });
        },
    };
    const firstSeenAtMs = Date.now();
    const ipfsMock = createIpfsFetchMock();
    const directExecutionFetch = createDirectExecutionFetchMock({
        activity: [
            {
                id: 'source-trade-1',
                side: 'BUY',
                outcome: 'YES',
                price: 0.4,
                timestamp: new Date(firstSeenAtMs - 30_000).toISOString(),
                title: 'Smoke direct source trade',
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
                    outcomePrices: '["1","0"]',
                    outcomes: '["Yes","No"]',
                    closed: true,
                    umaResolutionStatus: 'resolved',
                    closedTime: new Date(firstSeenAtMs + 120_000).toISOString(),
                    clobTokenIds: '["11","22"]',
                },
            ],
        },
        placedOrder: {
            orderID: 'direct-order-1',
            status: 'LIVE',
        },
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
    const messageStore = createMessagePublicationStore({
        stateFile: path.join(tempDir, 'message-publications.json'),
    });
    const proposalStore = createProposalPublicationStore({
        stateFile: path.join(tempDir, 'proposal-publications.json'),
    });
    const silentLogger = { log() {}, warn() {}, error() {} };

    const messageApi = createMessagePublicationApiServer({
        config,
        store: messageStore,
        logger: silentLogger,
        nodeSigner,
        validateMessagePublication: async (args) =>
            validatePublishedMessage({
                ...args,
                publicClient,
            }),
        deriveMessagePublicationLockKeys: derivePublishedMessageLockKeys,
    });
    const proposalApi = createProposalPublicationApiServer({
        config,
        store: proposalStore,
        logger: silentLogger,
        resolveProposalRuntime: async () => ({
            publicClient,
            walletClient,
            account,
            runtimeConfig: config,
        }),
        submitProposal: async () => ({
            transactionHash: REIMBURSEMENT_PROPOSAL_TX_HASH,
            ogProposalHash: REIMBURSEMENT_PROPOSAL_HASH,
            sideEffectsLikelyCommitted: true,
        }),
    });

    let messageServer;
    let proposalServer;
    try {
        messageServer = await messageApi.start();
        proposalServer = await proposalApi.start();
        const messageAddress = messageServer.address();
        const proposalAddress = proposalServer.address();
        assert.ok(messageAddress && typeof messageAddress === 'object');
        assert.ok(proposalAddress && typeof proposalAddress === 'object');
        config.messagePublishApiPort = messageAddress.port;
        config.proposalPublishApiPort = proposalAddress.port;

        await resetModuleStateForTest({ config });
        await resetNodeStateForTest({ config });

        let toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
        const directOrderResult = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assert.equal(directOrderResult.status, 'submitted');
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: directOrderResult,
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
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const initialTradePublication = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assertPublishedResult(initialTradePublication, 'initial trade publication');
        assert.equal(
            initialTradePublication.validation.classifications[0].classification,
            'reimbursable'
        );
        await onToolOutput({
            name: 'publish_signed_message',
            parsedOutput: initialTradePublication,
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
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const settlementPublishArgs = JSON.parse(toolCalls[0].arguments);
        assert.equal(settlementPublishArgs.message.payload.summary.finalSettlementValueWei, '2500000');
        assert.equal(settlementPublishArgs.message.payload.summary.settlementKind, 'resolved');
        const settlementPublication = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assertPublishedResult(settlementPublication, 'settlement publication');
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
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'make_deposit');
        assert.equal(JSON.parse(toolCalls[0].arguments).amountWei, '2500000');
        await onToolOutput({
            name: 'make_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: SETTLEMENT_DEPOSIT_TX_HASH,
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
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const postDepositPublication = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assertPublishedResult(postDepositPublication, 'post-deposit publication');
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
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_message');
        const reimbursementRequestPublication = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assertPublishedResult(
            reimbursementRequestPublication,
            'reimbursement request publication'
        );
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

        toolCalls = await getNodeDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_COMMITMENT_SAFE,
            agentAddress: TEST_AGENT.address,
            publicClient,
            config,
            messagePublicationStore: messageStore,
            onchainPendingProposal: false,
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'publish_signed_proposal');
        const reimbursementProposalOutput = await runToolCall({
            toolCall: toolCalls[0],
            publicClient,
            walletClient,
            account,
            config,
        });
        assertPublishedResult(reimbursementProposalOutput, 'reimbursement proposal publication');
        assert.equal(reimbursementProposalOutput.submission?.status, 'resolved');
        await onNodeToolOutput({
            callId: toolCalls[0].callId,
            name: toolCalls[0].name,
            parsedOutput: reimbursementProposalOutput,
            config,
            commitmentSafe: TEST_COMMITMENT_SAFE,
        });

        const nodeState = getNodeState();
        assert.equal(
            nodeState.markets['market-1'].reimbursement.proposalHash,
            REIMBURSEMENT_PROPOSAL_HASH
        );
        const messageRecords = await messageStore.listRecords();
        assert.equal(messageRecords.length, 4);
        const reimbursementTransfer = decodeReimbursementAmount(
            reimbursementProposalOutput.proposal.transactions[0]
        );
        assert.equal(reimbursementTransfer.to, TEST_AGENT.address.toLowerCase());
        assert.equal(reimbursementTransfer.amountWei, '1000000');
        const proposalRecord = await proposalStore.getRecord({
            signer: TEST_AGENT.address,
            chainId: TEST_CHAIN_ID,
            requestId: reimbursementProposalOutput.proposal.requestId,
        });
        assert.ok(proposalRecord?.cid);
        assert.ok(proposalRecord?.artifact);
        assert.ok(ipfsMock.artifactsByCid.get(proposalRecord.cid));

        return {
            scenario: 'polymarket-staked-external-settlement-smoke',
            messagePublicationCount: messageRecords.length,
            tradeLogCid: postDepositPublication.cid,
            reimbursementRequestCid: reimbursementRequestPublication.cid,
            proposalCid: proposalRecord.cid,
            proposalHash: REIMBURSEMENT_PROPOSAL_HASH,
            proposalRequestId: reimbursementProposalOutput.proposal.requestId,
            proposalSubmissionStatus: reimbursementProposalOutput.submission.status,
        };
    } finally {
        await proposalApi.stop().catch(() => {});
        await messageApi.stop().catch(() => {});
        directExecutionFetch.stop();
        ipfsMock.stop();
        await rm(tempDir, { recursive: true, force: true });
    }
}

export { getHarnessDefinition, runSmokeScenario };
