import assert from 'node:assert/strict';
import { validateToolCalls } from './agent.js';

const WETH = '0x7b79995e5f793a07bc00c21412e50ecae098e7f9';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const ROUTER = '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e';
const POOL = '0x6418eec70f50913ff0d756b48d32ce7c02b47c47';

async function run() {
    const toolCalls = [
        {
            name: 'build_og_transactions',
            callId: '1',
            parsedArguments: {
                actions: [
                    {
                        kind: 'uniswap_v3_exact_input_single',
                        router: ROUTER,
                        tokenIn: WETH,
                        tokenOut: USDC,
                        fee: 3000,
                        recipient: '0x1234000000000000000000000000000000000000',
                        amountInWei: '1',
                        amountOutMinWei: '0',
                    },
                ],
            },
        },
    ];

    const signals = [
        {
            kind: 'priceTrigger',
            pool: POOL,
            poolFee: 3000,
            baseToken: WETH,
            quoteToken: USDC,
        },
        {
            kind: 'erc20BalanceSnapshot',
            asset: WETH,
            amount: '30000',
        },
    ];

    const ok = await validateToolCalls({
        toolCalls,
        signals,
        commitmentText: 'x',
        commitmentSafe: '0x1234000000000000000000000000000000000000',
    });
    assert.equal(ok.length, 1);

    await assert.rejects(() =>
        validateToolCalls({
            toolCalls: [
                {
                    ...toolCalls[0],
                    parsedArguments: {
                        actions: [
                            {
                                ...toolCalls[0].parsedArguments.actions[0],
                                router: '0x0000000000000000000000000000000000000001',
                            },
                        ],
                    },
                },
            ],
            signals,
            commitmentText: 'y',
            commitmentSafe: '0x1234000000000000000000000000000000000000',
        })
    );

    console.log('[test] allowlist validation OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
