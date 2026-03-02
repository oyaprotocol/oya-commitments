import { parseAbi } from 'viem';

const chainlinkLatestRoundDataAbi = parseAbi([
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Reads and caches Chainlink price answer at a specific historical block.
 */
async function getChainlinkAnswerAtBlock({
    publicClient,
    feedAddress,
    blockNumber,
    cache,
    abi = chainlinkLatestRoundDataAbi,
}) {
    const key = BigInt(blockNumber).toString();
    if (cache.has(key)) {
        return cache.get(key);
    }

    const round = await publicClient.readContract({
        address: feedAddress,
        abi,
        functionName: 'latestRoundData',
        blockNumber: BigInt(blockNumber),
    });
    const answer = BigInt(round?.[1] ?? 0n);
    if (answer <= 0n) {
        throw new Error(`Chainlink answer at block ${key} is non-positive.`);
    }
    cache.set(key, answer);
    return answer;
}

export {
    chainlinkLatestRoundDataAbi,
    getChainlinkAnswerAtBlock,
};
