import assert from 'node:assert/strict';
import {
    calculateCopyAmounts,
    computeBuyOrderAmounts,
    getSystemPrompt,
    validateToolCalls,
} from './agent.js';

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
                    activeTokenId: '123',
                    reimbursementAmountWei: '990000',
                    orderSubmitted: false,
                    tokenDeposited: false,
                    reimbursementProposed: false,
                },
                activeTrade: {
                    side: 'BUY',
                    price: 0.55,
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
                    activeTokenId: '123',
                    reimbursementAmountWei: '990000',
                    orderSubmitted: true,
                    tokenDeposited: false,
                    reimbursementProposed: false,
                },
                activeTrade: {
                    side: 'BUY',
                    price: 0.55,
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
                    activeTokenId: '123',
                    reimbursementAmountWei: '990000',
                    orderSubmitted: true,
                    tokenDeposited: true,
                    reimbursementProposed: false,
                },
                activeTrade: {
                    side: 'BUY',
                    price: 0.55,
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

async function run() {
    runPromptTest();
    runMathTests();
    await runValidateToolCallTests();
    console.log('[test] copy-trading agent OK');
}

run();
