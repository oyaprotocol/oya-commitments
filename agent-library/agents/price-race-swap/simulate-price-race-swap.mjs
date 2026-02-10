function pickWinningBranch({ ethPrice, uniWethPrice, ethThreshold, uniWethThreshold }) {
    const ethTriggered = ethPrice >= ethThreshold;
    const uniTriggered = uniWethPrice <= uniWethThreshold;

    if (ethTriggered && uniTriggered) {
        return {
            winner: 'weth-to-usdc',
            reason: 'tie-break: WETH/USDC branch wins when both are true in same evaluation cycle',
        };
    }

    if (ethTriggered) {
        return {
            winner: 'weth-to-usdc',
            reason: `WETH/USDC ${ethPrice} >= ${ethThreshold}`,
        };
    }

    if (uniTriggered) {
        return {
            winner: 'weth-to-uni',
            reason: `UNI/WETH ${uniWethPrice} <= ${uniWethThreshold}`,
        };
    }

    return {
        winner: 'none',
        reason: 'no trigger hit',
    };
}

function run() {
    const scenarios = [
        {
            name: 'WETH->USDC wins',
            input: { ethPrice: 1850, uniWethPrice: 0.05, ethThreshold: 1800, uniWethThreshold: 0.03 },
        },
        {
            name: 'WETH->UNI wins',
            input: { ethPrice: 1700, uniWethPrice: 0.02, ethThreshold: 1800, uniWethThreshold: 0.03 },
        },
        {
            name: 'Tie -> WETH->USDC wins',
            input: { ethPrice: 1800, uniWethPrice: 0.03, ethThreshold: 1800, uniWethThreshold: 0.03 },
        },
        {
            name: 'No trigger',
            input: { ethPrice: 1700, uniWethPrice: 0.04, ethThreshold: 1800, uniWethThreshold: 0.03 },
        },
    ];

    for (const scenario of scenarios) {
        const result = pickWinningBranch(scenario.input);
        console.log(`[sim] ${scenario.name}:`, result);
    }
}

run();
