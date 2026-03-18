import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import {
    getDeterministicToolCalls,
    getSwapState,
    onProposalEvents,
    onToolOutput,
    resetSwapState,
    setSwapStatePathForTest,
} from './agent.js';

const SAFE = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const SIGNER = '0x5555555555555555555555555555555555555555';
const OTHER_SIGNER = '0x6666666666666666666666666666666666666666';
const USDC = '0x7777777777777777777777777777777777777777';
const ERC1155 = '0x8888888888888888888888888888888888888888';
const OG_MODULE = '0x9999999999999999999999999999999999999998';
const ERC1155_TOKEN_ID = '42';
const DIRECT_FILL_TX_HASH = `0x${'a'.repeat(64)}`;
const PROPOSAL_TX_HASH = `0x${'b'.repeat(64)}`;
const OG_PROPOSAL_HASH = `0x${'c'.repeat(64)}`;
const DIRECT_FILL_TX_HASH_2 = `0x${'d'.repeat(64)}`;
const PROPOSAL_TX_HASH_2 = `0x${'e'.repeat(64)}`;
const RECOVERED_PROPOSAL_HASH = `0x${'f'.repeat(64)}`;
const RECOVERED_PROPOSAL_HASH_2 = `0x${'1'.repeat(64)}`;
const SEPOLIA_CHAIN_ID = 11155111;

function buildConfig(overrides = {}) {
    const { agentConfig: agentConfigOverrides = {}, ...topLevelOverrides } = overrides;
    return {
        commitmentSafe: SAFE,
        ogModule: OG_MODULE,
        watchAssets: [USDC],
        watchErc1155Assets: [
            {
                token: ERC1155,
                tokenId: ERC1155_TOKEN_ID,
                symbol: 'TEST-42',
            },
        ],
        agentConfig: {
            authorizedAgent: AGENT,
            paymentTokenSymbol: 'USDC',
            usdcUnitAmountWei: '1000000',
            fillConfirmationThreshold: 1,
            signedCommands: ['fast_withdraw', 'fast_withdraw_erc1155'],
            ...agentConfigOverrides,
        },
        ipfsEnabled: true,
        ...topLevelOverrides,
    };
}

function buildDepositSignal({
    id,
    from = SIGNER,
    amountWei = 1_000_000n,
    transactionHash = `0x${String(id).replace(/[^0-9a-f]/gi, '1').padEnd(64, '1').slice(0, 64)}`,
    logIndex = 0,
} = {}) {
    return {
        kind: 'erc20Deposit',
        asset: USDC,
        from,
        amount: amountWei,
        transactionHash,
        logIndex,
        id,
    };
}

function buildSignedRequestSignal({
    requestId,
    signer = SIGNER,
    recipient = RECIPIENT,
    amount = '1',
    token = ERC1155,
    tokenId = ERC1155_TOKEN_ID,
    command = 'fast_withdraw_erc1155',
    text = 'Machine-readable request; see command and args.',
    args = undefined,
} = {}) {
    return {
        kind: 'userMessage',
        requestId,
        messageId: `msg-${requestId}`,
        command,
        args:
            args !== undefined
                ? args
                : {
                      recipient,
                      amount,
                      token,
                      tokenId,
                  },
        text,
        sender: {
            authType: 'eip191',
            address: signer,
            signature: `0x${'9'.repeat(130)}`,
            signedAtMs: Date.now(),
        },
        receivedAtMs: Date.now(),
    };
}

function buildReceiptNotFoundError(hash) {
    const error = new Error(`transaction receipt for ${hash} not found`);
    error.name = 'TransactionReceiptNotFoundError';
    return error;
}

function buildErc20TransferLog({
    from,
    to = SAFE,
    value,
    blockNumber,
    transactionHash,
    logIndex = 0,
}) {
    return {
        args: { from, to, value },
        blockNumber,
        transactionHash,
        logIndex,
    };
}

function buildHistoricalReimbursementExplanation({
    orderId,
    requestId,
    signer = SIGNER,
    signedRequestCid = null,
    token = ERC1155,
    tokenId = ERC1155_TOKEN_ID,
    amount = '1',
    reservedCreditWei = '1000000',
    recipient = RECIPIENT,
    directFillTx = DIRECT_FILL_TX_HASH,
} = {}) {
    return [
        'erc1155-swap-fast-withdraw reimbursement',
        `order=${orderId}`,
        `requestId=${requestId}`,
        `signer=${signer}`,
        `signedRequestCid=${signedRequestCid ?? 'missing'}`,
        `token=${token}`,
        `tokenId=${tokenId}`,
        `amount=${amount}`,
        `reservedCreditWei=${reservedCreditWei}`,
        `recipient=${recipient}`,
        `directFillTx=${directFillTx}`,
    ].join(' | ');
}

function buildTransactionsProposedLog({
    proposalHash,
    explanation,
    proposer = AGENT,
    blockNumber,
    transactionHash = `0x${'2'.repeat(64)}`,
    logIndex = 0,
}) {
    return {
        args: {
            proposalHash,
            proposer,
            explanation,
        },
        blockNumber,
        transactionHash,
        logIndex,
    };
}

function buildProposalExecutedLog({
    proposalHash,
    blockNumber,
    transactionHash = `0x${'3'.repeat(64)}`,
    logIndex = 0,
}) {
    return {
        args: { proposalHash },
        blockNumber,
        transactionHash,
        logIndex,
    };
}

function buildPublicClient({
    chainId = SEPOLIA_CHAIN_ID,
    commitmentSafe = SAFE,
    latestBlock = 100n,
    safeUsdcBalance = 0n,
    agentErc1155Balance = 0n,
    directFillReceipt = null,
    receiptsByHash = null,
    receiptErrorsByHash = null,
    safeDeploymentBlock = 0n,
    erc20TransferLogs = [],
    ogProposalLogs = [],
    ogExecutedLogs = [],
} = {}) {
    return {
        async getChainId() {
            return chainId;
        },
        async getBlockNumber() {
            return latestBlock;
        },
        async getCode({ address, blockNumber }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress !== String(commitmentSafe).toLowerCase()) {
                return '0x';
            }
            return BigInt(blockNumber) >= BigInt(safeDeploymentBlock) ? '0x1234' : '0x';
        },
        async getLogs({ address, event, args, fromBlock, toBlock }) {
            const normalizedAddress = String(address).toLowerCase();
            const inRange = (log) => {
                const logBlockNumber = BigInt(log.blockNumber ?? 0n);
                return logBlockNumber >= BigInt(fromBlock) && logBlockNumber <= BigInt(toBlock);
            };

            if (normalizedAddress === USDC.toLowerCase()) {
                return erc20TransferLogs.filter((log) => {
                    const matchesRecipient =
                        !args?.to ||
                        String(log.args?.to ?? '').toLowerCase() === String(args.to).toLowerCase();
                    return inRange(log) && matchesRecipient;
                });
            }

            if (normalizedAddress === OG_MODULE.toLowerCase()) {
                const eventName =
                    typeof event?.name === 'string'
                        ? event.name
                        : typeof event?.item?.name === 'string'
                            ? event.item.name
                            : null;
                if (eventName === 'TransactionsProposed') {
                    return ogProposalLogs.filter(inRange);
                }
                if (eventName === 'ProposalExecuted') {
                    return ogExecutedLogs.filter(inRange);
                }
            }

            return [];
        },
        async readContract({ address, functionName, args }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress === USDC.toLowerCase() && functionName === 'balanceOf') {
                assert.equal(String(args[0]).toLowerCase(), String(commitmentSafe).toLowerCase());
                return safeUsdcBalance;
            }
            if (normalizedAddress === ERC1155.toLowerCase() && functionName === 'balanceOf') {
                assert.equal(String(args[0]).toLowerCase(), AGENT.toLowerCase());
                assert.equal(BigInt(args[1]), BigInt(ERC1155_TOKEN_ID));
                return agentErc1155Balance;
            }
            throw new Error(`Unexpected readContract: ${functionName} on ${address}`);
        },
        async getTransactionReceipt({ hash }) {
            const normalizedHash = String(hash).toLowerCase();
            if (
                receiptErrorsByHash &&
                Object.prototype.hasOwnProperty.call(receiptErrorsByHash, normalizedHash)
            ) {
                throw receiptErrorsByHash[normalizedHash];
            }
            if (receiptsByHash && Object.prototype.hasOwnProperty.call(receiptsByHash, normalizedHash)) {
                return receiptsByHash[normalizedHash];
            }
            if (!directFillReceipt || normalizedHash !== DIRECT_FILL_TX_HASH.toLowerCase()) {
                throw new Error(`Unexpected transaction receipt request for ${hash}`);
            }
            return directFillReceipt;
        },
    };
}

function parseToolArgs(call) {
    return JSON.parse(call.arguments);
}

function buildRequestOrderId(signer, requestId) {
    return `request:${getAddress(signer)}:${String(requestId).trim()}`;
}

function buildPublishedIpfsOutput(requestId = 'default') {
    const cid = `bafy${String(requestId).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'artifact'}`;
    return {
        status: 'published',
        cid,
        uri: `ipfs://${cid}`,
    };
}

function buildFailedIpfsOutput(message = 'connect ECONNREFUSED 127.0.0.1:5001') {
    return {
        status: 'error',
        message,
        retryable: true,
        sideEffectsLikelyCommitted: false,
    };
}

function getCreditFor(state, address) {
    const key = Object.keys(state.credits ?? {}).find(
        (candidate) => candidate.toLowerCase() === address.toLowerCase()
    );
    return key ? state.credits[key] : null;
}

async function withMockedNow(nowMs, fn) {
    const originalNow = Date.now;
    Date.now = () => nowMs;
    try {
        return await fn();
    } finally {
        Date.now = originalNow;
    }
}

async function withMockFetch(mockFetch, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function withCapturedConsoleLogs(fn) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const lines = [];
    console.log = (...args) => {
        lines.push(args.map((value) => String(value)).join(' '));
    };
    console.warn = (...args) => {
        lines.push(args.map((value) => String(value)).join(' '));
    };
    console.error = (...args) => {
        lines.push(args.map((value) => String(value)).join(' '));
    };
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
}

async function withTempStateDir(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'erc1155-swap-fast-withdraw-dir-'));
    setSwapStatePathForTest(null);
    await resetSwapState();
    try {
        await fn(dir);
    } finally {
        setSwapStatePathForTest(null);
        await rm(dir, { recursive: true, force: true });
    }
}

async function withTempStatePath(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'erc1155-swap-fast-withdraw-'));
    const statePath = path.join(dir, 'swap-state.json');
    setSwapStatePathForTest(statePath);
    await resetSwapState();
    try {
        await fn({ statePath });
    } finally {
        setSwapStatePathForTest(null);
        await rm(dir, { recursive: true, force: true });
    }
}

async function testDepositCreatesCreditOnly() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const { result: toolCalls, lines } = await withCapturedConsoleLogs(() =>
            getDeterministicToolCalls({
                signals: [
                    buildDepositSignal({
                        id: 'deposit-credit-only',
                        amountWei: 2_000_000n,
                    }),
                ],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    commitmentSafe: SAFE,
                    safeUsdcBalance: 2_000_000n,
                    agentErc1155Balance: 5n,
                }),
                config,
                onchainPendingProposal: false,
            })
        );

        assert.equal(toolCalls.length, 0);
        assert.equal(
            lines.some((line) => line.includes('Recorded ERC20 deposit credit for')),
            true
        );

        const state = await getSwapState();
        assert.equal(Object.keys(state.orders).length, 0);
        assert.equal(Object.keys(state.deposits).length, 1);
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '2000000',
            reservedWei: '0',
            availableWei: '2000000',
        });
    });
}

async function testStartupBackfillsDepositorCreditFromHistory() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const { result: toolCalls, lines } = await withCapturedConsoleLogs(() =>
            getDeterministicToolCalls({
                signals: [
                    buildSignedRequestSignal({
                        requestId: 'req-backfill',
                        signer: SIGNER,
                        recipient: RECIPIENT,
                        amount: '2',
                    }),
                ],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    latestBlock: 150n,
                    safeDeploymentBlock: 90n,
                    safeUsdcBalance: 2_000_000n,
                    agentErc1155Balance: 5n,
                    erc20TransferLogs: [
                        buildErc20TransferLog({
                            from: SIGNER,
                            value: 2_000_000n,
                            blockNumber: 120n,
                            transactionHash: `0x${'1'.repeat(64)}`,
                            logIndex: 0,
                        }),
                    ],
                }),
                config,
                onchainPendingProposal: false,
            })
        );

        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'ipfs_publish');
        assert.ok(
            lines.some((line) =>
                line.includes(
                    'Starting erc1155-swap-fast-withdraw credit backfill for'
                )
            )
        );
        assert.ok(
            lines.some((line) =>
                line.includes('Backfilling ERC20 deposit history from Safe deployment block 90')
            )
        );
        assert.ok(
            lines.some((line) =>
                line.includes('erc1155-swap-fast-withdraw credit backfill complete through block 150')
            )
        );

        const state = await getSwapState();
        assert.equal(Object.keys(state.deposits).length, 1);
        assert.equal(state.backfilledDepositsThroughBlock, '150');
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '2000000',
            reservedWei: '2000000',
            availableWei: '0',
        });
    });
}

async function testStartupLogsWhenCreditBackfillAlreadyComplete() {
    await withTempStatePath(async ({ statePath }) => {
        const config = buildConfig();
        const publicClient = buildPublicClient({
            latestBlock: 150n,
            safeDeploymentBlock: 90n,
            safeUsdcBalance: 1_000_000n,
            agentErc1155Balance: 5n,
            erc20TransferLogs: [
                buildErc20TransferLog({
                    from: SIGNER,
                    value: 1_000_000n,
                    blockNumber: 120n,
                    transactionHash: `0x${'2'.repeat(64)}`,
                    logIndex: 0,
                }),
            ],
        });

        await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient,
            config,
            onchainPendingProposal: false,
        });

        setSwapStatePathForTest(statePath);

        const { lines } = await withCapturedConsoleLogs(() =>
            getDeterministicToolCalls({
                signals: [],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient,
                config,
                onchainPendingProposal: false,
            })
        );

        assert.equal(
            lines.some((line) =>
                line.includes('erc1155-swap-fast-withdraw credit backfill already complete through block 150')
            ),
            true
        );
    });
}

async function testStartupBackfillReconstructsHistoricalSpentCredit() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const historicalOrderId = buildRequestOrderId(SIGNER, 'req-historical-spent');
        const toolCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedRequestSignal({
                    requestId: 'req-overdraw-after-backfill',
                    signer: SIGNER,
                    recipient: RECIPIENT,
                    amount: '2',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                latestBlock: 160n,
                safeDeploymentBlock: 90n,
                safeUsdcBalance: 5_000_000n,
                agentErc1155Balance: 5n,
                erc20TransferLogs: [
                    buildErc20TransferLog({
                        from: SIGNER,
                        value: 2_000_000n,
                        blockNumber: 120n,
                        transactionHash: `0x${'4'.repeat(64)}`,
                        logIndex: 0,
                    }),
                ],
                ogProposalLogs: [
                    buildTransactionsProposedLog({
                        proposalHash: OG_PROPOSAL_HASH,
                        explanation: buildHistoricalReimbursementExplanation({
                            orderId: historicalOrderId,
                            requestId: 'req-historical-spent',
                            signer: SIGNER,
                            amount: '1',
                            reservedCreditWei: '1000000',
                            recipient: BUYER,
                        }),
                        blockNumber: 130n,
                    }),
                ],
                ogExecutedLogs: [
                    buildProposalExecutedLog({
                        proposalHash: OG_PROPOSAL_HASH,
                        blockNumber: 140n,
                    }),
                ],
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);

        const state = await getSwapState();
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '2000000',
            reservedWei: '1000000',
            availableWei: '1000000',
        });
        assert.ok(state.orders[historicalOrderId]);
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-overdraw-after-backfill')],
            undefined
        );
    });
}

async function testSignedFastWithdrawLifecycleUsesDepositorCredit() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const directFillCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedRequestSignal({
                    requestId: 'req-1',
                    signer: SIGNER,
                    recipient: RECIPIENT,
                    amount: '3',
                }),
                buildDepositSignal({
                    id: 'deposit-req-1',
                    from: SIGNER,
                    amountWei: 3_000_000n,
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 3_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(directFillCalls.length, 1);
        assert.equal(directFillCalls[0].name, 'ipfs_publish');
        const archiveArgs = parseToolArgs(directFillCalls[0]);
        assert.equal(archiveArgs.filename, 'signed-request-7265712d31.json');
        assert.equal(archiveArgs.pin, true);
        assert.equal(archiveArgs.json.signedRequest.signer, SIGNER);
        assert.equal(archiveArgs.json.agentContext.commitmentSafe, SAFE);

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: buildPublishedIpfsOutput('req-1'),
        });

        const archivedState = await getSwapState();
        assert.equal(
            archivedState.orders[buildRequestOrderId(SIGNER, 'req-1')].artifactUri,
            'ipfs://bafyreq1'
        );

        const fillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 3_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(fillCalls.length, 1);
        assert.equal(fillCalls[0].name, 'make_erc1155_transfer');
        assert.deepEqual(parseToolArgs(fillCalls[0]), {
            token: ERC1155,
            recipient: RECIPIENT,
            tokenId: ERC1155_TOKEN_ID,
            amount: '3',
            data: '0x',
        });

        await onToolOutput({
            name: 'make_erc1155_transfer',
            parsedOutput: {
                status: 'submitted',
                transactionHash: DIRECT_FILL_TX_HASH,
            },
        });

        const reimbursementCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'erc20BalanceSnapshot',
                    asset: USDC,
                    amount: 3_000_000n,
                },
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                latestBlock: 120n,
                safeUsdcBalance: 3_000_000n,
                agentErc1155Balance: 2n,
                directFillReceipt: {
                    blockNumber: 119n,
                    status: 'success',
                },
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(reimbursementCalls.length, 1);
        assert.equal(reimbursementCalls[0].name, 'post_bond_and_propose');
        const reimbursementArgs = parseToolArgs(reimbursementCalls[0]);
        assert.equal(reimbursementArgs.transactions.length, 1);
        assert.equal(reimbursementArgs.transactions[0].to.toLowerCase(), USDC.toLowerCase());
        assert.match(
            reimbursementArgs.explanation,
            new RegExp(`order=${buildRequestOrderId(SIGNER, 'req-1')}`)
        );
        assert.match(reimbursementArgs.explanation, new RegExp(`signer=${SIGNER}`, 'i'));
        assert.match(reimbursementArgs.explanation, /signedRequestCid=ipfs:\/\/bafyreq1/);

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: PROPOSAL_TX_HASH,
                ogProposalHash: OG_PROPOSAL_HASH,
            },
        });

        const state = await getSwapState();
        const order = state.orders[buildRequestOrderId(SIGNER, 'req-1')];
        assert.ok(order);
        assert.equal(order.signer.toLowerCase(), SIGNER.toLowerCase());
        assert.equal(order.recipient.toLowerCase(), RECIPIENT.toLowerCase());
        assert.equal(order.reservedCreditAmountWei, '3000000');
        assert.equal(order.directFillTxHash, DIRECT_FILL_TX_HASH);
        assert.equal(order.reimbursementProposalHash, OG_PROPOSAL_HASH);
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '3000000',
            reservedWei: '3000000',
            availableWei: '0',
        });
    });
}

async function testDirectFillWaitsForSafeReimbursementLiquidity() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const toolCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-insufficient-safe-liquidity',
                    from: SIGNER,
                    amountWei: 1_000_000n,
                }),
                buildSignedRequestSignal({
                    requestId: 'req-insufficient-safe-liquidity',
                    signer: SIGNER,
                    recipient: RECIPIENT,
                    amount: '1',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 0n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'ipfs_publish');

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: buildPublishedIpfsOutput('req-insufficient-safe-liquidity'),
        });

        const fillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 0n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(fillCalls.length, 0);

        const state = await getSwapState();
        assert.ok(state.orders[buildRequestOrderId(SIGNER, 'req-insufficient-safe-liquidity')]);
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-insufficient-safe-liquidity')].directFillTxHash,
            undefined
        );
    });
}

async function testFreeTextSignedRequestUsesLlmInterpretation() {
    await withTempStatePath(async () => {
        let llmCalls = 0;
        await withMockFetch(
            async (url, options = {}) => {
                llmCalls += 1;
                assert.equal(url, 'https://api.openai.test/v1/responses');
                const body = JSON.parse(options.body);
                assert.equal(body.model, 'gpt-test');
                return {
                    ok: true,
                    json: async () => ({
                        output: [
                            {
                                content: [
                                    {
                                        text: '{"action":"fast_withdraw_erc1155","recipient":"0x4444444444444444444444444444444444444444","amount":"2"}',
                                    },
                                ],
                            },
                        ],
                    }),
                };
            },
            async () => {
                const config = buildConfig({
                    openAiApiKey: 'k_test',
                    openAiBaseUrl: 'https://api.openai.test/v1',
                    openAiModel: 'gpt-test',
                });
                const { result: toolCalls, lines } = await withCapturedConsoleLogs(() =>
                    getDeterministicToolCalls({
                        signals: [
                            buildDepositSignal({
                                id: 'deposit-free-text-llm',
                                from: SIGNER,
                                amountWei: 2_000_000n,
                            }),
                            buildSignedRequestSignal({
                                requestId: 'req-free-text-llm',
                                signer: SIGNER,
                                command: undefined,
                                text: `Please send 2 of token 1001 to ${RECIPIENT}.`,
                                args: {},
                            }),
                        ],
                        commitmentText: 'The signer may ask the agent in plain English to send the test ERC1155.',
                        commitmentSafe: SAFE,
                        agentAddress: AGENT,
                        publicClient: buildPublicClient({
                            safeUsdcBalance: 2_000_000n,
                            agentErc1155Balance: 5n,
                        }),
                        config,
                        onchainPendingProposal: false,
                    })
                );

                assert.equal(toolCalls.length, 1);
                assert.equal(toolCalls[0].name, 'ipfs_publish');
                assert.equal(
                    lines.some((line) =>
                        line.includes('Interpreting free-text signed request') &&
                        line.includes(buildRequestOrderId(SIGNER, 'req-free-text-llm'))
                    ),
                    true
                );
                assert.equal(
                    lines.some((line) =>
                        line.includes('Free-text signed request') &&
                        line.includes('interpreted: recipient=') &&
                        line.includes(`amount=2`)
                    ),
                    true
                );
                assert.equal(
                    lines.some((line) =>
                        line.includes('Preparing signed request archive for order') &&
                        line.includes(buildRequestOrderId(SIGNER, 'req-free-text-llm'))
                    ),
                    true
                );

                await onToolOutput({
                    name: 'ipfs_publish',
                    parsedOutput: buildPublishedIpfsOutput('req-free-text-llm'),
                });

                const fillCalls = await getDeterministicToolCalls({
                    signals: [],
                    commitmentText: 'The signer may ask the agent in plain English to send the test ERC1155.',
                    commitmentSafe: SAFE,
                    agentAddress: AGENT,
                    publicClient: buildPublicClient({
                        safeUsdcBalance: 2_000_000n,
                        agentErc1155Balance: 5n,
                    }),
                    config,
                    onchainPendingProposal: false,
                });

                assert.equal(fillCalls.length, 1);
                assert.equal(fillCalls[0].name, 'make_erc1155_transfer');
                assert.deepEqual(parseToolArgs(fillCalls[0]), {
                    token: ERC1155,
                    recipient: RECIPIENT,
                    tokenId: ERC1155_TOKEN_ID,
                    amount: '2',
                    data: '0x',
                });

                const state = await getSwapState();
                assert.deepEqual(state.interpretedRequests[buildRequestOrderId(SIGNER, 'req-free-text-llm')], {
                    action: 'fast_withdraw_erc1155',
                    args: {
                        recipient: RECIPIENT,
                        amount: '2',
                        token: ERC1155,
                        tokenId: ERC1155_TOKEN_ID,
                    },
                    interpretedAtMs: state.interpretedRequests[buildRequestOrderId(SIGNER, 'req-free-text-llm')].interpretedAtMs,
                    text: `Please send 2 of token 1001 to ${RECIPIENT}.`,
                });
                assert.ok(
                    state.orders[buildRequestOrderId(SIGNER, 'req-free-text-llm')],
                    'order should be created from LLM-interpreted free text'
                );
            }
        );

        assert.equal(llmCalls, 1);
    });
}

async function testArchiveFailureLogsAndBacksOffBeforeRetry() {
    await withTempStatePath(async () => {
        const config = buildConfig({
            agentConfig: {
                archiveRetryDelayMs: 30_000,
            },
        });

        const initialArchiveCalls = await withMockedNow(1_000, async () =>
            getDeterministicToolCalls({
                signals: [
                    buildDepositSignal({
                        id: 'deposit-archive-failure',
                        from: SIGNER,
                        amountWei: 1_000_000n,
                    }),
                    buildSignedRequestSignal({
                        requestId: 'req-archive-failure',
                        signer: SIGNER,
                        recipient: RECIPIENT,
                        amount: '1',
                    }),
                ],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 5n,
                }),
                config,
                onchainPendingProposal: false,
            })
        );
        assert.equal(initialArchiveCalls.length, 1);
        assert.equal(initialArchiveCalls[0].name, 'ipfs_publish');

        const { lines: failureLines } = await withCapturedConsoleLogs(() =>
            withMockedNow(1_500, async () =>
                onToolOutput({
                    name: 'ipfs_publish',
                    parsedOutput: buildFailedIpfsOutput(),
                })
            )
        );
        assert.equal(
            failureLines.some((line) =>
                line.includes('Signed request archive failed for order') &&
                line.includes(buildRequestOrderId(SIGNER, 'req-archive-failure'))
            ),
            true
        );
        assert.equal(
            failureLines.some((line) =>
                line.includes('Archive retry for') &&
                line.includes(buildRequestOrderId(SIGNER, 'req-archive-failure'))
            ),
            true
        );

        const stateAfterFailure = await getSwapState();
        const failedOrder = stateAfterFailure.orders[buildRequestOrderId(SIGNER, 'req-archive-failure')];
        assert.equal(failedOrder.lastArchiveError, 'connect ECONNREFUSED 127.0.0.1:5001');
        assert.equal(failedOrder.lastArchiveErrorStatus, 'error');
        assert.equal(failedOrder.lastArchiveErrorRetryable, true);
        assert.equal(failedOrder.nextArchiveAttemptAtMs, 31_000);

        const backoffCalls = await withMockedNow(5_000, async () =>
            getDeterministicToolCalls({
                signals: [],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 5n,
                }),
                config,
                onchainPendingProposal: false,
            })
        );
        assert.equal(backoffCalls.length, 0);

        const { result: retryCalls, lines: retryLines } = await withCapturedConsoleLogs(() =>
            withMockedNow(31_500, async () =>
                getDeterministicToolCalls({
                    signals: [],
                    commitmentText: '',
                    commitmentSafe: SAFE,
                    agentAddress: AGENT,
                    publicClient: buildPublicClient({
                        safeUsdcBalance: 1_000_000n,
                        agentErc1155Balance: 5n,
                    }),
                    config,
                    onchainPendingProposal: false,
                })
            )
        );
        assert.equal(retryCalls.length, 1);
        assert.equal(retryCalls[0].name, 'ipfs_publish');
        assert.equal(
            retryLines.some((line) =>
                line.includes('Preparing signed request archive for order') &&
                line.includes('attempt=2')
            ),
            true
        );
    });
}

async function testStatePersistsSeparatelyPerCommitment() {
    await withTempStateDir(async (stateDir) => {
        const safeA = SAFE;
        const safeB = '0x9999999999999999999999999999999999999999';
        const config = buildConfig({
            agentConfig: {
                stateDir,
            },
        });

        await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-safe-a',
                    from: SIGNER,
                    amountWei: 1_000_000n,
                }),
            ],
            commitmentText: '',
            commitmentSafe: safeA,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                commitmentSafe: safeA,
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        const stateAfterSafeA = await getSwapState();
        assert.deepEqual(getCreditFor(stateAfterSafeA, SIGNER), {
            depositedWei: '1000000',
            reservedWei: '0',
            availableWei: '1000000',
        });

        await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-safe-b',
                    from: OTHER_SIGNER,
                    amountWei: 2_000_000n,
                    transactionHash: `0x${'9'.repeat(64)}`,
                }),
            ],
            commitmentText: '',
            commitmentSafe: safeB,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                commitmentSafe: safeB,
                safeUsdcBalance: 2_000_000n,
                agentErc1155Balance: 5n,
            }),
            config: {
                ...config,
                commitmentSafe: safeB,
            },
            onchainPendingProposal: false,
        });

        const stateAfterSafeB = await getSwapState();
        assert.equal(getCreditFor(stateAfterSafeB, SIGNER), null);
        assert.deepEqual(getCreditFor(stateAfterSafeB, OTHER_SIGNER), {
            depositedWei: '2000000',
            reservedWei: '0',
            availableWei: '2000000',
        });

        await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: safeA,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                commitmentSafe: safeA,
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        const restoredStateForSafeA = await getSwapState();
        assert.deepEqual(getCreditFor(restoredStateForSafeA, SIGNER), {
            depositedWei: '1000000',
            reservedWei: '0',
            availableWei: '1000000',
        });
        assert.equal(getCreditFor(restoredStateForSafeA, OTHER_SIGNER), null);
    });
}

async function testSignedRequestWithoutDepositorCreditDoesNothing() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const toolCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedRequestSignal({
                    requestId: 'req-no-credit',
                    signer: SIGNER,
                    amount: '1',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 0n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);
        const state = await getSwapState();
        assert.equal(Object.keys(state.orders).length, 0);
        assert.equal(getCreditFor(state, SIGNER), null);
    });
}

async function testSignerMustMatchDepositor() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const toolCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-other-user',
                    from: BUYER,
                    amountWei: 1_000_000n,
                }),
                buildSignedRequestSignal({
                    requestId: 'req-mismatch',
                    signer: SIGNER,
                    amount: '1',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);
        const state = await getSwapState();
        assert.equal(state.orders[buildRequestOrderId(SIGNER, 'req-mismatch')], undefined);
        assert.deepEqual(getCreditFor(state, BUYER), {
            depositedWei: '1000000',
            reservedWei: '0',
            availableWei: '1000000',
        });
        assert.equal(getCreditFor(state, SIGNER), null);
    });
}

async function testReservedCreditPreventsOvercommitment() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const firstOrderCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-shared-credit',
                    from: SIGNER,
                    amountWei: 3_000_000n,
                }),
                buildSignedRequestSignal({
                    requestId: 'req-credit-1',
                    signer: SIGNER,
                    amount: '2',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 3_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(firstOrderCalls.length, 1);
        assert.equal(firstOrderCalls[0].name, 'ipfs_publish');

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: buildPublishedIpfsOutput('req-credit-1'),
        });

        const secondOrderCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedRequestSignal({
                    requestId: 'req-credit-2',
                    signer: SIGNER,
                    amount: '2',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 3_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(secondOrderCalls.length, 1);
        assert.equal(secondOrderCalls[0].name, 'make_erc1155_transfer');
        assert.deepEqual(parseToolArgs(secondOrderCalls[0]), {
            token: ERC1155,
            recipient: RECIPIENT,
            tokenId: ERC1155_TOKEN_ID,
            amount: '2',
            data: '0x',
        });

        const state = await getSwapState();
        assert.ok(state.orders[buildRequestOrderId(SIGNER, 'req-credit-1')]);
        assert.equal(state.orders[buildRequestOrderId(SIGNER, 'req-credit-2')], undefined);
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '3000000',
            reservedWei: '2000000',
            availableWei: '1000000',
        });
    });
}

async function testSameRequestIdAllowedForDifferentSigners() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const toolCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-same-request-a',
                    from: SIGNER,
                    amountWei: 1_000_000n,
                }),
                buildSignedRequestSignal({
                    requestId: 'shared-request-id',
                    signer: SIGNER,
                    recipient: BUYER,
                    amount: '1',
                }),
                buildDepositSignal({
                    id: 'deposit-same-request-b',
                    from: OTHER_SIGNER,
                    amountWei: 1_000_000n,
                    transactionHash: `0x${'7'.repeat(64)}`,
                }),
                buildSignedRequestSignal({
                    requestId: 'shared-request-id',
                    signer: OTHER_SIGNER,
                    recipient: RECIPIENT,
                    amount: '1',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 2_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'ipfs_publish');

        const state = await getSwapState();
        const firstOrderId = buildRequestOrderId(SIGNER, 'shared-request-id');
        const secondOrderId = buildRequestOrderId(OTHER_SIGNER, 'shared-request-id');
        assert.ok(state.orders[firstOrderId]);
        assert.ok(state.orders[secondOrderId]);
        assert.notEqual(firstOrderId, secondOrderId);
    });
}

async function testPendingDirectFillReservesInventory() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const firstFillCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-pending-inventory-a',
                    from: SIGNER,
                    amountWei: 3_000_000n,
                }),
                buildSignedRequestSignal({
                    requestId: 'req-pending-inventory-a',
                    signer: SIGNER,
                    recipient: BUYER,
                    amount: '3',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 5_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(firstFillCalls.length, 1);
        assert.equal(firstFillCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: buildPublishedIpfsOutput('req-pending-inventory-a'),
        });

        const confirmedArchiveFillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 5_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(confirmedArchiveFillCalls.length, 1);
        assert.equal(confirmedArchiveFillCalls[0].name, 'make_erc1155_transfer');
        await onToolOutput({
            name: 'make_erc1155_transfer',
            parsedOutput: {
                status: 'submitted',
                transactionHash: DIRECT_FILL_TX_HASH,
            },
        });

        const secondFillCalls = await getDeterministicToolCalls({
            signals: [
                buildDepositSignal({
                    id: 'deposit-pending-inventory-b',
                    from: OTHER_SIGNER,
                    amountWei: 2_000_000n,
                    transactionHash: `0x${'8'.repeat(64)}`,
                }),
                buildSignedRequestSignal({
                    requestId: 'req-pending-inventory-b',
                    signer: OTHER_SIGNER,
                    recipient: RECIPIENT,
                    amount: '2',
                }),
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 5_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(secondFillCalls.length, 1);
        assert.equal(secondFillCalls[0].name, 'ipfs_publish');

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: buildPublishedIpfsOutput('req-pending-inventory-b'),
        });

        const blockedFillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 5_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(blockedFillCalls.length, 0);

        const state = await getSwapState();
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-pending-inventory-a')].directFillTxHash,
            DIRECT_FILL_TX_HASH
        );
        assert.ok(state.orders[buildRequestOrderId(OTHER_SIGNER, 'req-pending-inventory-b')]);
    });
}

async function testAuthorizedAgentRequired() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [],
                    commitmentText: '',
                    commitmentSafe: SAFE,
                    agentAddress: BUYER,
                    publicClient: buildPublicClient({
                        safeUsdcBalance: 0n,
                        agentErc1155Balance: 0n,
                    }),
                    config,
                    onchainPendingProposal: false,
                }),
            /authorized agent/i
        );
    });
}

async function createSubmittedSignedRequestReimbursementOrder({
    config,
    signer,
    recipient,
    requestId,
    depositId,
    depositTransactionHash,
    directFillTxHash,
    proposalSubmissionTxHash,
    ogProposalHash = null,
}) {
    const archiveCalls = await getDeterministicToolCalls({
        signals: [
            buildDepositSignal({
                id: depositId,
                from: signer,
                amountWei: 1_000_000n,
                transactionHash: depositTransactionHash,
            }),
            buildSignedRequestSignal({
                requestId,
                signer,
                recipient,
                amount: '1',
            }),
        ],
        commitmentText: '',
        commitmentSafe: SAFE,
        agentAddress: AGENT,
        publicClient: buildPublicClient({
            safeUsdcBalance: 2_000_000n,
            agentErc1155Balance: 5n,
        }),
        config,
        onchainPendingProposal: false,
    });
    assert.equal(archiveCalls.length, 1);
    assert.equal(archiveCalls[0].name, 'ipfs_publish');

    await onToolOutput({
        name: 'ipfs_publish',
        parsedOutput: buildPublishedIpfsOutput(requestId),
    });

    const directFillCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentText: '',
        commitmentSafe: SAFE,
        agentAddress: AGENT,
        publicClient: buildPublicClient({
            safeUsdcBalance: 2_000_000n,
            agentErc1155Balance: 5n,
        }),
        config,
        onchainPendingProposal: false,
    });
    assert.equal(directFillCalls.length, 1);
    assert.equal(directFillCalls[0].name, 'make_erc1155_transfer');

    await onToolOutput({
        name: 'make_erc1155_transfer',
        parsedOutput: {
            status: 'confirmed',
            transactionHash: directFillTxHash,
        },
    });

    const reimbursementCalls = await getDeterministicToolCalls({
        signals: [
            {
                kind: 'erc20BalanceSnapshot',
                asset: USDC,
                amount: 2_000_000n,
            },
        ],
        commitmentText: '',
        commitmentSafe: SAFE,
        agentAddress: AGENT,
        publicClient: buildPublicClient({
            safeUsdcBalance: 2_000_000n,
            agentErc1155Balance: 4n,
        }),
        config,
        onchainPendingProposal: false,
    });
    assert.equal(reimbursementCalls.length, 1);
    assert.equal(reimbursementCalls[0].name, 'post_bond_and_propose');

    await onToolOutput({
        name: 'post_bond_and_propose',
        parsedOutput: {
            status: 'submitted',
            transactionHash: proposalSubmissionTxHash,
            ogProposalHash,
        },
    });

    return parseToolArgs(reimbursementCalls[0]).explanation;
}

async function testProposalHashRecoveryRequiresMatchingExplanation() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const firstExplanation = await createSubmittedSignedRequestReimbursementOrder({
            config,
            signer: SIGNER,
            recipient: BUYER,
            requestId: 'req-a',
            depositId: 'deposit-a',
            depositTransactionHash: `0x${'1'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH,
        });
        await createSubmittedSignedRequestReimbursementOrder({
            config,
            signer: OTHER_SIGNER,
            recipient: RECIPIENT,
            requestId: 'req-b',
            depositId: 'deposit-b',
            depositTransactionHash: `0x${'2'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH_2,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH_2,
        });

        const toolCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'proposal',
                    proposalHash: RECOVERED_PROPOSAL_HASH,
                    proposer: AGENT,
                    explanation: firstExplanation,
                    transactions: [
                        {
                            to: USDC,
                            operation: 0,
                            value: 0n,
                            data: encodeFunctionData({
                                abi: erc20Abi,
                                functionName: 'transfer',
                                args: [AGENT, 1_000_000n],
                            }),
                        },
                    ],
                },
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 2_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: true,
        });

        assert.equal(toolCalls.length, 0);

        const state = await getSwapState();
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-a')].reimbursementProposalHash,
            RECOVERED_PROPOSAL_HASH
        );
        assert.equal(
            state.orders[buildRequestOrderId(OTHER_SIGNER, 'req-b')].reimbursementProposalHash,
            null
        );
        assert.equal(
            state.orders[buildRequestOrderId(OTHER_SIGNER, 'req-b')].reimbursementSubmissionTxHash,
            PROPOSAL_TX_HASH_2
        );
    });
}

async function testProposalHashRecoveryPreservesFirstMatchingHash() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const explanation = await createSubmittedSignedRequestReimbursementOrder({
            config,
            signer: SIGNER,
            recipient: RECIPIENT,
            requestId: 'req-first-hash-wins',
            depositId: 'deposit-first-hash-wins',
            depositTransactionHash: `0x${'5'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH,
        });

        const toolCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'proposal',
                    proposalHash: RECOVERED_PROPOSAL_HASH,
                    proposer: AGENT,
                    explanation,
                    transactions: [
                        {
                            to: USDC,
                            operation: 0,
                            value: 0n,
                            data: encodeFunctionData({
                                abi: erc20Abi,
                                functionName: 'transfer',
                                args: [AGENT, 1_000_000n],
                            }),
                        },
                    ],
                },
                {
                    kind: 'proposal',
                    proposalHash: RECOVERED_PROPOSAL_HASH_2,
                    proposer: AGENT,
                    explanation,
                    transactions: [
                        {
                            to: USDC,
                            operation: 0,
                            value: 0n,
                            data: encodeFunctionData({
                                abi: erc20Abi,
                                functionName: 'transfer',
                                args: [AGENT, 1_000_000n],
                            }),
                        },
                    ],
                },
            ],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: true,
        });

        assert.equal(toolCalls.length, 0);

        let state = await getSwapState();
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-first-hash-wins')].reimbursementProposalHash,
            RECOVERED_PROPOSAL_HASH
        );

        await onProposalEvents({
            executedProposals: [RECOVERED_PROPOSAL_HASH],
        });

        state = await getSwapState();
        assert.ok(state.orders[buildRequestOrderId(SIGNER, 'req-first-hash-wins')].reimbursedAtMs);
    });
}

async function testStartupQueuedProposalEventsSurviveFirstRuntimeInitialization() {
    await withTempStateDir(async (stateDir) => {
        const config = buildConfig({
            agentConfig: {
                stateDir,
            },
        });

        await createSubmittedSignedRequestReimbursementOrder({
            config,
            signer: SIGNER,
            recipient: RECIPIENT,
            requestId: 'req-startup-queued-proposal',
            depositId: 'deposit-startup-queued-proposal',
            depositTransactionHash: `0x${'3'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH,
            ogProposalHash: OG_PROPOSAL_HASH,
        });

        setSwapStatePathForTest(null);
        await onProposalEvents({
            executedProposals: [OG_PROPOSAL_HASH],
        });

        const toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);
        const state = await getSwapState();
        assert.ok(state.orders[buildRequestOrderId(SIGNER, 'req-startup-queued-proposal')].reimbursedAtMs);
    });
}

async function testHydratedProposalEventsPersistImmediately() {
    await withTempStateDir(async (stateDir) => {
        const config = buildConfig({
            agentConfig: {
                stateDir,
            },
        });

        await createSubmittedSignedRequestReimbursementOrder({
            config,
            signer: SIGNER,
            recipient: RECIPIENT,
            requestId: 'req-persisted-proposal-event',
            depositId: 'deposit-persisted-proposal-event',
            depositTransactionHash: `0x${'4'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH,
            ogProposalHash: OG_PROPOSAL_HASH,
        });

        await onProposalEvents({
            executedProposals: [OG_PROPOSAL_HASH],
        });

        setSwapStatePathForTest(null);

        const toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentText: '',
            commitmentSafe: SAFE,
            agentAddress: AGENT,
            publicClient: buildPublicClient({
                safeUsdcBalance: 1_000_000n,
                agentErc1155Balance: 4n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);
        const state = await getSwapState();
        assert.ok(state.orders[buildRequestOrderId(SIGNER, 'req-persisted-proposal-event')].reimbursedAtMs);
    });
}

async function testStaleDirectFillSubmissionRetries() {
    await withTempStatePath(async () => {
        const config = buildConfig({
            agentConfig: {
                pendingTxTimeoutMs: 1_000,
            },
        });

        await withMockedNow(1_000, async () => {
            const archiveCalls = await getDeterministicToolCalls({
                signals: [
                    buildDepositSignal({
                        id: 'deposit-stale-fill',
                        from: SIGNER,
                        amountWei: 1_000_000n,
                        transactionHash: `0x${'3'.repeat(64)}`,
                    }),
                    buildSignedRequestSignal({
                        requestId: 'req-stale-fill',
                        signer: SIGNER,
                        recipient: RECIPIENT,
                        amount: '1',
                    }),
                ],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 5n,
                }),
                config,
                onchainPendingProposal: false,
            });
            assert.equal(archiveCalls.length, 1);
            assert.equal(archiveCalls[0].name, 'ipfs_publish');
            await onToolOutput({
                name: 'ipfs_publish',
                parsedOutput: buildPublishedIpfsOutput('req-stale-fill'),
            });

            const directFillCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 5n,
                }),
                config,
                onchainPendingProposal: false,
            });
            assert.equal(directFillCalls.length, 1);
            assert.equal(directFillCalls[0].name, 'make_erc1155_transfer');
            await onToolOutput({
                name: 'make_erc1155_transfer',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: DIRECT_FILL_TX_HASH,
                },
            });
        });

        const retryCalls = await withMockedNow(2_500, async () =>
            getDeterministicToolCalls({
                signals: [],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 5n,
                    receiptErrorsByHash: {
                        [DIRECT_FILL_TX_HASH.toLowerCase()]: buildReceiptNotFoundError(
                            DIRECT_FILL_TX_HASH
                        ),
                    },
                }),
                config,
                onchainPendingProposal: false,
            })
        );

        assert.equal(retryCalls.length, 1);
        assert.equal(retryCalls[0].name, 'make_erc1155_transfer');
        assert.deepEqual(parseToolArgs(retryCalls[0]), {
            token: ERC1155,
            recipient: RECIPIENT,
            tokenId: ERC1155_TOKEN_ID,
            amount: '1',
            data: '0x',
        });

        const state = await getSwapState();
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-stale-fill')].directFillTxHash,
            undefined
        );
    });
}

async function testStaleProposalSubmissionRetries() {
    await withTempStatePath(async () => {
        const config = buildConfig({
            agentConfig: {
                pendingTxTimeoutMs: 1_000,
            },
        });

        await withMockedNow(1_000, async () => {
            await createSubmittedSignedRequestReimbursementOrder({
                config,
                signer: SIGNER,
                recipient: RECIPIENT,
                requestId: 'req-stale-proposal',
                depositId: 'deposit-stale-proposal',
                depositTransactionHash: `0x${'4'.repeat(64)}`,
                directFillTxHash: DIRECT_FILL_TX_HASH,
                proposalSubmissionTxHash: PROPOSAL_TX_HASH,
            });
        });

        const retryCalls = await withMockedNow(2_500, async () =>
            getDeterministicToolCalls({
                signals: [],
                commitmentText: '',
                commitmentSafe: SAFE,
                agentAddress: AGENT,
                publicClient: buildPublicClient({
                    safeUsdcBalance: 1_000_000n,
                    agentErc1155Balance: 4n,
                    receiptErrorsByHash: {
                        [PROPOSAL_TX_HASH.toLowerCase()]: buildReceiptNotFoundError(PROPOSAL_TX_HASH),
                    },
                }),
                config,
                onchainPendingProposal: false,
            })
        );

        assert.equal(retryCalls.length, 1);
        assert.equal(retryCalls[0].name, 'post_bond_and_propose');
        const retryArgs = parseToolArgs(retryCalls[0]);
        assert.equal(retryArgs.transactions.length, 1);
        assert.match(
            retryArgs.explanation,
            new RegExp(`order=${buildRequestOrderId(SIGNER, 'req-stale-proposal')}`)
        );

        const state = await getSwapState();
        assert.equal(
            state.orders[buildRequestOrderId(SIGNER, 'req-stale-proposal')].reimbursementSubmissionTxHash,
            undefined
        );
    });
}

async function run() {
    await testDepositCreatesCreditOnly();
    await testStartupBackfillsDepositorCreditFromHistory();
    await testStartupLogsWhenCreditBackfillAlreadyComplete();
    await testStartupBackfillReconstructsHistoricalSpentCredit();
    await testSignedFastWithdrawLifecycleUsesDepositorCredit();
    await testDirectFillWaitsForSafeReimbursementLiquidity();
    await testFreeTextSignedRequestUsesLlmInterpretation();
    await testArchiveFailureLogsAndBacksOffBeforeRetry();
    await testStatePersistsSeparatelyPerCommitment();
    await testSignedRequestWithoutDepositorCreditDoesNothing();
    await testSignerMustMatchDepositor();
    await testReservedCreditPreventsOvercommitment();
    await testSameRequestIdAllowedForDifferentSigners();
    await testPendingDirectFillReservesInventory();
    await testAuthorizedAgentRequired();
    await testProposalHashRecoveryRequiresMatchingExplanation();
    await testProposalHashRecoveryPreservesFirstMatchingHash();
    await testStartupQueuedProposalEventsSurviveFirstRuntimeInitialization();
    await testHydratedProposalEventsPersistImmediately();
    await testStaleDirectFillSubmissionRetries();
    await testStaleProposalSubmissionRetries();
    console.log('[test] erc1155 swap fast withdraw agent OK');
}

run().catch((error) => {
    console.error('[test] erc1155 swap fast withdraw agent failed:', error?.message ?? error);
    process.exit(1);
});
