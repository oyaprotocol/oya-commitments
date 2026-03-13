import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, erc20Abi } from 'viem';
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
const USDC = '0x6666666666666666666666666666666666666666';
const ERC1155 = '0x7777777777777777777777777777777777777777';
const ERC1155_TOKEN_ID = '42';
const DIRECT_FILL_TX_HASH = `0x${'a'.repeat(64)}`;
const PROPOSAL_TX_HASH = `0x${'b'.repeat(64)}`;
const OG_PROPOSAL_HASH = `0x${'c'.repeat(64)}`;
const DIRECT_FILL_TX_HASH_2 = `0x${'d'.repeat(64)}`;
const PROPOSAL_TX_HASH_2 = `0x${'e'.repeat(64)}`;
const RECOVERED_PROPOSAL_HASH = `0x${'f'.repeat(64)}`;

function buildConfig(overrides = {}) {
    const { agentConfig: agentConfigOverrides = {}, ...topLevelOverrides } = overrides;
    return {
        commitmentSafe: SAFE,
        watchAssets: [USDC],
        watchErc1155Assets: [
            {
                token: ERC1155,
                tokenId: ERC1155_TOKEN_ID,
                symbol: 'TEST-42',
            },
        ],
        agentConfig: {
            paymentTokenSymbol: 'USDC',
            usdcUnitAmountWei: '1000000',
            fillConfirmationThreshold: 1,
            signedCommands: ['fast_withdraw', 'fast_withdraw_erc1155'],
            ...agentConfigOverrides,
        },
        ...topLevelOverrides,
    };
}

function buildReceiptNotFoundError(hash) {
    const error = new Error(`transaction receipt for ${hash} not found`);
    error.name = 'TransactionReceiptNotFoundError';
    return error;
}

function buildPublicClient({
    latestBlock = 100n,
    safeUsdcBalance = 0n,
    agentErc1155Balance = 0n,
    directFillReceipt = null,
    receiptsByHash = null,
    receiptErrorsByHash = null,
} = {}) {
    return {
        async getBlockNumber() {
            return latestBlock;
        },
        async readContract({ address, functionName, args }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress === USDC.toLowerCase() && functionName === 'balanceOf') {
                assert.equal(String(args[0]).toLowerCase(), SAFE.toLowerCase());
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

async function withMockedNow(nowMs, fn) {
    const originalNow = Date.now;
    Date.now = () => nowMs;
    try {
        return await fn();
    } finally {
        Date.now = originalNow;
    }
}

async function withTempStatePath(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'erc1155-swap-fast-withdraw-'));
    const statePath = path.join(dir, 'swap-state.json');
    setSwapStatePathForTest(statePath);
    await resetSwapState();
    try {
        await fn();
    } finally {
        setSwapStatePathForTest(null);
        await rm(dir, { recursive: true, force: true });
    }
}

async function testPaymentDepositLifecycle() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const paymentSignals = [
            {
                kind: 'erc20Deposit',
                asset: USDC,
                from: BUYER,
                amount: 2_000_000n,
                transactionHash: `0x${'1'.repeat(64)}`,
                logIndex: 0,
                id: 'payment-1',
            },
        ];

        const directFillCalls = await getDeterministicToolCalls({
            signals: paymentSignals,
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
        assert.deepEqual(parseToolArgs(directFillCalls[0]), {
            token: ERC1155,
            recipient: BUYER,
            tokenId: ERC1155_TOKEN_ID,
            amount: '2',
            data: '0x',
        });

        await onToolOutput({
            name: 'make_erc1155_transfer',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: DIRECT_FILL_TX_HASH,
            },
        });

        const afterFill = await getSwapState();
        const paymentOrder = afterFill.orders['payment:payment-1'];
        assert.ok(paymentOrder);
        assert.equal(paymentOrder.directFillTxHash, DIRECT_FILL_TX_HASH);
        assert.equal(paymentOrder.directFillConfirmed, true);

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
                latestBlock: 101n,
                safeUsdcBalance: 2_000_000n,
                agentErc1155Balance: 3n,
                directFillReceipt: {
                    blockNumber: 100n,
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
        assert.match(reimbursementArgs.explanation, /order=payment:payment-1/);

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: PROPOSAL_TX_HASH,
                ogProposalHash: OG_PROPOSAL_HASH,
            },
        });

        const afterProposal = await getSwapState();
        assert.equal(
            afterProposal.orders['payment:payment-1'].reimbursementProposalHash,
            OG_PROPOSAL_HASH
        );
        assert.equal(
            afterProposal.orders['payment:payment-1'].reimbursementSubmissionTxHash,
            PROPOSAL_TX_HASH
        );

        onProposalEvents({
            executedProposals: [OG_PROPOSAL_HASH],
            deletedProposals: [],
        });

        const afterExecution = await getSwapState();
        assert.ok(afterExecution.orders['payment:payment-1'].reimbursedAtMs);
    });
}

async function testSignedFastWithdrawLifecycle() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const requestSignals = [
            {
                kind: 'userMessage',
                requestId: 'req-1',
                messageId: 'msg-1',
                command: 'fast_withdraw_erc1155',
                args: {
                    recipient: RECIPIENT,
                    amount: '3',
                    token: ERC1155,
                    tokenId: ERC1155_TOKEN_ID,
                },
                text: 'Please fast withdraw 3 test ERC1155 tokens to the recipient.',
                sender: {
                    authType: 'eip191',
                    address: SIGNER,
                    signature: `0x${'9'.repeat(130)}`,
                    signedAtMs: Date.now(),
                },
                receivedAtMs: Date.now(),
            },
        ];

        const directFillCalls = await getDeterministicToolCalls({
            signals: requestSignals,
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
        assert.equal(directFillCalls[0].name, 'make_erc1155_transfer');
        assert.deepEqual(parseToolArgs(directFillCalls[0]), {
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
        assert.equal(reimbursementArgs.transactions[0].to.toLowerCase(), USDC.toLowerCase());
        assert.match(reimbursementArgs.explanation, /order=request:req-1/);
    });
}

async function createSubmittedPaymentReimbursementOrder({
    config,
    payer,
    paymentId,
    paymentTransactionHash,
    directFillTxHash,
    proposalSubmissionTxHash,
}) {
    const directFillCalls = await getDeterministicToolCalls({
        signals: [
            {
                kind: 'erc20Deposit',
                asset: USDC,
                from: payer,
                amount: 1_000_000n,
                transactionHash: paymentTransactionHash,
                logIndex: 0,
                id: paymentId,
            },
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
        },
    });

    return parseToolArgs(reimbursementCalls[0]).explanation;
}

async function testProposalHashRecoveryRequiresMatchingExplanation() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const firstExplanation = await createSubmittedPaymentReimbursementOrder({
            config,
            payer: BUYER,
            paymentId: 'payment-a',
            paymentTransactionHash: `0x${'1'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH,
        });
        await createSubmittedPaymentReimbursementOrder({
            config,
            payer: RECIPIENT,
            paymentId: 'payment-b',
            paymentTransactionHash: `0x${'2'.repeat(64)}`,
            directFillTxHash: DIRECT_FILL_TX_HASH_2,
            proposalSubmissionTxHash: PROPOSAL_TX_HASH_2,
        });

        const recoverySignals = [
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
        ];

        const toolCalls = await getDeterministicToolCalls({
            signals: recoverySignals,
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
            state.orders['payment:payment-a'].reimbursementProposalHash,
            RECOVERED_PROPOSAL_HASH
        );
        assert.equal(
            state.orders['payment:payment-b'].reimbursementProposalHash,
            null
        );
        assert.equal(
            state.orders['payment:payment-b'].reimbursementSubmissionTxHash,
            PROPOSAL_TX_HASH_2
        );
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
            const directFillCalls = await getDeterministicToolCalls({
                signals: [
                    {
                        kind: 'erc20Deposit',
                        asset: USDC,
                        from: BUYER,
                        amount: 1_000_000n,
                        transactionHash: `0x${'3'.repeat(64)}`,
                        logIndex: 0,
                        id: 'payment-stale-fill',
                    },
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
            assert.equal(directFillCalls.length, 1);
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
            recipient: BUYER,
            tokenId: ERC1155_TOKEN_ID,
            amount: '1',
            data: '0x',
        });

        const state = await getSwapState();
        assert.equal(state.orders['payment:payment-stale-fill'].directFillTxHash, undefined);
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
            await createSubmittedPaymentReimbursementOrder({
                config,
                payer: BUYER,
                paymentId: 'payment-stale-proposal',
                paymentTransactionHash: `0x${'4'.repeat(64)}`,
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
        assert.match(retryArgs.explanation, /order=payment:payment-stale-proposal/);

        const state = await getSwapState();
        assert.equal(
            state.orders['payment:payment-stale-proposal'].reimbursementSubmissionTxHash,
            undefined
        );
    });
}

async function run() {
    await testPaymentDepositLifecycle();
    await testSignedFastWithdrawLifecycle();
    await testProposalHashRecoveryRequiresMatchingExplanation();
    await testStaleDirectFillSubmissionRetries();
    await testStaleProposalSubmissionRetries();
    console.log('[test] erc1155 swap fast withdraw agent OK');
}

run().catch((error) => {
    console.error('[test] erc1155 swap fast withdraw agent failed:', error?.message ?? error);
    process.exit(1);
});
