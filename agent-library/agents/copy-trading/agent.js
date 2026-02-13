const erc20BalanceOfAbi = [
    {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
];
const erc1155BalanceOfAbi = [
    {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'id', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
    },
];

const DATA_API_HOST = 'https://data-api.polymarket.com';
const COPY_BPS = 9900n;
const FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;
const PRICE_SCALE = 1_000_000n;
const DEFAULT_COLLATERAL_TOKEN = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

let copyTradingState = {
    seenSourceTradeId: null,
    activeSourceTradeId: null,
    activeTradeSide: null,
    activeTradePrice: null,
    activeOutcome: null,
    activeTokenId: null,
    reimbursementAmountWei: null,
    orderSubmitted: false,
    tokenDeposited: false,
    reimbursementProposed: false,
    reimbursementProposalHash: null,
};

function normalizeAddress(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

function normalizeTokenId(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
        const normalized = BigInt(value);
        if (normalized < 0n) return null;
        return normalized.toString();
    } catch (error) {
        return null;
    }
}

function normalizeOutcome(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'yes') return 'YES';
    if (normalized === 'no') return 'NO';
    return null;
}

function normalizeTradeSide(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return normalized === 'BUY' || normalized === 'SELL' ? normalized : null;
}

function normalizeTradePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
        return null;
    }
    return parsed;
}

function normalizeHash(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

function parseActivityEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const tradeId =
        entry.id ??
        entry.tradeId ??
        entry.transactionHash ??
        entry.txHash ??
        entry.orderID ??
        entry.orderId;
    const side = normalizeTradeSide(entry.side);
    const outcome = normalizeOutcome(entry.outcome);
    const price = normalizeTradePrice(entry.price);

    if (!tradeId || !side || !outcome || !price) return null;

    return {
        id: String(tradeId),
        side,
        outcome,
        price,
        market: entry.conditionId ? String(entry.conditionId) : undefined,
        timestamp: entry.timestamp ? String(entry.timestamp) : undefined,
        txHash: entry.transactionHash ? String(entry.transactionHash) : undefined,
    };
}

function getPolicy(config) {
    const sourceUserRaw = process.env.COPY_TRADING_SOURCE_USER;
    const market = process.env.COPY_TRADING_MARKET?.trim() || null;
    const yesTokenId = normalizeTokenId(process.env.COPY_TRADING_YES_TOKEN_ID);
    const noTokenId = normalizeTokenId(process.env.COPY_TRADING_NO_TOKEN_ID);
    const collateralToken =
        normalizeAddress(process.env.COPY_TRADING_COLLATERAL_TOKEN) ??
        normalizeAddress(DEFAULT_COLLATERAL_TOKEN);
    const ctfContract =
        normalizeAddress(process.env.COPY_TRADING_CTF_CONTRACT) ??
        normalizeAddress(config?.polymarketConditionalTokens);

    const errors = [];
    const sourceUser = normalizeAddress(sourceUserRaw);
    if (!sourceUser) errors.push('COPY_TRADING_SOURCE_USER missing or invalid address.');
    if (!market) errors.push('COPY_TRADING_MARKET is required.');
    if (!yesTokenId) errors.push('COPY_TRADING_YES_TOKEN_ID is required.');
    if (!noTokenId) errors.push('COPY_TRADING_NO_TOKEN_ID is required.');
    if (!collateralToken) {
        errors.push('COPY_TRADING_COLLATERAL_TOKEN invalid and no default available.');
    }
    if (!ctfContract) {
        errors.push(
            'COPY_TRADING_CTF_CONTRACT invalid and POLYMARKET_CONDITIONAL_TOKENS unavailable.'
        );
    }

    return {
        sourceUser,
        market,
        yesTokenId,
        noTokenId,
        collateralToken,
        ctfContract,
        ready: errors.length === 0,
        errors,
    };
}

function calculateCopyAmounts(safeBalanceWei) {
    const normalized = BigInt(safeBalanceWei ?? 0);
    if (normalized <= 0n) {
        return {
            safeBalanceWei: '0',
            copyAmountWei: '0',
            feeAmountWei: '0',
        };
    }

    const copyAmountWei = (normalized * COPY_BPS) / BPS_DENOMINATOR;
    const feeAmountWei = normalized - copyAmountWei;

    return {
        safeBalanceWei: normalized.toString(),
        copyAmountWei: copyAmountWei.toString(),
        feeAmountWei: feeAmountWei.toString(),
    };
}

function computeBuyOrderAmounts({ collateralAmountWei, price }) {
    const normalizedCollateralAmountWei = BigInt(collateralAmountWei);
    if (normalizedCollateralAmountWei <= 0n) {
        throw new Error('collateralAmountWei must be > 0 for buy-order sizing.');
    }

    const normalizedPrice = normalizeTradePrice(price);
    if (!normalizedPrice) {
        throw new Error('price must be a number between 0 and 1 for buy-order sizing.');
    }

    const priceScaled = BigInt(Math.round(normalizedPrice * Number(PRICE_SCALE)));
    if (priceScaled <= 0n) {
        throw new Error('price is too small for buy-order sizing.');
    }

    const makerAmount = (normalizedCollateralAmountWei * PRICE_SCALE) / priceScaled;
    if (makerAmount <= 0n) {
        throw new Error('makerAmount computed to zero; refusing order.');
    }

    return {
        makerAmount: makerAmount.toString(),
        takerAmount: normalizedCollateralAmountWei.toString(),
        priceScaled: priceScaled.toString(),
    };
}

async function fetchLatestSourceTrade({ policy }) {
    const params = new URLSearchParams({
        user: policy.sourceUser,
        limit: '10',
        offset: '0',
    });
    params.set('type', 'TRADE');
    params.set('market', policy.market);

    const response = await fetch(`${DATA_API_HOST}/activity?${params.toString()}`, {
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(`Data API request failed (${response.status}).`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        return null;
    }

    for (const item of data) {
        const parsed = parseActivityEntry(item);
        if (!parsed) continue;
        if (parsed.outcome !== 'YES' && parsed.outcome !== 'NO') continue;
        return parsed;
    }

    return null;
}

function activateTradeCandidate({ trade, tokenId, reimbursementAmountWei }) {
    copyTradingState.activeSourceTradeId = trade.id;
    copyTradingState.activeTradeSide = trade.side;
    copyTradingState.activeTradePrice = trade.price;
    copyTradingState.activeOutcome = trade.outcome;
    copyTradingState.activeTokenId = tokenId;
    copyTradingState.reimbursementAmountWei = reimbursementAmountWei;
    copyTradingState.orderSubmitted = false;
    copyTradingState.tokenDeposited = false;
    copyTradingState.reimbursementProposed = false;
    copyTradingState.reimbursementProposalHash = null;
}

function clearActiveTrade({ markSeen = false } = {}) {
    if (markSeen && copyTradingState.activeSourceTradeId) {
        copyTradingState.seenSourceTradeId = copyTradingState.activeSourceTradeId;
    }

    copyTradingState.activeSourceTradeId = null;
    copyTradingState.activeTradeSide = null;
    copyTradingState.activeTradePrice = null;
    copyTradingState.activeOutcome = null;
    copyTradingState.activeTokenId = null;
    copyTradingState.reimbursementAmountWei = null;
    copyTradingState.orderSubmitted = false;
    copyTradingState.tokenDeposited = false;
    copyTradingState.reimbursementProposed = false;
    copyTradingState.reimbursementProposalHash = null;
}

function getPollingOptions() {
    return {
        emitBalanceSnapshotsEveryPoll: true,
    };
}

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose and dispute.'
        : proposeEnabled
          ? 'You may propose but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute but you may not propose.'
            : 'You may not propose or dispute; provide opinions only.';

    return [
        'You are a copy-trading commitment agent.',
        'Copy only BUY trades from the configured source user and configured market.',
        'Trade size must be exactly 99% of Safe collateral at detection time. Keep 1% in the Safe as fee.',
        'Flow must stay simple: place CLOB order from your own wallet, wait for YES/NO tokens, deposit tokens to Safe, then propose reimbursement transfer to agentAddress.',
        'Never trade more than 99% of Safe collateral and never reimburse more than the stored copy amount.',
        'Use polymarket_clob_build_sign_and_place_order for order placement, make_erc1155_deposit for YES/NO deposit, and build_og_transactions for reimbursement transfer.',
        'If preconditions are not met, return ignore.',
        'Default to disputing proposals that violate these rules; prefer no-op when unsure.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
        'If no action is needed, output strict JSON with keys: action (propose|deposit|dispute|ignore|other) and rationale (string).',
    ]
        .filter(Boolean)
        .join(' ');
}

async function enrichSignals(signals, { publicClient, config, account, onchainPendingProposal }) {
    const policy = getPolicy(config);
    const stateSnapshot = { ...copyTradingState };

    const outSignals = [...signals];
    if (!policy.ready) {
        outSignals.push({
            kind: 'copyTradingState',
            policy,
            state: stateSnapshot,
            error: 'copy-trading policy config incomplete',
        });
        return outSignals;
    }

    let latestTrade = null;
    let tradeFetchError;
    try {
        latestTrade = await fetchLatestSourceTrade({ policy });
    } catch (error) {
        tradeFetchError = error?.message ?? String(error);
    }

    const [safeCollateralWei, yesBalance, noBalance] = await Promise.all([
        publicClient.readContract({
            address: policy.collateralToken,
            abi: erc20BalanceOfAbi,
            functionName: 'balanceOf',
            args: [config.commitmentSafe],
        }),
        publicClient.readContract({
            address: policy.ctfContract,
            abi: erc1155BalanceOfAbi,
            functionName: 'balanceOf',
            args: [account.address, BigInt(policy.yesTokenId)],
        }),
        publicClient.readContract({
            address: policy.ctfContract,
            abi: erc1155BalanceOfAbi,
            functionName: 'balanceOf',
            args: [account.address, BigInt(policy.noTokenId)],
        }),
    ]);

    const amounts = calculateCopyAmounts(safeCollateralWei);
    if (
        latestTrade &&
        latestTrade.side === 'BUY' &&
        latestTrade.id !== copyTradingState.seenSourceTradeId &&
        !copyTradingState.activeSourceTradeId &&
        BigInt(amounts.copyAmountWei) > 0n
    ) {
        const targetTokenId = latestTrade.outcome === 'YES' ? policy.yesTokenId : policy.noTokenId;
        activateTradeCandidate({
            trade: latestTrade,
            tokenId: targetTokenId,
            reimbursementAmountWei: amounts.copyAmountWei,
        });
    }

    const activeTokenBalance =
        copyTradingState.activeTokenId === policy.yesTokenId
            ? yesBalance
            : copyTradingState.activeTokenId === policy.noTokenId
              ? noBalance
              : 0n;

    outSignals.push({
        kind: 'copyTradingState',
        policy,
        state: { ...copyTradingState },
        latestObservedTrade: latestTrade,
        balances: {
            safeCollateralWei: safeCollateralWei.toString(),
            yesBalance: yesBalance.toString(),
            noBalance: noBalance.toString(),
            activeTokenBalance: activeTokenBalance.toString(),
        },
        metrics: {
            ...amounts,
            copyBps: COPY_BPS.toString(),
            feeBps: FEE_BPS.toString(),
        },
        pendingProposal: Boolean(onchainPendingProposal || copyTradingState.reimbursementProposed),
        tradeFetchError,
    });

    return outSignals;
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch (error) {
            return null;
        }
    }
    return null;
}

function findCopySignal(signals) {
    return signals.find((signal) => signal?.kind === 'copyTradingState');
}

async function validateToolCalls({
    toolCalls,
    signals,
    config,
    agentAddress,
    onchainPendingProposal,
}) {
    const copySignal = findCopySignal(signals ?? []);
    if (!copySignal || !copySignal.policy?.ready) {
        return [];
    }

    const validated = [];
    const policy = copySignal.policy;
    const state = copySignal.state ?? {};
    const activeTokenBalance = BigInt(copySignal.balances?.activeTokenBalance ?? 0);
    const pendingProposal = Boolean(onchainPendingProposal || copySignal.pendingProposal);

    for (const call of toolCalls) {
        if (call.name === 'dispute_assertion') {
            validated.push(call);
            continue;
        }

        if (call.name === 'post_bond_and_propose') {
            continue;
        }

        if (call.name === 'polymarket_clob_build_sign_and_place_order') {
            if (!state.activeSourceTradeId) {
                throw new Error('No active source trade to copy.');
            }
            if (state.orderSubmitted) {
                throw new Error('Copy order already submitted for active trade.');
            }
            if (state.activeTradeSide !== 'BUY') {
                throw new Error('Only BUY source trades are eligible for copy trading.');
            }
            if (state.activeTradePrice === null || state.activeTradePrice === undefined) {
                throw new Error('Missing triggering trade price snapshot for active trade.');
            }
            if (!state.activeTokenId) {
                throw new Error('No active YES/NO token id configured for copy trade.');
            }
            const reimbursementAmountWei = BigInt(state.reimbursementAmountWei ?? 0);
            if (reimbursementAmountWei <= 0n) {
                throw new Error('Reimbursement amount is zero; refusing copy-trade order.');
            }

            const { makerAmount, takerAmount } = computeBuyOrderAmounts({
                collateralAmountWei: reimbursementAmountWei,
                price: state.activeTradePrice,
            });

            validated.push({
                ...call,
                parsedArguments: {
                    side: 'BUY',
                    tokenId: String(state.activeTokenId),
                    orderType: 'FOK',
                    makerAmount,
                    takerAmount,
                },
            });
            continue;
        }

        if (call.name === 'make_erc1155_deposit') {
            if (!state.orderSubmitted) {
                throw new Error('Cannot deposit YES/NO tokens before copy order submission.');
            }
            if (state.tokenDeposited) {
                throw new Error('YES/NO tokens already deposited for active trade.');
            }
            if (!state.activeTokenId) {
                throw new Error('No active YES/NO token id for deposit.');
            }
            if (activeTokenBalance <= 0n) {
                throw new Error('No YES/NO token balance available to deposit yet.');
            }

            validated.push({
                ...call,
                parsedArguments: {
                    token: policy.ctfContract,
                    tokenId: String(state.activeTokenId),
                    amount: activeTokenBalance.toString(),
                    data: '0x',
                },
            });
            continue;
        }

        if (call.name === 'build_og_transactions') {
            if (!state.tokenDeposited) {
                throw new Error('Cannot build reimbursement proposal before token deposit confirmation.');
            }
            if (state.reimbursementProposed) {
                throw new Error('Reimbursement proposal already submitted for active trade.');
            }
            if (pendingProposal) {
                throw new Error('Pending proposal exists; wait before proposing reimbursement.');
            }
            const reimbursementAmountWei = BigInt(state.reimbursementAmountWei ?? 0);
            if (reimbursementAmountWei <= 0n) {
                throw new Error('Reimbursement amount is zero; refusing proposal build.');
            }

            validated.push({
                ...call,
                parsedArguments: {
                    actions: [
                        {
                            kind: 'erc20_transfer',
                            token: policy.collateralToken,
                            to: agentAddress,
                            amountWei: reimbursementAmountWei.toString(),
                        },
                    ],
                },
            });
            continue;
        }

        // Ignore all other tool calls for this specialized module.
    }

    return validated;
}

function onToolOutput({ name, parsedOutput }) {
    if (!name || !parsedOutput || parsedOutput.status === 'error') {
        return;
    }

    if (name === 'polymarket_clob_build_sign_and_place_order' && parsedOutput.status === 'submitted') {
        copyTradingState.orderSubmitted = true;
        return;
    }

    if (name === 'make_erc1155_deposit' && parsedOutput.status === 'confirmed') {
        copyTradingState.tokenDeposited = true;
        return;
    }

    if (
        (name === 'post_bond_and_propose' || name === 'auto_post_bond_and_propose') &&
        parsedOutput.status === 'submitted'
    ) {
        copyTradingState.reimbursementProposed = true;
        copyTradingState.reimbursementProposalHash =
            normalizeHash(parsedOutput.proposalHash) ?? copyTradingState.reimbursementProposalHash;
    }
}

function onProposalEvents({
    executedProposals = [],
    deletedProposals = [],
    executedProposalCount = 0,
    deletedProposalCount = 0,
}) {
    const trackedHash = normalizeHash(copyTradingState.reimbursementProposalHash);
    const executedHashes = Array.isArray(executedProposals)
        ? executedProposals.map((hash) => normalizeHash(hash)).filter(Boolean)
        : [];
    const deletedHashes = Array.isArray(deletedProposals)
        ? deletedProposals.map((hash) => normalizeHash(hash)).filter(Boolean)
        : [];

    if (trackedHash && executedHashes.includes(trackedHash)) {
        clearActiveTrade({ markSeen: true });
    }

    if (trackedHash && deletedHashes.includes(trackedHash)) {
        copyTradingState.reimbursementProposed = false;
        copyTradingState.reimbursementProposalHash = null;
    }

    // Backward-compatible fallback for environments that only pass counts and no hashes.
    if (
        !trackedHash &&
        copyTradingState.reimbursementProposed &&
        executedProposalCount > 0 &&
        (!Array.isArray(executedProposals) || executedProposals.length === 0)
    ) {
        clearActiveTrade({ markSeen: true });
    }
    if (
        !trackedHash &&
        copyTradingState.reimbursementProposed &&
        deletedProposalCount > 0 &&
        (!Array.isArray(deletedProposals) || deletedProposals.length === 0)
    ) {
        copyTradingState.reimbursementProposed = false;
    }
}

function getCopyTradingState() {
    return { ...copyTradingState };
}

function resetCopyTradingState() {
    copyTradingState = {
        seenSourceTradeId: null,
        activeSourceTradeId: null,
        activeTradeSide: null,
        activeTradePrice: null,
        activeOutcome: null,
        activeTokenId: null,
        reimbursementAmountWei: null,
        orderSubmitted: false,
        tokenDeposited: false,
        reimbursementProposed: false,
        reimbursementProposalHash: null,
    };
}

export {
    calculateCopyAmounts,
    computeBuyOrderAmounts,
    enrichSignals,
    getCopyTradingState,
    getPollingOptions,
    getSystemPrompt,
    onProposalEvents,
    onToolOutput,
    resetCopyTradingState,
    validateToolCalls,
};
