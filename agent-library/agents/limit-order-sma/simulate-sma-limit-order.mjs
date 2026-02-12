/**
 * Simulates when an SMA-based limit order would trigger.
 * lte: trigger when ethPrice <= sma (buy when price dips below average)
 * gte: trigger when ethPrice >= sma (sell when price rises above average)
 */
function wouldTrigger({ ethPrice, sma, comparator }) {
    if (comparator === 'lte') return ethPrice <= sma;
    if (comparator === 'gte') return ethPrice >= sma;
    throw new Error(`Unknown comparator: ${comparator}`);
}

function run() {
    const scenarios = [
        {
            name: 'lte: price below SMA -> trigger',
            input: { ethPrice: 1999, sma: 2000, comparator: 'lte' },
        },
        {
            name: 'lte: price at SMA -> trigger',
            input: { ethPrice: 2000, sma: 2000, comparator: 'lte' },
        },
        {
            name: 'lte: price above SMA -> no trigger',
            input: { ethPrice: 2001, sma: 2000, comparator: 'lte' },
        },
        {
            name: 'gte: price above SMA -> trigger',
            input: { ethPrice: 2500, sma: 2000, comparator: 'gte' },
        },
        {
            name: 'gte: price at SMA -> trigger',
            input: { ethPrice: 2000, sma: 2000, comparator: 'gte' },
        },
        {
            name: 'gte: price below SMA -> no trigger',
            input: { ethPrice: 1500, sma: 2000, comparator: 'gte' },
        },
    ];

    for (const scenario of scenarios) {
        const result = wouldTrigger(scenario.input);
        console.log(`[sim] ${scenario.name}:`, result);
    }
}

run();
