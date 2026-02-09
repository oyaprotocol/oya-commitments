import { parseAbi } from 'viem';

const chainlinkAbi = parseAbi([
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

async function getEthPriceUSD(publicClient, priceFeedAddress = '0x694AA1769357215DE4FAC081bf1f309aDC325306') {
    try {
        const result = await publicClient.readContract({
            address: priceFeedAddress,
            abi: chainlinkAbi,
            functionName: 'latestRoundData',
        });

        const answer = result[1];
        const price = Number(answer) / 1e8;
        console.log(`[price] ETH/USD from Chainlink: $${price.toFixed(2)}`);
        return price;
    } catch (error) {
        console.error('[price] Failed to fetch ETH price from Chainlink:', error);
        throw new Error('Unable to fetch ETH price from Chainlink oracle');
    }
}

async function getEthPriceUSDFallback() {
    try {
        const response = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
        );
        if (!response.ok) {
            throw new Error(`Coingecko API error: ${response.status}`);
        }
        const data = await response.json();
        const price = data.ethereum.usd;
        console.log(`[price] ETH/USD from Coingecko: $${price.toFixed(2)}`);
        return price;
    } catch (error) {
        console.error('[price] Failed to fetch ETH price from Coingecko:', error);
        throw error;
    }
}

export { getEthPriceUSD, getEthPriceUSDFallback };
