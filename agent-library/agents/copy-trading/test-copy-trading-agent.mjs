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
const TEST_PROPOSAL_HASH = `0x${'a'.repeat(64)}`;
const OTHER_PROPOSAL_HASH = `0x${'b'.repeat(64)}`;

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
                    reimbursementAmountWei: '990000',
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
                    reimbursementAmountWei: '990000',
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
                    reimbursementAmountWei: '990000',
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
    assert.equal(reimbursementValidated[0].parsedArguments.actions[0].amountWei, '990000');
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

        onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: { status: 'submitted', proposalHash: TEST_PROPOSAL_HASH },
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

async function run() {
    runPromptTest();
    runMathTests();
    await runValidateToolCallTests();
    await runProposalHashGatingTest();
    console.log('[test] copy-trading agent OK');
}

run();
