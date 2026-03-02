/**
 * Checks whether an eth_getCode result indicates deployed bytecode.
 */
function hasContractCode(code) {
    return typeof code === 'string' && code !== '0x';
}

/**
 * Finds the first block where a contract has code using binary search.
 * Returns null when no code exists at latestBlock.
 */
async function findContractDeploymentBlock({ publicClient, address, latestBlock }) {
    const latestCode = await publicClient.getCode({
        address,
        blockNumber: latestBlock,
    });
    if (!hasContractCode(latestCode)) {
        return null;
    }

    let left = 0n;
    let right = latestBlock;
    while (left < right) {
        const middle = (left + right) / 2n;
        const codeAtMiddle = await publicClient.getCode({
            address,
            blockNumber: middle,
        });
        if (hasContractCode(codeAtMiddle)) {
            right = middle;
        } else {
            left = middle + 1n;
        }
    }

    return left;
}

/**
 * Fetches logs in bounded block chunks to stay within provider range limits.
 */
async function getLogsChunked({
    publicClient,
    address,
    event,
    args,
    fromBlock,
    toBlock,
    chunkSize = 5_000n,
}) {
    if (fromBlock > toBlock) return [];

    const normalizedChunkSize = BigInt(chunkSize);
    if (normalizedChunkSize <= 0n) {
        throw new Error('chunkSize must be greater than 0.');
    }

    const logs = [];
    let currentFrom = fromBlock;
    while (currentFrom <= toBlock) {
        const currentTo = currentFrom + normalizedChunkSize - 1n > toBlock
            ? toBlock
            : currentFrom + normalizedChunkSize - 1n;

        const chunk = await publicClient.getLogs({
            address,
            event,
            args,
            fromBlock: currentFrom,
            toBlock: currentTo,
        });
        logs.push(...chunk);
        currentFrom = currentTo + 1n;
    }

    return logs;
}

/**
 * Returns block timestamp in milliseconds with a local cache to avoid repeated RPC calls.
 */
async function getBlockTimestampMs(publicClient, blockNumber, cache) {
    const key = blockNumber.toString();
    if (cache.has(key)) {
        return cache.get(key);
    }

    const block = await publicClient.getBlock({ blockNumber });
    const timestampMs = Number(block.timestamp) * 1000;
    cache.set(key, timestampMs);
    return timestampMs;
}

/**
 * Compares two chain records by block and log index.
 * Returns -1 if left is earlier, 1 if later, 0 if same position.
 */
function chainPositionCompare(left, right) {
    const leftBlock = BigInt(left?.blockNumber ?? 0n);
    const rightBlock = BigInt(right?.blockNumber ?? 0n);
    if (leftBlock !== rightBlock) {
        return leftBlock < rightBlock ? -1 : 1;
    }
    const leftLogIndex = BigInt(left?.logIndex ?? 0);
    const rightLogIndex = BigInt(right?.logIndex ?? 0);
    if (leftLogIndex === rightLogIndex) return 0;
    return leftLogIndex < rightLogIndex ? -1 : 1;
}

export {
    chainPositionCompare,
    findContractDeploymentBlock,
    getBlockTimestampMs,
    getLogsChunked,
    hasContractCode,
};
