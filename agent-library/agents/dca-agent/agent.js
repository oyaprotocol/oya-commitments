// DCA Agent - WETH reimbursement loop on Sepolia

let lastDcaTimestamp = Date.now();
const DCA_INTERVAL_SECONDS = 200;
const MAX_CYCLES = 2;

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

export { getSystemPrompt, augmentSignals, markDcaExecuted };
