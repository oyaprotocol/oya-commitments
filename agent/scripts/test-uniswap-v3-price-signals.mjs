import assert from 'node:assert/strict';
import { collectPriceTriggerSignals } from '../src/lib/uniswapV3Price.js';

const WETH = '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const UMA = '0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828';
const POOL_ETH_USDC = '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8';
const POOL_UMA_USDC = '0x88D97d199b9ED37C29D846d00D443De980832a22';

function sqrtPriceX96ForQuotePerBase({ quotePerBase, baseDecimals, quoteDecimals }) {
    const raw = quotePerBase * 10 ** (quoteDecimals - baseDecimals);
    const sqrtPrice = Math.sqrt(raw);
    return BigInt(Math.floor(sqrtPrice * 2 ** 96));
}

function buildMockPublicClient() {
    const slot0ByPool = new Map([
        [
            POOL_ETH_USDC.toLowerCase(),
            [sqrtPriceX96ForQuotePerBase({ quotePerBase: 3200, baseDecimals: 18, quoteDecimals: 6 })],
        ],
        [
            POOL_UMA_USDC.toLowerCase(),
            [sqrtPriceX96ForQuotePerBase({ quotePerBase: 2.0, baseDecimals: 18, quoteDecimals: 6 })],
        ],
    ]);

    return {
        async readContract({ address, functionName }) {
            const addr = address.toLowerCase();
            if (functionName === 'token0') {
                if (addr === POOL_ETH_USDC.toLowerCase()) return WETH;
                if (addr === POOL_UMA_USDC.toLowerCase()) return UMA;
            }
            if (functionName === 'token1') {
                if (addr === POOL_ETH_USDC.toLowerCase()) return USDC;
                if (addr === POOL_UMA_USDC.toLowerCase()) return USDC;
            }
            if (functionName === 'slot0') {
                return slot0ByPool.get(addr);
            }
            if (functionName === 'fee') {
                return 3000;
            }
            if (functionName === 'decimals') {
                if (addr === WETH.toLowerCase() || addr === UMA.toLowerCase()) return 18;
                if (addr === USDC.toLowerCase()) return 6;
            }
            throw new Error(`Unexpected mock readContract call: ${functionName} ${address}`);
        },
    };
}

async function run() {
    const publicClient = buildMockPublicClient();
    const config = {
        uniswapV3FeeTiers: [500, 3000, 10000],
    };
    const triggerState = new Map();
    const tokenMetaCache = new Map();
    const poolMetaCache = new Map();
    const resolvedPoolCache = new Map();

    const signals = await collectPriceTriggerSignals({
        publicClient,
        config,
        triggers: [
            {
                id: 'eth-breakout',
                label: 'ETH >= 3200',
                pool: POOL_ETH_USDC,
                baseToken: WETH,
                quoteToken: USDC,
                comparator: 'gte',
                threshold: 3200,
                priority: 0,
                emitOnce: true,
            },
            {
                id: 'uma-drop',
                label: 'UMA <= 2.1',
                pool: POOL_UMA_USDC,
                baseToken: UMA,
                quoteToken: USDC,
                comparator: 'lte',
                threshold: 2.1,
                priority: 1,
                emitOnce: true,
            },
        ],
        nowMs: Date.now(),
        triggerState,
        tokenMetaCache,
        poolMetaCache,
        resolvedPoolCache,
    });

    assert.equal(signals.length, 2);
    assert.equal(signals[0].triggerId, 'eth-breakout');
    assert.equal(signals[1].triggerId, 'uma-drop');

    const secondPass = await collectPriceTriggerSignals({
        publicClient,
        config,
        triggers: [
            {
                id: 'eth-breakout',
                pool: POOL_ETH_USDC,
                baseToken: WETH,
                quoteToken: USDC,
                comparator: 'gte',
                threshold: 3200,
                priority: 0,
                emitOnce: true,
            },
        ],
        nowMs: Date.now(),
        triggerState,
        tokenMetaCache,
        poolMetaCache,
        resolvedPoolCache,
    });

    assert.equal(secondPass.length, 0);
    console.log('[test] price trigger signal collection OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
