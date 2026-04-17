import { parseUnits } from 'viem';
import {
    CLOB_ORDER_FAILURE_STATUSES,
    CLOB_ORDER_FILLED_STATUSES,
    CLOB_SUCCESS_TERMINAL_STATUS,
    DATA_API_HOST,
    getClobOrder,
    getClobTrades,
} from '../../../agent/src/lib/polymarket.js';
import { normalizeAddressOrNull, normalizeHashOrNull, parseFiniteNumber } from '../../../agent/src/lib/utils.js';
import {
    ensureMarketState,
    ingestObservedTrade,
    isDirectTradingReady,
} from './trade-ledger.js';

const PRICE_SCALE = 1_000_000n;
const USDC_DECIMALS = 6;
const SHARE_DECIMALS = 6;

function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const normalized = String(value).trim();
    return normalized ? normalized : null;
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

function parseTradeTimestampMs(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value >= 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
    }
    const asText = String(value).trim();
    if (!asText) {
        return null;
    }
    if (/^\d+$/.test(asText)) {
        const numeric = Number(asText);
        if (!Number.isFinite(numeric)) {
            return null;
        }
        return numeric >= 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    }
    const parsed = Date.parse(asText);
    return Number.isFinite(parsed) ? parsed : null;
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
    const executedAtMs = parseTradeTimestampMs(
        entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.created_at
    );

    if (!tradeId || !side || !outcome || !price) return null;

    return {
        id: String(tradeId),
        side,
        outcome,
        price,
        executedAtMs,
        description:
            normalizeOptionalString(entry.title) ??
            normalizeOptionalString(entry.description) ??
            null,
    };
}

function getClobAuthAddress({ config, policy, agentAddress }) {
    return (
        normalizeAddressOrNull(config?.polymarketClobAddress) ??
        normalizeAddressOrNull(policy?.tradingWallet) ??
        normalizeAddressOrNull(agentAddress)
    );
}

function ensureClobAuthAddressFallback({ config, policy, agentAddress }) {
    const effectiveClobAuthAddress = getClobAuthAddress({
        config,
        policy,
        agentAddress,
    });
    if (
        effectiveClobAuthAddress &&
        config &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        !normalizeAddressOrNull(config.polymarketClobAddress)
    ) {
        config.polymarketClobAddress = effectiveClobAuthAddress;
    }
    return effectiveClobAuthAddress;
}

function getDirectTradingPreflightError(config) {
    if (!config?.polymarketClobEnabled) {
        return 'polymarketClobEnabled=true is required before direct Polymarket execution.';
    }
    if (
        !config?.polymarketClobApiKey ||
        !config?.polymarketClobApiSecret ||
        !config?.polymarketClobApiPassphrase
    ) {
        return 'Missing CLOB credentials. Set POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_API_SECRET, and POLYMARKET_CLOB_API_PASSPHRASE.';
    }
    return null;
}

function computeCeilDiv(left, right) {
    return (left + right - 1n) / right;
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

    const takerAmount = computeCeilDiv(
        normalizedCollateralAmountWei * PRICE_SCALE,
        priceScaled
    );
    if (takerAmount <= 0n) {
        throw new Error('takerAmount computed to zero; refusing order.');
    }

    return {
        makerAmount: normalizedCollateralAmountWei.toString(),
        takerAmount: takerAmount.toString(),
    };
}

async function fetchLatestSourceTrade({ marketConfig }) {
    const params = new URLSearchParams({
        user: marketConfig.sourceUser,
        limit: '10',
        offset: '0',
    });
    params.set('type', 'TRADE');
    params.set('market', marketConfig.sourceMarket ?? marketConfig.marketId);

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
        if (parsed.side !== 'BUY') continue;
        return parsed;
    }

    return null;
}

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
        makerAmountFilled: parseOptionalNonNegativeIntegerString(
            order.maker_amount_filled ??
                order.makerAmountFilled ??
                order.making_amount_filled ??
                order.makingAmountFilled
        ),
        takerAmountFilled: parseOptionalNonNegativeIntegerString(
            order.taker_amount_filled ??
                order.takerAmountFilled ??
                order.taking_amount_filled ??
                order.takingAmountFilled
        ),
        feeAmount: parseOptionalNonNegativeIntegerString(
            order.fee ?? order.fee_amount ?? order.feeAmount
        ),
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

function normalizeDecimalText(value) {
    const normalized = String(value ?? '')
        .replace(/,/g, '')
        .trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
        return null;
    }
    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionRaw.replace(/0+$/, '');
    return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function parseOptionalShareAmountString(value) {
    const normalized = normalizeDecimalText(value);
    if (!normalized) {
        return null;
    }

    try {
        const parsed = parseUnits(normalized, SHARE_DECIMALS);
        if (parsed < 0n) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function parseOptionalNonNegativeIntegerString(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    try {
        const normalized = BigInt(String(value));
        if (normalized < 0n) {
            return null;
        }
        return normalized.toString();
    } catch {
        return null;
    }
}

function resolveConfirmedTradeSpendWei(trade) {
    const price = normalizeDecimalText(trade?.price ?? trade?.match_price ?? trade?.matchPrice);
    const shareAmount = parseOptionalShareAmountString(
        trade?.size ??
            trade?.matched_size ??
            trade?.matchedSize ??
            trade?.size_matched ??
            trade?.sizeMatched
    );
    if (!price || !shareAmount) {
        return null;
    }

    try {
        const priceScaled = parseUnits(price, USDC_DECIMALS);
        const product = priceScaled * BigInt(shareAmount);
        if (product % PRICE_SCALE !== 0n) {
            return null;
        }
        return (product / PRICE_SCALE).toString();
    } catch {
        return null;
    }
}

function sumConfirmedTradeSpendWei({ relatedTrades }) {
    let total = 0n;
    let sawConfirmedTrade = false;

    for (const trade of Array.isArray(relatedTrades) ? relatedTrades : []) {
        if (normalizeClobStatus(trade?.status) !== CLOB_SUCCESS_TERMINAL_STATUS) {
            continue;
        }

        const spendWei = resolveConfirmedTradeSpendWei(trade);
        if (!spendWei) {
            return null;
        }

        total += BigInt(spendWei);
        sawConfirmedTrade = true;
    }

    return sawConfirmedTrade ? total.toString() : null;
}

function subtractFilledShareFee(grossShareAmount, feeShareAmount) {
    const normalizedGrossShareAmount = parseOptionalNonNegativeIntegerString(grossShareAmount);
    if (!normalizedGrossShareAmount || BigInt(normalizedGrossShareAmount) <= 0n) {
        return null;
    }

    const normalizedFeeShareAmount = parseOptionalShareAmountString(feeShareAmount);
    if (!normalizedFeeShareAmount || BigInt(normalizedFeeShareAmount) <= 0n) {
        return normalizedGrossShareAmount;
    }
    if (BigInt(normalizedFeeShareAmount) > BigInt(normalizedGrossShareAmount)) {
        return null;
    }

    return (BigInt(normalizedGrossShareAmount) - BigInt(normalizedFeeShareAmount)).toString();
}

function subtractFilledShareFeeBaseUnits(grossShareAmount, feeShareAmountBaseUnits) {
    const normalizedGrossShareAmount = parseOptionalNonNegativeIntegerString(grossShareAmount);
    if (!normalizedGrossShareAmount || BigInt(normalizedGrossShareAmount) <= 0n) {
        return null;
    }

    const normalizedFeeShareAmount = parseOptionalNonNegativeIntegerString(
        feeShareAmountBaseUnits
    );
    if (!normalizedFeeShareAmount || BigInt(normalizedFeeShareAmount) <= 0n) {
        return normalizedGrossShareAmount;
    }
    if (BigInt(normalizedFeeShareAmount) > BigInt(normalizedGrossShareAmount)) {
        return null;
    }

    return (BigInt(normalizedGrossShareAmount) - BigInt(normalizedFeeShareAmount)).toString();
}

function resolveConfirmedTradeShareAmount(trade) {
    const grossShareAmount = parseOptionalShareAmountString(
        trade?.size ??
            trade?.matched_size ??
            trade?.matchedSize ??
            trade?.size_matched ??
            trade?.sizeMatched
    );
    if (!grossShareAmount) {
        return null;
    }

    const feeShareAmount = trade?.fee ?? trade?.fee_amount ?? trade?.feeAmount ?? trade?.fee_paid ?? trade?.feePaid;
    return subtractFilledShareFee(grossShareAmount, feeShareAmount);
}

function sumConfirmedTradeShareAmount({ relatedTrades }) {
    let total = 0n;
    let sawConfirmedTrade = false;

    for (const trade of Array.isArray(relatedTrades) ? relatedTrades : []) {
        if (normalizeClobStatus(trade?.status) !== CLOB_SUCCESS_TERMINAL_STATUS) {
            continue;
        }

        const shareAmount = resolveConfirmedTradeShareAmount(trade);
        if (!shareAmount) {
            return null;
        }

        total += BigInt(shareAmount);
        sawConfirmedTrade = true;
    }

    return sawConfirmedTrade ? total.toString() : null;
}

function resolveFilledBuySpendWei({ orderSummary, relatedTrades }) {
    const orderSummarySpend = parseOptionalNonNegativeIntegerString(
        orderSummary?.makerAmountFilled
    );
    if (orderSummarySpend) {
        return orderSummarySpend;
    }

    return sumConfirmedTradeSpendWei({ relatedTrades });
}

function resolveFilledBuyShareAmount({ orderSummary, relatedTrades }) {
    const netTakerAmountFilled = subtractFilledShareFeeBaseUnits(
        orderSummary?.takerAmountFilled,
        orderSummary?.feeAmount
    );
    if (netTakerAmountFilled && BigInt(netTakerAmountFilled) > 0n) {
        return netTakerAmountFilled;
    }

    const confirmedTradeShares = sumConfirmedTradeShareAmount({ relatedTrades });
    if (confirmedTradeShares && BigInt(confirmedTradeShares) > 0n) {
        return confirmedTradeShares;
    }

    const sizeMatchedShares = parseOptionalShareAmountString(orderSummary?.sizeMatched);
    if (sizeMatchedShares && BigInt(sizeMatchedShares) > 0n) {
        return sizeMatchedShares;
    }

    return null;
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

function buildDirectOrderToolCall(market, config) {
    return {
        callId: `direct-polymarket-order-${market.stream.marketId}-${market.execution.currentSourceTradeId}`,
        name: 'polymarket_clob_build_sign_and_place_order',
        arguments: JSON.stringify(market.execution.pendingOrderArgs ?? {
            side: 'BUY',
            tokenId: market.execution.tokenId,
            orderType: 'FOK',
            makerAmount: null,
            takerAmount: null,
            chainId: Number(config.chainId),
        }),
    };
}

async function findOrCreateDirectOrderToolCall({
    state,
    policy,
    config,
    agentAddress,
}) {
    const preflightError = getDirectTradingPreflightError(config);
    const marketIds = Object.keys(policy.marketsById ?? {}).sort((left, right) =>
        left.localeCompare(right)
    );
    let changed = false;

    for (const marketId of marketIds) {
        const marketConfig = policy.marketsById[marketId];
        if (!isDirectTradingReady(marketConfig)) {
            continue;
        }

        const market = ensureMarketState(state, {
            policy,
            config,
            marketId,
        });

        if (market.settlement?.settledAtMs) {
            continue;
        }
        if (market.pendingPublication) {
            continue;
        }
        if (market.execution?.orderDispatchAtMs && market.execution?.pendingOrderArgs) {
            ensureClobAuthAddressFallback({ config, policy, agentAddress });
            return {
                changed: false,
                toolCall: buildDirectOrderToolCall(market, config),
            };
        }
        if (
            market.execution?.currentSourceTradeId ||
            market.execution?.orderId ||
            market.execution?.orderSubmittedAtMs
        ) {
            continue;
        }

        let latestTrade;
        try {
            latestTrade = await fetchLatestSourceTrade({ marketConfig });
            if (market.execution.orderError || market.execution.orderStatusRefreshFailedAtMs) {
                market.execution.orderError = null;
                market.execution.orderStatusRefreshFailedAtMs = null;
                changed = true;
            }
        } catch (error) {
            const detail = error?.message ?? String(error);
            if (
                market.execution.orderError !== detail ||
                !Number.isInteger(market.execution.orderStatusRefreshFailedAtMs)
            ) {
                market.execution.orderError = detail;
                market.execution.orderStatusRefreshFailedAtMs = Date.now();
                changed = true;
            }
            continue;
        }
        if (!latestTrade || latestTrade.side !== 'BUY') {
            continue;
        }
        if (latestTrade.id === market.execution?.observedSourceTradeId) {
            continue;
        }

        const tokenId =
            latestTrade.outcome === 'YES' ? marketConfig.yesTokenId : marketConfig.noTokenId;
        if (!tokenId) {
            continue;
        }
        if (preflightError) {
            throw new Error(preflightError);
        }
        const { makerAmount, takerAmount } = computeBuyOrderAmounts({
            collateralAmountWei: marketConfig.initiatedCollateralAmountWei,
            price: latestTrade.price,
        });

        market.execution.currentSourceTradeId = latestTrade.id;
        market.execution.currentSourceTradeExecutedAtMs =
            latestTrade.executedAtMs ?? Date.now();
        market.execution.currentSourceTradePrice = latestTrade.price;
        market.execution.currentSourceTradeOutcome = latestTrade.outcome;
        market.execution.currentSourceTradeSide = latestTrade.side;
        market.execution.currentSourceTradeDescription =
            latestTrade.description ??
            `Direct Polymarket copy of source trade ${latestTrade.id}.`;
        market.execution.tokenId = tokenId;
        market.execution.orderError = null;
        market.execution.orderStatusRefreshFailedAtMs = null;
        market.execution.pendingOrderArgs = {
            side: 'BUY',
            tokenId,
            orderType: 'FOK',
            makerAmount,
            takerAmount,
            maker: ensureClobAuthAddressFallback({ config, policy, agentAddress }),
            chainId: Number(config.chainId),
        };
        market.execution.orderDispatchAtMs = Date.now();

        return {
            changed: true,
            toolCall: buildDirectOrderToolCall(market, config),
        };
    }

    return changed ? { changed: true, toolCall: null } : null;
}

function clearPendingDirectOrder(execution, { keepCurrentSource = false } = {}) {
    execution.pendingOrderArgs = null;
    execution.orderDispatchAtMs = null;
    execution.orderId = null;
    execution.orderStatus = null;
    execution.orderSubmittedAtMs = null;
    execution.orderStatusRefreshFailedAtMs = null;
    execution.tokenId = null;
    if (!keepCurrentSource) {
        execution.currentSourceTradeId = null;
        execution.currentSourceTradeExecutedAtMs = null;
        execution.currentSourceTradePrice = null;
        execution.currentSourceTradeOutcome = null;
        execution.currentSourceTradeSide = null;
        execution.currentSourceTradeDescription = null;
    }
}

async function refreshDirectExecutionState({
    state,
    policy,
    config,
    agentAddress,
}) {
    let changed = false;
    const clobAuthAddress = getClobAuthAddress({ config, policy, agentAddress });

    for (const market of Object.values(state.markets ?? {})) {
        const marketConfig = policy.marketsById?.[market.stream.marketId];
        if (!isDirectTradingReady(marketConfig)) {
            continue;
        }
        const execution = market.execution;
        if (!execution?.orderId || !execution?.orderSubmittedAtMs || !execution?.currentSourceTradeId) {
            continue;
        }

        try {
            const orderPayload = await getClobOrder({
                config,
                signingAddress: clobAuthAddress,
                orderId: execution.orderId,
            });
            const orderSummary = extractOrderSummary(orderPayload);
            if (orderSummary?.status && orderSummary.status !== execution.orderStatus) {
                execution.orderStatus = orderSummary.status;
                changed = true;
            }

            const relatedTrades = await fetchRelatedClobTrades({
                config,
                signingAddress: clobAuthAddress,
                orderId: execution.orderId,
                market: marketConfig.sourceMarket ?? market.stream.marketId,
                clobAuthAddress,
                submittedMs: execution.orderSubmittedAtMs,
            });
            const orderFailed = CLOB_ORDER_FAILURE_STATUSES.has(orderSummary?.status ?? '');
            const orderFilled =
                isOrderFullyMatched(orderSummary) ||
                CLOB_ORDER_FILLED_STATUSES.has(orderSummary?.status ?? '');
            const allConfirmedTrades =
                relatedTrades.length > 0 &&
                relatedTrades.every(
                    (trade) => normalizeClobStatus(trade?.status) === CLOB_SUCCESS_TERMINAL_STATUS
                );

            if (orderFailed) {
                execution.observedSourceTradeId = execution.currentSourceTradeId;
                execution.orderError = 'Polymarket order failed or was rejected.';
                clearPendingDirectOrder(execution);
                changed = true;
                continue;
            }

            if (orderFilled) {
                const collateralAmountWei = resolveFilledBuySpendWei({
                    orderSummary,
                    relatedTrades,
                });
                const shareAmount = resolveFilledBuyShareAmount({
                    orderSummary,
                    relatedTrades,
                });
                const filledSettlementReady =
                    (allConfirmedTrades && Boolean(collateralAmountWei) && Boolean(shareAmount)) ||
                    (relatedTrades.length === 0 &&
                        Boolean(collateralAmountWei) &&
                        Boolean(shareAmount));
                if (!filledSettlementReady) {
                    if (
                        execution.orderError !==
                            'Filled Polymarket order is waiting for trade reconciliation details.' ||
                        !Number.isInteger(execution.orderStatusRefreshFailedAtMs)
                    ) {
                        execution.orderError =
                            'Filled Polymarket order is waiting for trade reconciliation details.';
                        execution.orderStatusRefreshFailedAtMs = Date.now();
                        changed = true;
                    }
                    continue;
                }

                if (!collateralAmountWei || !shareAmount) {
                    execution.orderError =
                        'Filled Polymarket order could not be reconciled into collateral and share amounts.';
                    execution.orderStatusRefreshFailedAtMs = Date.now();
                    changed = true;
                    continue;
                }

                const tradeEntryKind = market.trades.some(
                    (trade) => trade.tradeEntryKind === 'initiated'
                )
                    ? 'continuation'
                    : 'initiated';
                ingestObservedTrade(state, {
                    policy,
                    config,
                    marketId: market.stream.marketId,
                    trade: {
                        tradeId: `clob:${execution.orderId}`,
                        tradeEntryKind,
                        executedAtMs: execution.currentSourceTradeExecutedAtMs ?? Date.now(),
                        principalContributionWei:
                            tradeEntryKind === 'initiated' ? collateralAmountWei : '0',
                        side: execution.currentSourceTradeSide,
                        outcome: execution.currentSourceTradeOutcome,
                        tokenId: execution.tokenId,
                        collateralAmountWei,
                        shareAmount,
                        externalTradeId: execution.currentSourceTradeId,
                        orderId: execution.orderId,
                        description: execution.currentSourceTradeDescription,
                        sourceRequestId: `direct:${execution.currentSourceTradeId}`,
                    },
                });
                execution.observedSourceTradeId = execution.currentSourceTradeId;
                execution.orderError = null;
                clearPendingDirectOrder(execution);
                changed = true;
            }
        } catch (error) {
            const detail = error?.message ?? String(error);
            if (
                execution.orderError !== detail ||
                !Number.isInteger(execution.orderStatusRefreshFailedAtMs)
            ) {
                execution.orderError = detail;
                execution.orderStatusRefreshFailedAtMs = Date.now();
                changed = true;
            }
        }
    }

    return changed;
}

function applyDirectOrderToolOutput(state, parsedOutput) {
    const market = Object.values(state.markets ?? {}).find(
        (entry) => entry.execution?.orderDispatchAtMs && entry.execution?.pendingOrderArgs
    );
    if (!market) {
        return false;
    }

    const execution = market.execution;
    const status = normalizeOptionalString(parsedOutput?.status)?.toLowerCase();

    if (status === 'submitted') {
        execution.orderId = extractOrderIdFromSubmission(parsedOutput);
        execution.orderStatus = extractOrderStatusFromSubmission(parsedOutput);
        execution.orderSubmittedAtMs = Date.now();
        execution.orderDispatchAtMs = null;
        execution.pendingOrderArgs = null;
        execution.orderError =
            execution.orderId
                ? null
                : 'Polymarket order submission did not return an order id; manual reconciliation is required before retry.';
        execution.orderStatusRefreshFailedAtMs = null;
        return true;
    }

    if (status === 'error' || status === 'skipped') {
        execution.orderDispatchAtMs = Date.now();
        execution.orderError =
            normalizeOptionalString(parsedOutput?.message) ??
            normalizeOptionalString(parsedOutput?.reason) ??
            'Polymarket order placement failed.';
        return true;
    }

    execution.orderDispatchAtMs = null;
    execution.pendingOrderArgs = null;
    execution.orderError =
        'Polymarket order tool output was not recognized; manual inspection may be required.';
    return true;
}

export {
    applyDirectOrderToolOutput,
    findOrCreateDirectOrderToolCall,
    refreshDirectExecutionState,
};
