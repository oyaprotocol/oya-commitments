/**
 * Simulates when a limit order would trigger based on ethPrice vs limit.
 * lte: trigger when ethPrice <= limitPrice (buy when cheap)
 * gte: trigger when ethPrice >= limitPrice (sell when expensive)
 */
function wouldTrigger({ ethPrice, limitPrice, comparator }) {
    if (comparator === 'lte') return ethPrice <= limitPrice;
    if (comparator === 'gte') return ethPrice >= limitPrice;
    throw new Error(`Unknown comparator: ${comparator}`);
}

function run() {
    const scenarios = [
        {
            name: 'lte: price below limit -> trigger',
            input: { ethPrice: 1999, limitPrice: 2000, comparator: 'lte' },
        },
        {
            name: 'lte: price at limit -> trigger',
            input: { ethPrice: 2000, limitPrice: 2000, comparator: 'lte' },
        },
        {
            name: 'lte: price above limit -> no trigger',
            input: { ethPrice: 2001, limitPrice: 2000, comparator: 'lte' },
        },
        {
            name: 'gte: price above limit -> trigger',
            input: { ethPrice: 2500, limitPrice: 2000, comparator: 'gte' },
        },
        {
            name: 'gte: price at limit -> trigger',
            input: { ethPrice: 2000, limitPrice: 2000, comparator: 'gte' },
        },
        {
            name: 'gte: price below limit -> no trigger',
            input: { ethPrice: 1500, limitPrice: 2000, comparator: 'gte' },
        },
    ];

    for (const scenario of scenarios) {
        const result = wouldTrigger(scenario.input);
        console.log(`[sim] ${scenario.name}:`, result);
    }
}

run();
