import assert from 'node:assert/strict';
import {
    calculateCopyAmounts,
    computeBuyOrderAmounts,
    enrichSignals,
    getCopyTradingState,
    getSystemPrompt,
    onProposalEvents,
    onToolOutput,
    resetCopyTradingState,
    validateToolCalls,
} from './agent.js';

const YES_TOKEN_ID = '123';
const NO_TOKEN_ID = '456';
const TEST_ACCOUNT = '0x1111111111111111111111111111111111111111';
const TEST_SAFE = '0x2222222222222222222222222222222222222222';
const TEST_SOURCE_USER = '0x3333333333333333333333333333333333333333';
const TEST_CLOB_PROXY = '0x4444444444444444444444444444444444444444';
const TEST_RELAYER_PROXY = '0x5555555555555555555555555555555555555555';
const TEST_PROPOSAL_HASH = `0x${'a'.repeat(64)}`;
const OTHER_PROPOSAL_HASH = `0x${'b'.repeat(64)}`;
const TEST_TX_HASH = `0x${'c'.repeat(64)}`;

function encodeErc20TransferData({ to, amount }) {
    const toWord = to.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const amountWord = BigInt(amount).toString(16).padStart(64, '0');
    return `0xa9059cbb${toWord}${amountWord}`;
}

function runPromptTest() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText: 'Copy-trade commitment.',
    });

    assert.ok(prompt.includes('copy-trading commitment agent'));
    assert.ok(prompt.includes('99%'));
    assert.ok(prompt.includes('1%'));
}

function runMathTests() {
    const amounts = calculateCopyAmounts(1_000_000n);
    assert.equal(amounts.copyAmountWei, '990000');
    assert.equal(amounts.feeAmountWei, '10000');

    const sized = computeBuyOrderAmounts({
        collateralAmountWei: 990000n,
        price: 0.55,
    });
    assert.equal(sized.takerAmount, '990000');
    assert.ok(BigInt(sized.makerAmount) > 0n);
}

async function runValidateToolCallTests() {
    const policy = {
        ready: true,
        ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
        collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    };

    const orderValidated = await validateToolCalls({
        toolCalls: [
            {
                callId: 'order',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {},
            },
        ],
        signals: [
            {
                kind: 'copyTradingState',
                policy,
                state: {
                    activeSourceTradeId: 'trade-1',
                    activeTradeSide: 'BUY',
                    activeTradePrice: 0.55,
                    activeTokenId: '123',
                    copyTradeAmountWei: '990000',
                    reimbursementAmountWei: '1000000',
                    orderSubmitted: false,
                    tokenDeposited: false,
                    reimbursementProposed: false,
                },
                latestObservedTrade: {
                    side: 'SELL',
                    price: 0.99,
                },
                balances: {
                    activeTokenBalance: '0',
                },
                pendingProposal: false,
            },
        ],
        config: {},
        agentAddress: '0x1111111111111111111111111111111111111111',
        onchainPendingProposal: false,
    });
    assert.equal(orderValidated.length, 1);
    assert.equal(orderValidated[0].parsedArguments.side, 'BUY');
    assert.equal(orderValidated[0].parsedArguments.tokenId, '123');
    assert.equal(orderValidated[0].parsedArguments.orderType, 'FOK');
    assert.equal(orderValidated[0].parsedArguments.makerAmount, '1800000');
    assert.equal(orderValidated[0].parsedArguments.takerAmount, '990000');

    const depositValidated = await validateToolCalls({
        toolCalls: [
            {
                callId: 'deposit',
                name: 'make_erc1155_deposit',
                arguments: {},
            },
        ],
        signals: [
            {
                kind: 'copyTradingState',
                policy,
                state: {
                    activeSourceTradeId: 'trade-1',
                    activeTradeSide: 'BUY',
                    activeTradePrice: 0.55,
                    activeTokenId: '123',
                    copyTradeAmountWei: '990000',
                    reimbursementAmountWei: '1000000',
                    copyOrderId: 'order-1',
                    copyOrderFilled: true,
                    orderSubmitted: true,
                    tokenDeposited: false,
                    reimbursementProposed: false,
                },
                balances: {
                    activeTokenBalance: '5',
                },
                pendingProposal: false,
            },
        ],
        config: {},
        agentAddress: '0x1111111111111111111111111111111111111111',
        onchainPendingProposal: false,
    });
    assert.equal(depositValidated.length, 1);
    assert.equal(depositValidated[0].parsedArguments.token, policy.ctfContract);
    assert.equal(depositValidated[0].parsedArguments.tokenId, '123');
    assert.equal(depositValidated[0].parsedArguments.amount, '5');

    await assert.rejects(
        () =>
            validateToolCalls({
                toolCalls: [
                    {
                        callId: 'deposit-not-filled',
                        name: 'make_erc1155_deposit',
                        arguments: {},
                    },
                ],
                signals: [
                    {
                        kind: 'copyTradingState',
                        policy,
                        state: {
                            activeSourceTradeId: 'trade-1',
                            activeTradeSide: 'BUY',
                            activeTradePrice: 0.55,
                            activeTokenId: '123',
                            copyTradeAmountWei: '990000',
                            reimbursementAmountWei: '1000000',
                            copyOrderId: 'order-1',
                            copyOrderFilled: false,
                            orderSubmitted: true,
                            tokenDeposited: false,
                            reimbursementProposed: false,
                        },
                        balances: {
                            activeTokenBalance: '5',
                        },
                        pendingProposal: false,
                    },
                ],
                config: {},
                agentAddress: '0x1111111111111111111111111111111111111111',
                onchainPendingProposal: false,
            }),
        /not been filled yet/
    );

    const reimbursementValidated = await validateToolCalls({
        toolCalls: [
            {
                callId: 'reimbursement',
                name: 'build_og_transactions',
                arguments: {},
            },
        ],
        signals: [
            {
                kind: 'copyTradingState',
                policy,
                state: {
                    activeSourceTradeId: 'trade-1',
                    activeTradeSide: 'BUY',
                    activeTradePrice: 0.55,
                    activeTokenId: '123',
                    copyTradeAmountWei: '990000',
                    reimbursementAmountWei: '1000000',
                    reimbursementRecipientAddress: TEST_CLOB_PROXY,
                    orderSubmitted: true,
                    tokenDeposited: true,
                    reimbursementProposed: false,
                },
                balances: {
                    activeTokenBalance: '0',
                },
                pendingProposal: false,
            },
        ],
        config: {},
        agentAddress: '0x1111111111111111111111111111111111111111',
        onchainPendingProposal: false,
    });
    assert.equal(reimbursementValidated.length, 1);
    assert.equal(reimbursementValidated[0].parsedArguments.actions.length, 1);
    assert.equal(reimbursementValidated[0].parsedArguments.actions[0].kind, 'erc20_transfer');
    assert.equal(
        reimbursementValidated[0].parsedArguments.actions[0].to.toLowerCase(),
        TEST_CLOB_PROXY.toLowerCase()
    );
    assert.equal(reimbursementValidated[0].parsedArguments.actions[0].amountWei, '1000000');
}

async function runProposalHashGatingTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        await enrichSignals([], {
            publicClient: {
                async readContract({ args }) {
                    if (args.length === 1) {
                        return 1_000_000n;
                    }
                    return 0n;
                },
            },
            config: {
                commitmentSafe: TEST_SAFE,
                polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
            },
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        let state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, 'trade-1');
        assert.equal(state.activeTradeSide, 'BUY');
        assert.equal(state.activeTradePrice, 0.5);
        assert.equal(state.copyTradeAmountWei, '990000');
        assert.equal(state.reimbursementAmountWei, '1000000');
        assert.equal(state.reimbursementRecipientAddress, TEST_ACCOUNT.toLowerCase());

        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_TX_HASH,
                proposalHash: TEST_TX_HASH,
                ogProposalHash: TEST_PROPOSAL_HASH,
            },
        });

        state = getCopyTradingState();
        assert.equal(state.reimbursementProposed, true);
        assert.equal(state.reimbursementProposalHash, TEST_PROPOSAL_HASH);

        onProposalEvents({
            executedProposals: [OTHER_PROPOSAL_HASH],
            executedProposalCount: 1,
        });
        state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, 'trade-1');

        onProposalEvents({
            executedProposals: [TEST_PROPOSAL_HASH],
            executedProposalCount: 1,
        });
        state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, null);
        assert.equal(state.seenSourceTradeId, 'trade-1');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

function runLegacyProposalHashFallbackTest() {
    resetCopyTradingState();
    onToolOutput({
        name: 'post_bond_and_propose',
        parsedOutput: { status: 'submitted', proposalHash: TEST_PROPOSAL_HASH },
    });
    const state = getCopyTradingState();
    assert.equal(state.reimbursementProposed, true);
    assert.equal(state.reimbursementProposalHash, TEST_PROPOSAL_HASH);
    assert.equal(state.reimbursementSubmissionPending, false);
    resetCopyTradingState();
}

async function runProposalHashRecoveryFromSignalTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 0n;
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted', transactionHash: TEST_TX_HASH },
        });

        let state = getCopyTradingState();
        assert.equal(state.reimbursementProposed, false);
        assert.equal(state.reimbursementProposalHash, null);
        assert.equal(state.reimbursementSubmissionPending, true);
        assert.equal(state.reimbursementSubmissionTxHash, TEST_TX_HASH);
        assert.equal(typeof state.reimbursementSubmissionMs, 'number');
        assert.equal(state.copyTradeAmountWei, '990000');
        assert.equal(state.reimbursementAmountWei, '1000000');

        const reimbursementAmountWei = state.reimbursementAmountWei;
        const proposalSignal = {
            kind: 'proposal',
            proposalHash: TEST_PROPOSAL_HASH,
            proposer: TEST_ACCOUNT,
            transactions: [
                {
                    to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    value: 0n,
                    operation: 0,
                    data: encodeErc20TransferData({
                        to: TEST_ACCOUNT,
                        amount: reimbursementAmountWei,
                    }),
                },
            ],
        };

        await enrichSignals([proposalSignal], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: true,
        });

        state = getCopyTradingState();
        assert.equal(state.reimbursementProposed, true);
        assert.equal(state.reimbursementProposalHash, TEST_PROPOSAL_HASH);
        assert.equal(state.reimbursementSubmissionPending, false);

        onProposalEvents({
            executedProposals: [TEST_PROPOSAL_HASH],
            executedProposalCount: 1,
        });
        state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, null);
        assert.equal(state.seenSourceTradeId, 'trade-1');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runProposalHashRecoveryFromSignalUsesFundingWalletTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
            polymarketClobAddress: TEST_CLOB_PROXY,
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 0n;
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted', transactionHash: TEST_TX_HASH },
        });

        let state = getCopyTradingState();
        assert.equal(state.reimbursementRecipientAddress, TEST_CLOB_PROXY.toLowerCase());
        assert.equal(state.reimbursementSubmissionPending, true);

        const reimbursementAmountWei = state.reimbursementAmountWei;
        const wrongRecipientSignal = {
            kind: 'proposal',
            proposalHash: OTHER_PROPOSAL_HASH,
            proposer: TEST_ACCOUNT,
            transactions: [
                {
                    to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    value: 0n,
                    operation: 0,
                    data: encodeErc20TransferData({
                        to: TEST_ACCOUNT,
                        amount: reimbursementAmountWei,
                    }),
                },
            ],
        };

        await enrichSignals([wrongRecipientSignal], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: true,
        });

        state = getCopyTradingState();
        assert.equal(state.reimbursementProposalHash, null);
        assert.equal(state.reimbursementSubmissionPending, true);

        const correctRecipientSignal = {
            kind: 'proposal',
            proposalHash: TEST_PROPOSAL_HASH,
            proposer: TEST_ACCOUNT,
            transactions: [
                {
                    to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    value: 0n,
                    operation: 0,
                    data: encodeErc20TransferData({
                        to: TEST_CLOB_PROXY,
                        amount: reimbursementAmountWei,
                    }),
                },
            ],
        };

        await enrichSignals([correctRecipientSignal], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: true,
        });

        state = getCopyTradingState();
        assert.equal(state.reimbursementProposed, true);
        assert.equal(state.reimbursementProposalHash, TEST_PROPOSAL_HASH);
        assert.equal(state.reimbursementSubmissionPending, false);

        onProposalEvents({
            executedProposals: [TEST_PROPOSAL_HASH],
            executedProposalCount: 1,
        });
        state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, null);
        assert.equal(state.seenSourceTradeId, 'trade-1');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runRevertedSubmissionClearsPendingTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 0n;
            },
            async getTransactionReceipt() {
                return { status: 0n };
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: { status: 'submitted' },
        });
        onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: { status: 'confirmed' },
        });
        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted', transactionHash: TEST_TX_HASH },
        });

        let state = getCopyTradingState();
        assert.equal(state.reimbursementSubmissionPending, true);
        assert.equal(state.reimbursementSubmissionTxHash, TEST_TX_HASH);

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        state = getCopyTradingState();
        assert.equal(state.reimbursementSubmissionPending, false);
        assert.equal(state.reimbursementSubmissionTxHash, null);
        assert.equal(state.reimbursementSubmissionMs, null);

        const reimbursementValidated = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'reimbursement',
                    name: 'build_og_transactions',
                    arguments: {},
                },
            ],
            signals: [
                {
                    kind: 'copyTradingState',
                    policy: {
                        ready: true,
                        ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
                        collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    },
                    state,
                    balances: {
                        activeTokenBalance: '0',
                    },
                    pendingProposal: false,
                },
            ],
            config: {},
            agentAddress: TEST_ACCOUNT,
            onchainPendingProposal: false,
        });

        assert.equal(reimbursementValidated.length, 1);
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runOrderFillConfirmationGatesDepositTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        const apiSecret = Buffer.from('test-secret').toString('base64');
        globalThis.fetch = async (url) => {
            const asText = String(url);
            if (asText.includes('data-api.polymarket.com/activity')) {
                return {
                    ok: true,
                    async json() {
                        return [
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ];
                    },
                    async text() {
                        return JSON.stringify([
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ]);
                    },
                };
            }
            if (asText.includes('/data/order/order-1')) {
                return {
                    ok: true,
                    async text() {
                        return JSON.stringify({
                            order: {
                                id: 'order-1',
                                status: 'filled',
                                original_size: '100',
                                size_matched: '100',
                            },
                        });
                    },
                };
            }
            if (asText.includes('/data/trades?')) {
                return {
                    ok: true,
                    async text() {
                        return JSON.stringify([
                            {
                                id: 'trade-confirmed-1',
                                status: 'CONFIRMED',
                                taker_order_id: 'order-1',
                            },
                        ]);
                    },
                };
            }
            throw new Error(`Unexpected fetch URL in test: ${asText}`);
        };

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
            polymarketClobHost: 'https://clob.polymarket.com',
            polymarketClobApiKey: 'api-key',
            polymarketClobApiSecret: apiSecret,
            polymarketClobApiPassphrase: 'pass',
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 5n;
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    id: 'order-1',
                    status: 'live',
                },
            },
        });

        let state = getCopyTradingState();
        assert.equal(state.copyOrderId, 'order-1');
        assert.equal(state.copyOrderFilled, false);

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        state = getCopyTradingState();
        assert.equal(state.copyOrderId, 'order-1');
        assert.equal(state.copyOrderFilled, true);
        assert.equal(state.copyOrderStatus, 'FILLED');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runMissingOrderIdDoesNotAdvanceOrderStateTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 5n;
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: { status: 'submitted' },
        });

        const state = getCopyTradingState();
        assert.equal(state.orderSubmitted, false);
        assert.equal(state.copyOrderId, null);
        assert.equal(state.copyOrderSubmittedMs, null);
        assert.equal(state.copyOrderFilled, false);

        await assert.rejects(
            () =>
                validateToolCalls({
                    toolCalls: [
                        {
                            callId: 'deposit-no-order-id',
                            name: 'make_erc1155_deposit',
                            arguments: {},
                        },
                    ],
                    signals: [
                        {
                            kind: 'copyTradingState',
                            policy: {
                                ready: true,
                                ctfContract: config.polymarketConditionalTokens,
                                collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                            },
                            state,
                            balances: {
                                activeTokenBalance: '5',
                            },
                            pendingProposal: false,
                        },
                    ],
                    config: {},
                    agentAddress: TEST_ACCOUNT,
                    onchainPendingProposal: false,
                }),
            /before copy order submission/
        );

        const orderValidated = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'order-retry',
                    name: 'polymarket_clob_build_sign_and_place_order',
                    arguments: {},
                },
            ],
            signals: [
                {
                    kind: 'copyTradingState',
                    policy: {
                        ready: true,
                        ctfContract: config.polymarketConditionalTokens,
                        collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    },
                    state,
                    balances: {
                        activeTokenBalance: '5',
                    },
                    pendingProposal: false,
                },
            ],
            config: {},
            agentAddress: TEST_ACCOUNT,
            onchainPendingProposal: false,
        });
        assert.equal(orderValidated.length, 1);
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runSubmissionWithoutHashesDoesNotWedgeTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const config = {
            commitmentSafe: TEST_SAFE,
            polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        };
        const publicClient = {
            async readContract({ args }) {
                if (args.length === 1) return 1_000_000n;
                return 0n;
            },
        };

        await enrichSignals([], {
            publicClient,
            config,
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: { status: 'submitted' },
        });
        onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: { status: 'confirmed' },
        });
        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted' },
        });

        const state = getCopyTradingState();
        assert.equal(state.reimbursementProposed, false);
        assert.equal(state.reimbursementProposalHash, null);
        assert.equal(state.reimbursementSubmissionPending, false);
        assert.equal(state.reimbursementSubmissionTxHash, null);

        const reimbursementValidated = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'reimbursement',
                    name: 'build_og_transactions',
                    arguments: {},
                },
            ],
            signals: [
                {
                    kind: 'copyTradingState',
                    policy: {
                        ready: true,
                        ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
                        collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                    },
                    state,
                    balances: {
                        activeTokenBalance: '0',
                    },
                    pendingProposal: false,
                },
            ],
            config: {},
            agentAddress: TEST_ACCOUNT,
            onchainPendingProposal: false,
        });

        assert.equal(reimbursementValidated.length, 1);
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runFetchLatestBuyTradeTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-sell',
                        side: 'SELL',
                        outcome: 'YES',
                        price: 0.51,
                    },
                    {
                        id: 'trade-buy',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const outSignals = await enrichSignals([], {
            publicClient: {
                async readContract({ args }) {
                    if (args.length === 1) {
                        return 1_000_000n;
                    }
                    return 0n;
                },
            },
            config: {
                commitmentSafe: TEST_SAFE,
                polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
            },
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        const state = getCopyTradingState();
        assert.equal(state.activeSourceTradeId, 'trade-buy');
        assert.equal(state.activeTradeSide, 'BUY');

        const copySignal = outSignals.find((signal) => signal.kind === 'copyTradingState');
        assert.equal(copySignal.latestObservedTrade.id, 'trade-buy');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runTokenBalancesUseClobAddressTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        globalThis.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    {
                        id: 'trade-1',
                        side: 'BUY',
                        outcome: 'YES',
                        price: 0.5,
                    },
                ];
            },
        });

        const erc1155BalanceCallAddresses = [];
        await enrichSignals([], {
            publicClient: {
                async readContract({ args }) {
                    if (args.length === 1) {
                        return 1_000_000n;
                    }
                    erc1155BalanceCallAddresses.push(String(args[0]).toLowerCase());
                    return 1n;
                },
            },
            config: {
                commitmentSafe: TEST_SAFE,
                polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
                polymarketClobAddress: TEST_CLOB_PROXY,
            },
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        assert.equal(erc1155BalanceCallAddresses.length, 2);
        assert.equal(erc1155BalanceCallAddresses[0], TEST_CLOB_PROXY.toLowerCase());
        assert.equal(erc1155BalanceCallAddresses[1], TEST_CLOB_PROXY.toLowerCase());
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runTokenBalancesUseResolvedRelayerProxyTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        const builderSecret = Buffer.from('test-builder-secret').toString('base64');
        globalThis.fetch = async (url) => {
            const asText = String(url);
            if (asText.includes('data-api.polymarket.com/activity')) {
                return {
                    ok: true,
                    async json() {
                        return [
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ];
                    },
                    async text() {
                        return JSON.stringify([
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ]);
                    },
                };
            }
            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    async text() {
                        return JSON.stringify({
                            address: TEST_RELAYER_PROXY,
                        });
                    },
                };
            }
            throw new Error(`Unexpected fetch URL in relayer test: ${asText}`);
        };

        const erc1155BalanceCallAddresses = [];
        const outSignals = await enrichSignals([], {
            publicClient: {
                async getChainId() {
                    return 137;
                },
                async readContract({ args }) {
                    if (args.length === 1) {
                        return 1_000_000n;
                    }
                    erc1155BalanceCallAddresses.push(String(args[0]).toLowerCase());
                    return 1n;
                },
            },
            config: {
                commitmentSafe: TEST_SAFE,
                polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
                polymarketRelayerEnabled: true,
                polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
                polymarketRelayerTxType: 'SAFE',
                polymarketClobAddress: TEST_RELAYER_PROXY,
                polymarketBuilderApiKey: 'builder-key',
                polymarketBuilderSecret: builderSecret,
                polymarketBuilderPassphrase: 'builder-passphrase',
            },
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        assert.equal(erc1155BalanceCallAddresses.length, 2);
        assert.equal(erc1155BalanceCallAddresses[0], TEST_RELAYER_PROXY.toLowerCase());
        assert.equal(erc1155BalanceCallAddresses[1], TEST_RELAYER_PROXY.toLowerCase());
        const copySignal = outSignals.find((signal) => signal.kind === 'copyTradingState');
        assert.equal(copySignal.balances.tokenHolderAddress, TEST_RELAYER_PROXY.toLowerCase());
        assert.equal(copySignal.tokenHolderResolutionError, null);
        assert.equal(copySignal.walletAlignmentError, null);
        assert.equal(copySignal.state.reimbursementRecipientAddress, TEST_RELAYER_PROXY.toLowerCase());
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function runRelayerWalletMismatchIsBlockedTest() {
    resetCopyTradingState();
    const envKeys = [
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
    ];
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;

    process.env.COPY_TRADING_SOURCE_USER = TEST_SOURCE_USER;
    process.env.COPY_TRADING_MARKET = 'test-market';
    process.env.COPY_TRADING_YES_TOKEN_ID = YES_TOKEN_ID;
    process.env.COPY_TRADING_NO_TOKEN_ID = NO_TOKEN_ID;

    try {
        const builderSecret = Buffer.from('test-builder-secret').toString('base64');
        globalThis.fetch = async (url) => {
            const asText = String(url);
            if (asText.includes('data-api.polymarket.com/activity')) {
                return {
                    ok: true,
                    async json() {
                        return [
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ];
                    },
                    async text() {
                        return JSON.stringify([
                            {
                                id: 'trade-1',
                                side: 'BUY',
                                outcome: 'YES',
                                price: 0.5,
                            },
                        ]);
                    },
                };
            }
            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    async text() {
                        return JSON.stringify({
                            address: TEST_RELAYER_PROXY,
                        });
                    },
                };
            }
            throw new Error(`Unexpected fetch URL in relayer mismatch test: ${asText}`);
        };

        const outSignals = await enrichSignals([], {
            publicClient: {
                async getChainId() {
                    return 137;
                },
                async readContract({ args }) {
                    if (args.length === 1) {
                        return 1_000_000n;
                    }
                    return 1n;
                },
            },
            config: {
                commitmentSafe: TEST_SAFE,
                polymarketConditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
                polymarketRelayerEnabled: true,
                polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
                polymarketRelayerTxType: 'SAFE',
                polymarketRelayerFromAddress: TEST_RELAYER_PROXY,
                polymarketClobAddress: TEST_CLOB_PROXY,
                polymarketBuilderApiKey: 'builder-key',
                polymarketBuilderSecret: builderSecret,
                polymarketBuilderPassphrase: 'builder-passphrase',
            },
            account: { address: TEST_ACCOUNT },
            onchainPendingProposal: false,
        });

        const copySignal = outSignals.find((signal) => signal.kind === 'copyTradingState');
        assert.ok(copySignal.walletAlignmentError.includes('POLYMARKET_CLOB_ADDRESS'));
        assert.equal(copySignal.state.activeSourceTradeId, null);

        await assert.rejects(
            () =>
                validateToolCalls({
                    toolCalls: [
                        {
                            callId: 'order',
                            name: 'polymarket_clob_build_sign_and_place_order',
                            arguments: {},
                        },
                    ],
                    signals: [copySignal],
                    config: {},
                    agentAddress: TEST_ACCOUNT,
                    onchainPendingProposal: false,
                }),
            /must match relayer proxy wallet/
        );

        const disputeValidated = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'dispute',
                    name: 'dispute_assertion',
                    arguments: {},
                },
            ],
            signals: [copySignal],
            config: {},
            agentAddress: TEST_ACCOUNT,
            onchainPendingProposal: false,
        });
        assert.equal(disputeValidated.length, 1);
        assert.equal(disputeValidated[0].name, 'dispute_assertion');

        const mixedValidated = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'order',
                    name: 'polymarket_clob_build_sign_and_place_order',
                    arguments: {},
                },
                {
                    callId: 'dispute',
                    name: 'dispute_assertion',
                    arguments: {},
                },
            ],
            signals: [copySignal],
            config: {},
            agentAddress: TEST_ACCOUNT,
            onchainPendingProposal: false,
        });
        assert.equal(mixedValidated.length, 1);
        assert.equal(mixedValidated[0].name, 'dispute_assertion');
    } finally {
        for (const key of envKeys) {
            if (oldEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = oldEnv[key];
            }
        }
        globalThis.fetch = oldFetch;
        resetCopyTradingState();
    }
}

async function run() {
    runPromptTest();
    runMathTests();
    runLegacyProposalHashFallbackTest();
    await runValidateToolCallTests();
    await runProposalHashGatingTest();
    await runProposalHashRecoveryFromSignalTest();
    await runProposalHashRecoveryFromSignalUsesFundingWalletTest();
    await runRevertedSubmissionClearsPendingTest();
    await runOrderFillConfirmationGatesDepositTest();
    await runMissingOrderIdDoesNotAdvanceOrderStateTest();
    await runSubmissionWithoutHashesDoesNotWedgeTest();
    await runFetchLatestBuyTradeTest();
    await runTokenBalancesUseClobAddressTest();
    await runTokenBalancesUseResolvedRelayerProxyTest();
    await runRelayerWalletMismatchIsBlockedTest();
    console.log('[test] copy-trading agent OK');
}

run();
