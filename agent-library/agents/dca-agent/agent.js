// DCA Agent - WETH reimbursement loop on Sepolia

import { erc20Abi, parseAbi } from 'viem';

let lastDcaTimestamp = Date.now();
const DCA_INTERVAL_SECONDS = 200;
const MAX_CYCLES = 2;
const CHAINLINK_ETH_USD_FEED_SEPOLIA = '0x694AA1769357215DE4FAC081bf1f309aDC325306';
const chainlinkAbi = parseAbi([
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
const DCA_POLICY = Object.freeze({
    wethAddress: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    usdcDecimals: 6n,
    minSafeUsdcWei: 100000n, // 0.10 USDC (6 decimals)
    maxCycles: MAX_CYCLES,
    proposalConfirmTimeoutMs: 60000,
});
let dcaState = {
    depositConfirmed: false,
    proposalBuilt: false,
    proposalPosted: false,
    cyclesCompleted: 0,
    proposalSubmitHash: null,
    proposalSubmitMs: null,
};

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose and dispute.'
        : proposeEnabled
          ? 'You may propose but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute but you may not propose.'
            : 'You may not propose or dispute; provide opinions only.';

    return [
        'You are a DCA (Dollar Cost Averaging) service agent.',
        `Every ${DCA_INTERVAL_SECONDS} seconds, you deliver $0.10 worth of WETH to the Safe and get reimbursed in USDC.`,
        'Stop after 2 cycles (MAX_CYCLES = 2). If signals.dcaState.cyclesCompleted >= 2, output action=ignore and do nothing.',
        `Flow: 1) Read balances from signals (Safe USDC and Self WETH), 2) If time >= ${DCA_INTERVAL_SECONDS}s and balances ok, send WETH, 3) Propose USDC reimbursement to OG.`,
        `Check timeSinceLastDca in signals. If >= ${DCA_INTERVAL_SECONDS} seconds and balances from signals are sufficient, proceed.`,
        'Current ETH/WETH price is provided in signals as ethPriceUSD (from Chainlink oracle).',
        'Calculate: wethToSend = 0.10 / ethPriceUSD, then convert to wei (18 decimals).',
        'Example: if ETH is $2242.51, then 0.10 / 2242.51 = 0.0000446... WETH = 44600000000000 wei.',
        'First, read Safe USDC and Self WETH balances from signals.balances (note: 100000 micro-USDC = 0.10 USDC).',
        'Second, read signals.dcaState to see which steps already completed: depositConfirmed, proposalBuilt, proposalPosted, cyclesCompleted.',
        'If signals.pendingProposal is true, output action=ignore and do not call post_bond_and_propose until it becomes false.',
        `Third, if timeSinceLastDca >= ${DCA_INTERVAL_SECONDS} seconds and balances are sufficient and depositConfirmed=false, perform a single chained action in ONE response: (a) make_deposit with asset=WETH_ADDRESS and amountWei=calculated amount (waits for confirmation), then (b) build_og_transactions for one erc20_transfer of 100000 micro-USDC to agentAddress, then (c) post_bond_and_propose with those transactions.`,
        'Fourth, if depositConfirmed=true and proposalBuilt=false, call build_og_transactions and post_bond_and_propose in the same response.',
        'Fifth, if proposalBuilt=true and proposalPosted=false, call post_bond_and_propose.',
        'Do NOT repeat make_deposit when depositConfirmed=true; use dcaState to avoid duplicate deposits.',
        'If any precondition fails (balances insufficient, time not met, or Safe lacks USDC), output action=ignore.',
        'Use signals.balances.safeUsdcSufficient (boolean) or compare safeUsdcWei against minSafeUsdcWei to decide if Safe has enough USDC.',
        'All non-tool responses must be valid json.',
        mode,
        commitmentText ? `\nCommitment:\n${commitmentText}` : '',
        'Always verify Safe has at least 100000 micro-USDC (0.10 USDC) before proposing reimbursement.',
        'The agentAddress is provided in the input signals.',
        'Use Sepolia USDC token address 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 for reimbursement transfers (do NOT use mainnet USDC).',
        'WETH address on Sepolia: 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
    ]
        .filter(Boolean)
        .join(' ');
}

function augmentSignals(signals) {
    const now = Date.now();
    const timeSinceLastDca = Math.floor((now - lastDcaTimestamp) / 1000);

    return [
        ...signals,
        {
            kind: 'timer',
            timeSinceLastDca,
            shouldExecuteDca: timeSinceLastDca >= DCA_INTERVAL_SECONDS,
            lastDcaTimestamp,
            currentTimestamp: now,
        },
    ];
}

function markDcaExecuted() {
    lastDcaTimestamp = Date.now();
}

async function getEthPriceUSD(publicClient, chainlinkFeedAddress) {
    const result = await publicClient.readContract({
        address: chainlinkFeedAddress,
        abi: chainlinkAbi,
        functionName: 'latestRoundData',
    });
    const answer = result[1];
    if (answer <= 0n) {
        throw new Error('Invalid Chainlink ETH/USD price');
    }
    return Number(answer) / 1e8;
}

async function getEthPriceUSDFallback() {
    const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    if (!response.ok) {
        throw new Error(`Coingecko API error: ${response.status}`);
    }
    const data = await response.json();
    if (!data?.ethereum?.usd) {
        throw new Error('Invalid Coingecko response');
    }
    return data.ethereum.usd;
}

async function enrichSignals(signals, { publicClient, config, account, onchainPendingProposal }) {
    if (!signals.some((signal) => signal.kind === 'timer')) {
        return signals;
    }

    let ethPriceUSD;
    try {
        const chainlinkFeedAddress =
            config?.chainlinkPriceFeed ?? CHAINLINK_ETH_USD_FEED_SEPOLIA;
        ethPriceUSD = await getEthPriceUSD(publicClient, chainlinkFeedAddress);
    } catch (error) {
        ethPriceUSD = await getEthPriceUSDFallback();
    }

    const [safeUsdcWei, selfWethWei] = await Promise.all([
        publicClient.readContract({
            address: DCA_POLICY.usdcAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [config.commitmentSafe],
        }),
        publicClient.readContract({
            address: DCA_POLICY.wethAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        }),
    ]);

    const safeUsdcSufficient = safeUsdcWei >= DCA_POLICY.minSafeUsdcWei;
    const safeUsdcHuman = Number(safeUsdcWei) / 10 ** Number(DCA_POLICY.usdcDecimals);
    const selfWethHuman = Number(selfWethWei) / 1e18;
    const pendingProposal = getPendingProposal(onchainPendingProposal);
    const currentDcaState = getDcaState();

    return signals.map((signal) => {
        if (signal.kind !== 'timer') return signal;
        return {
            ...signal,
            ethPriceUSD,
            balances: {
                safeUsdcWei: safeUsdcWei.toString(),
                selfWethWei: selfWethWei.toString(),
                safeUsdcHuman,
                selfWethHuman,
                safeUsdcSufficient,
                minSafeUsdcWei: DCA_POLICY.minSafeUsdcWei.toString(),
                minSafeUsdcHuman:
                    Number(DCA_POLICY.minSafeUsdcWei) / 10 ** Number(DCA_POLICY.usdcDecimals),
            },
            dcaState: currentDcaState,
            pendingProposal,
        };
    });
}

function getDcaPolicy() {
    return DCA_POLICY;
}

function getDcaState() {
    return { ...dcaState };
}

function getPendingProposal(onchainPending) {
    return Boolean(onchainPending || dcaState.proposalPosted);
}

function onToolOutput({ name, parsedOutput }) {
    if (!name || !parsedOutput || parsedOutput.status === 'error') return;

    if (name === 'make_deposit' && parsedOutput.status === 'confirmed') {
        dcaState.depositConfirmed = true;
        dcaState.proposalBuilt = false;
        dcaState.proposalPosted = false;
        return;
    }

    if (name === 'build_og_transactions' && parsedOutput.status === 'ok') {
        dcaState.proposalBuilt = true;
        return;
    }

    if (name === 'post_bond_and_propose' && parsedOutput.status === 'submitted') {
        dcaState.proposalPosted = true;
        dcaState.depositConfirmed = false;
        dcaState.proposalBuilt = false;
        dcaState.proposalSubmitHash = parsedOutput.proposalHash ?? null;
        dcaState.proposalSubmitMs = Date.now();
    }
}

function onProposalEvents({ executedProposalCount = 0, deletedProposalCount = 0 }) {
    if (executedProposalCount > 0) {
        dcaState.proposalPosted = false;
        dcaState.proposalBuilt = false;
        dcaState.depositConfirmed = false;
        dcaState.proposalSubmitHash = null;
        dcaState.proposalSubmitMs = null;
        dcaState.cyclesCompleted = Math.min(
            DCA_POLICY.maxCycles,
            dcaState.cyclesCompleted + executedProposalCount
        );
        markDcaExecuted();
    }

    if (deletedProposalCount > 0) {
        dcaState.proposalPosted = false;
        dcaState.proposalBuilt = false;
        dcaState.depositConfirmed = false;
        dcaState.proposalSubmitHash = null;
        dcaState.proposalSubmitMs = null;
    }
}

async function reconcileProposalSubmission({ publicClient }) {
    if (!dcaState.proposalPosted || !dcaState.proposalSubmitHash || !dcaState.proposalSubmitMs) {
        return;
    }

    try {
        const receipt = await publicClient.getTransactionReceipt({
            hash: dcaState.proposalSubmitHash,
        });
        if (receipt?.status === 0n || receipt?.status === 'reverted') {
            dcaState.proposalPosted = false;
            dcaState.proposalBuilt = false;
            dcaState.proposalSubmitHash = null;
            dcaState.proposalSubmitMs = null;
        }
    } catch (error) {
        if (Date.now() - dcaState.proposalSubmitMs > DCA_POLICY.proposalConfirmTimeoutMs) {
            dcaState.proposalPosted = false;
            dcaState.proposalBuilt = false;
            dcaState.proposalSubmitHash = null;
            dcaState.proposalSubmitMs = null;
        }
    }
}

export {
    getSystemPrompt,
    augmentSignals,
    markDcaExecuted,
    getDcaPolicy,
    getDcaState,
    getPendingProposal,
    onToolOutput,
    onProposalEvents,
    reconcileProposalSubmission,
    enrichSignals,
};
