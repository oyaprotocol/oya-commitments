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
    console.log('[test] buildOgTransactions uniswap action OK');
}

run();
