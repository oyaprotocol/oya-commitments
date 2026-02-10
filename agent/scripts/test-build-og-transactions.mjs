import assert from 'node:assert/strict';
import { decodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { buildOgTransactions } from '../src/lib/tx.js';

function run() {
    const router = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const usdc = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const weth = '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2';
    const recipient = '0x1111111111111111111111111111111111111111';

    const txs = buildOgTransactions([
        {
            kind: 'uniswap_v3_exact_input_single',
            token: null,
            to: null,
            amountWei: null,
            valueWei: null,
            abi: null,
            args: null,
            operation: 0,
            router,
            tokenIn: usdc,
            tokenOut: weth,
            fee: 3000,
            recipient,
            amountInWei: '1000000',
            amountOutMinWei: '1',
            sqrtPriceLimitX96: null,
        },
    ]);

    assert.equal(txs.length, 2);
    assert.equal(txs[0].to.toLowerCase(), usdc.toLowerCase());
    assert.equal(txs[1].to.toLowerCase(), router.toLowerCase());
    const approveCall = decodeFunctionData({
        abi: erc20Abi,
        data: txs[0].data,
    });
    assert.equal(approveCall.functionName, 'approve');

    const swapCall = decodeFunctionData({
        abi: parseAbi([
            'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
        ]),
        data: txs[1].data,
    });
    assert.equal(swapCall.functionName, 'exactInputSingle');

    const ctf = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const conditionId = `0x${'11'.repeat(32)}`;
    const ctfTxs = buildOgTransactions(
        [
            {
                kind: 'ctf_split',
                ctfContract: null,
                collateralToken: usdc,
                conditionId,
                parentCollectionId: null,
                partition: [1, 2],
                amount: '250000',
                operation: 0,
            },
        ],
        {
            config: {
                polymarketConditionalTokens: ctf,
            },
        }
    );
    assert.equal(ctfTxs.length, 3);
    assert.equal(ctfTxs[0].to.toLowerCase(), usdc.toLowerCase());
    assert.equal(ctfTxs[1].to.toLowerCase(), usdc.toLowerCase());
    assert.equal(ctfTxs[2].to.toLowerCase(), ctf.toLowerCase());

    const resetApproveCall = decodeFunctionData({
        abi: erc20Abi,
        data: ctfTxs[0].data,
    });
    assert.equal(resetApproveCall.functionName, 'approve');
    assert.equal(resetApproveCall.args[0].toLowerCase(), ctf.toLowerCase());
    assert.equal(resetApproveCall.args[1], 0n);

    const amountApproveCall = decodeFunctionData({
        abi: erc20Abi,
        data: ctfTxs[1].data,
    });
    assert.equal(amountApproveCall.functionName, 'approve');
    assert.equal(amountApproveCall.args[0].toLowerCase(), ctf.toLowerCase());
    assert.equal(amountApproveCall.args[1], 250000n);

    const splitCall = decodeFunctionData({
        abi: parseAbi([
            'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
        ]),
        data: ctfTxs[2].data,
    });
    assert.equal(splitCall.functionName, 'splitPosition');
    assert.equal(splitCall.args[0].toLowerCase(), usdc.toLowerCase());
    assert.equal(splitCall.args[2], conditionId);
    assert.deepEqual(splitCall.args[3], [1n, 2n]);
    assert.equal(splitCall.args[4], 250000n);

    console.log('[test] buildOgTransactions uniswap + ctf_split actions OK');
}

run();
