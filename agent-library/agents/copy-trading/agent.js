import {
    CLOB_FAILURE_TERMINAL_STATUS,
    CLOB_ORDER_FAILURE_STATUSES,
    CLOB_ORDER_FILLED_STATUSES,
    CLOB_SUCCESS_TERMINAL_STATUS,
    DATA_API_HOST,
    DEFAULT_COLLATERAL_TOKEN,
    getClobOrder,
    getClobTrades,
} from '../../../agent/src/lib/polymarket.js';
import { decodeFunctionData, erc20Abi, erc1155Abi } from 'viem';
import {
    normalizeAddressOrNull,
    normalizeHashOrNull,
} from '../../../agent/src/lib/utils.js';

const COPY_BPS = 9900n;
const FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;
const PRICE_SCALE = 1_000_000n;
const REIMBURSEMENT_SUBMISSION_TIMEOUT_MS = 60_000;

let copyTradingState = {
    seenSourceTradeId: null,
    activeSourceTradeId: null,
    activeTradeSide: null,
    activeTradePrice: null,
    activeOutcome: null,
    activeTokenId: null,
    copyTradeAmountWei: null,
    reimbursementAmountWei: null,
    copyOrderId: null,
    copyOrderStatus: null,
    copyOrderFilled: false,
    copyOrderSubmittedMs: null,
    orderSubmitted: false,
    tokenDeposited: false,
    reimbursementProposed: false,
    reimbursementProposalHash: null,
    reimbursementSubmissionPending: false,
    reimbursementSubmissionTxHash: null,
    reimbursementSubmissionMs: null,
};
const normalizeAddress = normalizeAddressOrNull;

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

const normalizeHash = normalizeHashOrNull;

function normalizeOrderId(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeClobStatus(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
}

function parseFiniteNumber(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

function hasClobCredentials(config) {
    return Boolean(
        config?.polymarketClobApiKey &&
            config?.polymarketClobApiSecret &&
            config?.polymarketClobApiPassphrase
    );
}

function getClobAuthAddress({ config, accountAddress }) {
    return (
        normalizeAddress(config?.polymarketClobAddress) ??
        normalizeAddress(accountAddress)
    );
}

function extractOrderSummary(payload) {
    const order =
        payload?.order && typeof payload.order === 'object'
            ? payload.order
            : payload && typeof payload === 'object'
              ? payload
              : null;
    if (!order) return null;

    return {
        id: normalizeOrderId(order.id ?? order.orderId ?? order.order_id),
        status: normalizeClobStatus(order.status),
        originalSize: parseFiniteNumber(order.original_size ?? order.originalSize),
        sizeMatched: parseFiniteNumber(order.size_matched ?? order.sizeMatched),
    };
}

function isOrderFullyMatched(order) {
    if (!order) return false;
    if (order.originalSize === null || order.sizeMatched === null) return false;
    if (order.originalSize <= 0) return false;
    return order.sizeMatched + 1e-12 >= order.originalSize;
}

function tradeIncludesOrderId(trade, orderId) {
    const normalizedOrderId = String(orderId).trim().toLowerCase();
    if (!normalizedOrderId) return false;

    const takerOrderId = normalizeOrderId(trade?.taker_order_id ?? trade?.takerOrderId);
    if (takerOrderId && takerOrderId.toLowerCase() === normalizedOrderId) {
        return true;
    }

    const makerOrders = Array.isArray(trade?.maker_orders)
        ? trade.maker_orders
        : Array.isArray(trade?.makerOrders)
          ? trade.makerOrders
          : [];
    for (const makerOrder of makerOrders) {
        const makerOrderId = normalizeOrderId(makerOrder?.order_id ?? makerOrder?.orderId);
        if (makerOrderId && makerOrderId.toLowerCase() === normalizedOrderId) {
            return true;
        }
    }

    return false;
}

function dedupeTrades(trades) {
    const seen = new Set();
    const unique = [];
    for (const trade of trades) {
        const id = normalizeOrderId(trade?.id);
        const key = id ?? JSON.stringify(trade);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(trade);
    }
    return unique;
}

function extractOrderIdFromSubmission(parsedOutput) {
    return normalizeOrderId(
        parsedOutput?.result?.order?.id ??
            parsedOutput?.result?.id ??
            parsedOutput?.result?.orderID ??
            parsedOutput?.result?.orderId ??
            parsedOutput?.order?.id ??
            parsedOutput?.id ??
            parsedOutput?.orderID ??
            parsedOutput?.orderId
    );
}

function extractOrderStatusFromSubmission(parsedOutput) {
    return normalizeClobStatus(
        parsedOutput?.result?.order?.status ??
            parsedOutput?.result?.status ??
            parsedOutput?.order?.status
    );
}

async function fetchRelatedClobTrades({
    config,
    signingAddress,
    orderId,
    market,
    clobAuthAddress,
    submittedMs,
}) {
    const afterSeconds = Math.max(0, Math.floor((Number(submittedMs ?? Date.now()) - 60_000) / 1000));
    const all = [];
    const makerTrades = await getClobTrades({
        config,
        signingAddress,
        maker: clobAuthAddress,
        market,
        after: afterSeconds,
    });
    if (Array.isArray(makerTrades)) {
        all.push(...makerTrades);
    }

    const takerTrades = await getClobTrades({
        config,
        signingAddress,
        taker: clobAuthAddress,
        market,
        after: afterSeconds,
    });
    if (Array.isArray(takerTrades)) {
        all.push(...takerTrades);
    }

    return dedupeTrades(all).filter((trade) => tradeIncludesOrderId(trade, orderId));
}

function decodeErc20TransferCallData(data) {
    if (typeof data !== 'string') return null;

    try {
        const decoded = decodeFunctionData({
            abi: erc20Abi,
            data,
        });
        if (decoded.functionName !== 'transfer') return null;
        const to = normalizeAddress(decoded.args?.[0]);
        if (!to) return null;
        const amount = BigInt(decoded.args?.[1] ?? 0n);
        if (amount < 0n) return null;
        return { to, amount };
    } catch (error) {
        return null;
    }
}

function findMatchingReimbursementProposalHash({
    signals,
    policy,
    agentAddress,
    reimbursementAmountWei,
}) {
    const normalizedCollateralToken = normalizeAddress(policy?.collateralToken);
    const normalizedAgentAddress = normalizeAddress(agentAddress);
    const normalizedAmount = BigInt(reimbursementAmountWei ?? 0);
    if (!normalizedCollateralToken || !normalizedAgentAddress || normalizedAmount <= 0n) {
        return null;
    }

    for (const signal of signals) {
        if (signal?.kind !== 'proposal') continue;
        const signalHash = normalizeHash(signal.proposalHash);
        if (!signalHash) continue;

        const proposer = normalizeAddress(signal.proposer);
        if (proposer && proposer !== normalizedAgentAddress) continue;

        const transactions = Array.isArray(signal.transactions) ? signal.transactions : [];
        for (const tx of transactions) {
            const txTo = normalizeAddress(tx?.to);
            if (!txTo || txTo !== normalizedCollateralToken) continue;
            const operation = Number(tx?.operation ?? 0);
            if (operation !== 0) continue;
            const value = BigInt(tx?.value ?? 0);
            if (value !== 0n) continue;
            const decoded = decodeErc20TransferCallData(tx?.data);
            if (!decoded) continue;
            if (decoded.to !== normalizedAgentAddress) continue;
            if (decoded.amount !== normalizedAmount) continue;
            return signalHash;
        }
    }

    return null;
}

function clearReimbursementSubmissionTracking() {
    copyTradingState.reimbursementSubmissionPending = false;
    copyTradingState.reimbursementSubmissionTxHash = null;
    copyTradingState.reimbursementSubmissionMs = null;
}

function resolveOgProposalHashFromToolOutput(parsedOutput) {
    const txHash = normalizeHash(parsedOutput?.transactionHash);
    const explicitOgHash = normalizeHash(parsedOutput?.ogProposalHash);
    if (explicitOgHash) return explicitOgHash;

    const legacyHash = normalizeHash(parsedOutput?.proposalHash);
    if (!legacyHash) return null;
    // In legacy output shape `proposalHash` is the tx hash, not OG proposal hash.
    if (txHash && legacyHash === txHash) return null;
    return legacyHash;
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
        if (parsed.side !== 'BUY') continue;
        return parsed;
    }

    return null;
}

function activateTradeCandidate({
    trade,
    tokenId,
    copyTradeAmountWei,
    reimbursementAmountWei,
}) {
    copyTradingState.activeSourceTradeId = trade.id;
    copyTradingState.activeTradeSide = trade.side;
    copyTradingState.activeTradePrice = trade.price;
    copyTradingState.activeOutcome = trade.outcome;
    copyTradingState.activeTokenId = tokenId;
    copyTradingState.copyTradeAmountWei = copyTradeAmountWei;
    copyTradingState.reimbursementAmountWei = reimbursementAmountWei;
    copyTradingState.copyOrderId = null;
    copyTradingState.copyOrderStatus = null;
    copyTradingState.copyOrderFilled = false;
    copyTradingState.copyOrderSubmittedMs = null;
    copyTradingState.orderSubmitted = false;
    copyTradingState.tokenDeposited = false;
    copyTradingState.reimbursementProposed = false;
    copyTradingState.reimbursementProposalHash = null;
    copyTradingState.reimbursementSubmissionPending = false;
    copyTradingState.reimbursementSubmissionTxHash = null;
    copyTradingState.reimbursementSubmissionMs = null;
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
    copyTradingState.copyTradeAmountWei = null;
    copyTradingState.reimbursementAmountWei = null;
    copyTradingState.copyOrderId = null;
    copyTradingState.copyOrderStatus = null;
    copyTradingState.copyOrderFilled = false;
    copyTradingState.copyOrderSubmittedMs = null;
    copyTradingState.orderSubmitted = false;
    copyTradingState.tokenDeposited = false;
    copyTradingState.reimbursementProposed = false;
    copyTradingState.reimbursementProposalHash = null;
    copyTradingState.reimbursementSubmissionPending = false;
    copyTradingState.reimbursementSubmissionTxHash = null;
    copyTradingState.reimbursementSubmissionMs = null;
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
        'Flow must stay simple: place CLOB order from your own wallet, wait for CLOB fill confirmation and YES/NO token receipt, deposit tokens to Safe, then propose reimbursement transfer to agentAddress.',
        'Never trade more than 99% of Safe collateral. Reimburse exactly the stored reimbursement amount (full Safe collateral at detection).',
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
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [config.commitmentSafe],
        }),
        publicClient.readContract({
            address: policy.ctfContract,
            abi: erc1155Abi,
            functionName: 'balanceOf',
            args: [account.address, BigInt(policy.yesTokenId)],
        }),
        publicClient.readContract({
            address: policy.ctfContract,
            abi: erc1155Abi,
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
            copyTradeAmountWei: amounts.copyAmountWei,
            reimbursementAmountWei: amounts.safeBalanceWei,
        });
    }

    let orderFillCheckError;
    if (
        copyTradingState.activeSourceTradeId &&
        copyTradingState.orderSubmitted &&
        !copyTradingState.tokenDeposited &&
        !copyTradingState.copyOrderFilled &&
        copyTradingState.copyOrderId
    ) {
        const clobAuthAddress = getClobAuthAddress({
            config,
            accountAddress: account.address,
        });
        if (hasClobCredentials(config) && clobAuthAddress) {
            try {
                const signingAddress = clobAuthAddress;
                const orderPayload = await getClobOrder({
                    config,
                    signingAddress,
                    orderId: copyTradingState.copyOrderId,
                });
                const orderSummary = extractOrderSummary(orderPayload);
                if (orderSummary?.status) {
                    copyTradingState.copyOrderStatus = orderSummary.status;
                }

                const relatedTrades = await fetchRelatedClobTrades({
                    config,
                    signingAddress,
                    orderId: copyTradingState.copyOrderId,
                    market: policy.market,
                    clobAuthAddress,
                    submittedMs: copyTradingState.copyOrderSubmittedMs,
                });
                const relatedStatuses = relatedTrades
                    .map((trade) => normalizeClobStatus(trade?.status))
                    .filter(Boolean);
                const anyFailedTrade = relatedStatuses.some(
                    (status) => status === CLOB_FAILURE_TERMINAL_STATUS
                );
                const allConfirmedTrades =
                    relatedStatuses.length > 0 &&
                    relatedStatuses.every((status) => status === CLOB_SUCCESS_TERMINAL_STATUS);
                const orderFilled =
                    isOrderFullyMatched(orderSummary) ||
                    CLOB_ORDER_FILLED_STATUSES.has(orderSummary?.status ?? '');
                const orderFailed = CLOB_ORDER_FAILURE_STATUSES.has(orderSummary?.status ?? '');

                if (orderFailed || anyFailedTrade) {
                    copyTradingState.orderSubmitted = false;
                    copyTradingState.copyOrderFilled = false;
                    copyTradingState.copyOrderId = null;
                    copyTradingState.copyOrderSubmittedMs = null;
                } else if (allConfirmedTrades && orderFilled) {
                    copyTradingState.copyOrderFilled = true;
                }
            } catch (error) {
                orderFillCheckError = error?.message ?? String(error);
            }
        }
    }

    if (
        copyTradingState.reimbursementSubmissionPending &&
        !copyTradingState.reimbursementProposalHash
    ) {
        const recoveredHash = findMatchingReimbursementProposalHash({
            signals: outSignals,
            policy,
            agentAddress: account.address,
            reimbursementAmountWei: copyTradingState.reimbursementAmountWei,
        });
        if (recoveredHash) {
            copyTradingState.reimbursementProposalHash = recoveredHash;
            copyTradingState.reimbursementProposed = true;
            clearReimbursementSubmissionTracking();
        } else {
            const submissionTxHash = normalizeHash(copyTradingState.reimbursementSubmissionTxHash);
            const submissionMs = Number(copyTradingState.reimbursementSubmissionMs ?? 0);
            const submissionExpired =
                Number.isFinite(submissionMs) &&
                submissionMs > 0 &&
                Date.now() - submissionMs > REIMBURSEMENT_SUBMISSION_TIMEOUT_MS;

            if (submissionTxHash) {
                try {
                    const receipt = await publicClient.getTransactionReceipt({
                        hash: submissionTxHash,
                    });
                    const status = receipt?.status;
                    const reverted = status === 0n || status === 0 || status === 'reverted';
                    if (reverted || (submissionExpired && !onchainPendingProposal)) {
                        clearReimbursementSubmissionTracking();
                    }
                } catch (error) {
                    if (submissionExpired && !onchainPendingProposal) {
                        clearReimbursementSubmissionTracking();
                    }
                }
            } else if (submissionExpired && !onchainPendingProposal) {
                clearReimbursementSubmissionTracking();
            }
        }
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
        pendingProposal: Boolean(
            onchainPendingProposal ||
                copyTradingState.reimbursementProposed ||
                copyTradingState.reimbursementSubmissionPending
        ),
        tradeFetchError,
        orderFillCheckError,
    });

    return outSignals;
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
            const copyTradeAmountWei = BigInt(state.copyTradeAmountWei ?? 0);
            if (copyTradeAmountWei <= 0n) {
                throw new Error('Copy-trade amount is zero; refusing copy-trade order.');
            }

            const { makerAmount, takerAmount } = computeBuyOrderAmounts({
                collateralAmountWei: copyTradeAmountWei,
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
            if (state.copyOrderId && !state.copyOrderFilled) {
                throw new Error('Copy order has not been filled yet; wait before depositing tokens.');
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
            if (state.reimbursementProposed || state.reimbursementSubmissionPending) {
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
        copyTradingState.copyOrderId = extractOrderIdFromSubmission(parsedOutput);
        copyTradingState.copyOrderStatus = extractOrderStatusFromSubmission(parsedOutput);
        copyTradingState.copyOrderFilled = false;
        copyTradingState.copyOrderSubmittedMs = Date.now();
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
        const proposalHash = resolveOgProposalHashFromToolOutput(parsedOutput);
        const txHash = normalizeHash(parsedOutput.transactionHash);
        if (proposalHash) {
            copyTradingState.reimbursementProposed = true;
            copyTradingState.reimbursementProposalHash = proposalHash;
            copyTradingState.reimbursementSubmissionPending = false;
            copyTradingState.reimbursementSubmissionTxHash = txHash;
            copyTradingState.reimbursementSubmissionMs = null;
        } else if (txHash) {
            copyTradingState.reimbursementProposed = false;
            copyTradingState.reimbursementProposalHash = null;
            copyTradingState.reimbursementSubmissionPending = true;
            copyTradingState.reimbursementSubmissionTxHash = txHash;
            copyTradingState.reimbursementSubmissionMs = Date.now();
        } else {
            copyTradingState.reimbursementProposed = false;
            copyTradingState.reimbursementProposalHash = null;
            clearReimbursementSubmissionTracking();
        }
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
        clearReimbursementSubmissionTracking();
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
        clearReimbursementSubmissionTracking();
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
        copyTradeAmountWei: null,
        reimbursementAmountWei: null,
        copyOrderId: null,
        copyOrderStatus: null,
        copyOrderFilled: false,
        copyOrderSubmittedMs: null,
        orderSubmitted: false,
        tokenDeposited: false,
        reimbursementProposed: false,
        reimbursementProposalHash: null,
        reimbursementSubmissionPending: false,
        reimbursementSubmissionTxHash: null,
        reimbursementSubmissionMs: null,
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
