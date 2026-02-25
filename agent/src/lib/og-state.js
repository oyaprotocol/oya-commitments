import { zeroAddress } from 'viem';
import {
    normalizeAddressOrNull,
    normalizeAddressOrThrow,
    normalizeHashOrNull,
} from './utils.js';
import {
    optimisticGovernorAbi,
    optimisticOracleAbi,
    normalizeAssertion,
} from './og.js';

/**
 * Normalizes a TransactionsProposed log into the minimal fields needed by validation logic.
 */
function parseProposalRecord(log) {
    const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
    if (!proposalHash) return null;
    const assertionId = normalizeHashOrNull(log?.args?.assertionId);
    const proposal = log?.args?.proposal;
    const transactions = Array.isArray(proposal?.transactions) ? proposal.transactions : [];
    return {
        proposalHash,
        assertionId,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex ?? 0,
        transactions,
    };
}

/**
 * Resolves and caches the Optimistic Oracle V3 address used by an OG module.
 */
async function getOptimisticOracleAddress({
    publicClient,
    ogModule,
    cache,
}) {
    if (cache.value) return cache.value;
    const optimisticOracle = normalizeAddressOrThrow(
        await publicClient.readContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'optimisticOracleV3',
        }),
        { requireHex: false }
    );
    cache.value = optimisticOracle;
    return optimisticOracle;
}

/**
 * Determines whether an assertion can still be disputed:
 * not settled, no disputer yet, and still within the dispute window.
 */
async function isAssertionDisputable({
    publicClient,
    ogModule,
    assertionId,
    nowSeconds,
    optimisticOracleCache,
    assertionCache,
}) {
    if (!assertionId) return false;
    if (assertionCache.has(assertionId)) {
        return assertionCache.get(assertionId);
    }

    try {
        const optimisticOracle = await getOptimisticOracleAddress({
            publicClient,
            ogModule,
            cache: optimisticOracleCache,
        });
        const assertionRaw = await publicClient.readContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'getAssertion',
            args: [assertionId],
        });
        const assertion = normalizeAssertion(assertionRaw);
        const settled = Boolean(assertion?.settled);
        const disputer =
            normalizeAddressOrNull(assertion?.disputer, { requireHex: false }) ?? zeroAddress;
        const expirationTime = BigInt(assertion?.expirationTime ?? 0n);
        const disputable = !settled && disputer === zeroAddress && expirationTime > nowSeconds;
        assertionCache.set(assertionId, disputable);
        return disputable;
    } catch {
        assertionCache.set(assertionId, false);
        return false;
    }
}

export {
    getOptimisticOracleAddress,
    isAssertionDisputable,
    parseProposalRecord,
};
