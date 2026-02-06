function pickWinningBranch({ ethPrice, umaPrice, ethThreshold, umaThreshold }) {
    const ethTriggered = ethPrice >= ethThreshold;
    const umaTriggered = umaPrice <= umaThreshold;

    if (ethTriggered && umaTriggered) {
        return {
            winner: 'eth',
            reason: 'tie-break: ETH wins when both are true in same evaluation cycle',
        };
    }

    if (ethTriggered) {
        return {
            winner: 'eth',
            reason: `ETH/USDC ${ethPrice} >= ${ethThreshold}`,
        };
    }

    if (umaTriggered) {
        return {
            winner: 'uma',
            reason: `UMA/USDC ${umaPrice} <= ${umaThreshold}`,
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
            name: 'ETH wins',
            input: { ethPrice: 3250, umaPrice: 2.8, ethThreshold: 3200, umaThreshold: 2.1 },
        },
        {
            name: 'UMA wins',
            input: { ethPrice: 3000, umaPrice: 2.0, ethThreshold: 3200, umaThreshold: 2.1 },
        },
        {
            name: 'Tie -> ETH wins',
            input: { ethPrice: 3200, umaPrice: 2.1, ethThreshold: 3200, umaThreshold: 2.1 },
        },
        {
            name: 'No trigger',
            input: { ethPrice: 3100, umaPrice: 2.4, ethThreshold: 3200, umaThreshold: 2.1 },
        },
    ];

    for (const scenario of scenarios) {
        const result = pickWinningBranch(scenario.input);
        console.log(`[sim] ${scenario.name}:`, result);
    }
}

run();
