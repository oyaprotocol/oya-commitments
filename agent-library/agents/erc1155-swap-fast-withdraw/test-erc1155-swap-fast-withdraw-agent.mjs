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
const OTHER_SIGNER = '0x6666666666666666666666666666666666666666';
const USDC = '0x7777777777777777777777777777777777777777';
const ERC1155 = '0x8888888888888888888888888888888888888888';
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
            authorizedAgent: AGENT,
            paymentTokenSymbol: 'USDC',
            usdcUnitAmountWei: '1000000',
            fillConfirmationThreshold: 1,
            signedCommands: ['fast_withdraw', 'fast_withdraw_erc1155'],
            ...agentConfigOverrides,
        },
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
} = {}) {
    return {
        kind: 'userMessage',
        requestId,
        messageId: `msg-${requestId}`,
        command,
        args: {
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

async function testDepositCreatesCreditOnly() {
    await withTempStatePath(async () => {
        const config = buildConfig();
        const toolCalls = await getDeterministicToolCalls({
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
                safeUsdcBalance: 2_000_000n,
                agentErc1155Balance: 5n,
            }),
            config,
            onchainPendingProposal: false,
        });

        assert.equal(toolCalls.length, 0);

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
        assert.equal(reimbursementArgs.transactions.length, 1);
        assert.equal(reimbursementArgs.transactions[0].to.toLowerCase(), USDC.toLowerCase());
        assert.match(reimbursementArgs.explanation, /order=request:req-1/);
        assert.match(reimbursementArgs.explanation, new RegExp(`signer=${SIGNER}`, 'i'));

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: PROPOSAL_TX_HASH,
                ogProposalHash: OG_PROPOSAL_HASH,
            },
        });

        const state = await getSwapState();
        const order = state.orders['request:req-1'];
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
        assert.equal(state.orders['request:req-mismatch'], undefined);
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
        await onToolOutput({
            name: 'make_erc1155_transfer',
            parsedOutput: {
                status: 'submitted',
                transactionHash: DIRECT_FILL_TX_HASH,
            },
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

        assert.equal(secondOrderCalls.length, 0);

        const state = await getSwapState();
        assert.ok(state.orders['request:req-credit-1']);
        assert.equal(state.orders['request:req-credit-2'], undefined);
        assert.deepEqual(getCreditFor(state, SIGNER), {
            depositedWei: '3000000',
            reservedWei: '2000000',
            availableWei: '1000000',
        });
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
}) {
    const directFillCalls = await getDeterministicToolCalls({
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
            state.orders['request:req-a'].reimbursementProposalHash,
            RECOVERED_PROPOSAL_HASH
        );
        assert.equal(
            state.orders['request:req-b'].reimbursementProposalHash,
            null
        );
        assert.equal(
            state.orders['request:req-b'].reimbursementSubmissionTxHash,
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
            recipient: RECIPIENT,
            tokenId: ERC1155_TOKEN_ID,
            amount: '1',
            data: '0x',
        });

        const state = await getSwapState();
        assert.equal(state.orders['request:req-stale-fill'].directFillTxHash, undefined);
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
        assert.match(retryArgs.explanation, /order=request:req-stale-proposal/);

        const state = await getSwapState();
        assert.equal(
            state.orders['request:req-stale-proposal'].reimbursementSubmissionTxHash,
            undefined
        );
    });
}

async function run() {
    await testDepositCreatesCreditOnly();
    await testSignedFastWithdrawLifecycleUsesDepositorCredit();
    await testSignedRequestWithoutDepositorCreditDoesNothing();
    await testSignerMustMatchDepositor();
    await testReservedCreditPreventsOvercommitment();
    await testAuthorizedAgentRequired();
    await testProposalHashRecoveryRequiresMatchingExplanation();
    await testStaleDirectFillSubmissionRetries();
    await testStaleProposalSubmissionRetries();
    console.log('[test] erc1155 swap fast withdraw agent OK');
}

run().catch((error) => {
    console.error('[test] erc1155 swap fast withdraw agent failed:', error?.message ?? error);
    process.exit(1);
});
