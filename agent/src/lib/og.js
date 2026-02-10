import { erc20Abi, getAddress, parseAbi, parseAbiItem, stringToHex } from 'viem';

const optimisticGovernorAbi = parseAbi([
    'function proposeTransactions((address to,uint8 operation,uint256 value,bytes data)[] transactions, bytes explanation)',
    'function executeProposal((address to,uint8 operation,uint256 value,bytes data)[] transactions)',
    'function collateral() view returns (address)',
    'function bondAmount() view returns (uint256)',
    'function optimisticOracleV3() view returns (address)',
    'function rules() view returns (string)',
    'function identifier() view returns (bytes32)',
    'function liveness() view returns (uint64)',
    'function assertionIds(bytes32) view returns (bytes32)',
]);

const optimisticOracleAbi = parseAbi([
    'function disputeAssertion(bytes32 assertionId, address disputer)',
    'function getMinimumBond(address collateral) view returns (uint256)',
    'function getAssertion(bytes32 assertionId) view returns ((bool arbitrateViaEscalationManager,bool discardOracle,bool validateDisputers,address assertingCaller,address escalationManager) escalationManagerSettings,address asserter,uint64 assertionTime,bool settled,address currency,uint64 expirationTime,bool settlementResolution,bytes32 domainId,bytes32 identifier,uint256 bond,address callbackRecipient,address disputer)',
]);

const transferEvent = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const transactionsProposedEvent = parseAbiItem(
    'event TransactionsProposed(address indexed proposer,uint256 indexed proposalTime,bytes32 indexed assertionId,((address to,uint8 operation,uint256 value,bytes data)[] transactions,uint256 requestTime) proposal,bytes32 proposalHash,bytes explanation,string rules,uint256 challengeWindowEnds)'
);
const proposalExecutedEvent = parseAbiItem(
    'event ProposalExecuted(bytes32 indexed proposalHash, bytes32 indexed assertionId)'
);
const proposalDeletedEvent = parseAbiItem(
    'event ProposalDeleted(bytes32 indexed proposalHash, bytes32 indexed assertionId)'
);

async function loadOptimisticGovernorDefaults({ publicClient, ogModule, trackedAssets }) {
    const collateral = await publicClient.readContract({
        address: ogModule,
        abi: optimisticGovernorAbi,
        functionName: 'collateral',
    });

    trackedAssets.add(getAddress(collateral).toLowerCase());
}

async function loadOgContext({ publicClient, ogModule }) {
    const [collateral, bondAmount, optimisticOracle, rules, identifier, liveness] =
        await Promise.all([
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'collateral',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'bondAmount',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'optimisticOracleV3',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'rules',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'identifier',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'liveness',
            }),
        ]);

    return {
        collateral,
        bondAmount,
        optimisticOracle,
        rules,
        identifier,
        liveness,
    };
}

async function logOgFundingStatus({ publicClient, ogModule, account }) {
    try {
        const chainId = await publicClient.getChainId();
        const expectedIdentifierStr =
            chainId === 11155111 ? 'ASSERT_TRUTH2' : 'ASSERT_TRUTH2';
        const expectedIdentifier = stringToHex(expectedIdentifierStr, { size: 32 });

        const [collateral, bondAmount, optimisticOracle, identifier] = await Promise.all([
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'collateral',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'bondAmount',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'optimisticOracleV3',
            }),
            publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'identifier',
            }),
        ]);
        const minimumBond = await publicClient.readContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'getMinimumBond',
            args: [collateral],
        });

        const requiredBond = bondAmount > minimumBond ? bondAmount : minimumBond;
        const collateralBalance = await publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        const nativeBalance = await publicClient.getBalance({ address: account.address });

        if (identifier !== expectedIdentifier) {
            console.warn(
                `[agent] OG identifier mismatch: expected ${expectedIdentifierStr}, onchain ${identifier}`
            );
        }
        void requiredBond;
        void collateralBalance;
        void nativeBalance;
    } catch (error) {
        console.warn('[agent] Failed to log OG funding status:', error);
    }
}

function normalizeAssertion(assertion) {
    if (!assertion) return {};
    if (typeof assertion === 'object' && !Array.isArray(assertion)) {
        return assertion;
    }

    const tuple = Array.isArray(assertion) ? assertion : [];
    return {
        escalationManagerSettings: tuple[0],
        asserter: tuple[1],
        assertionTime: tuple[2],
        settled: tuple[3],
        currency: tuple[4],
        expirationTime: tuple[5],
        settlementResolution: tuple[6],
        domainId: tuple[7],
        identifier: tuple[8],
        bond: tuple[9],
        callbackRecipient: tuple[10],
        disputer: tuple[11],
    };
}

export {
    optimisticGovernorAbi,
    optimisticOracleAbi,
    transferEvent,
    transactionsProposedEvent,
    proposalExecutedEvent,
    proposalDeletedEvent,
    loadOptimisticGovernorDefaults,
    loadOgContext,
    logOgFundingStatus,
    normalizeAssertion,
};
