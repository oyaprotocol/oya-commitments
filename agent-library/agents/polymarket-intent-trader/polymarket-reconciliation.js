import { parseUnits } from 'viem';
import {
    CLOB_FAILURE_TERMINAL_STATUS,
    CLOB_ORDER_FAILURE_STATUSES,
    CLOB_ORDER_FILLED_STATUSES,
    CLOB_SUCCESS_TERMINAL_STATUS,
    getClobOrder,
    getClobTrades,
} from '../../../agent/src/lib/polymarket.js';
import {
    normalizeAddressOrNull,
    parseFiniteNumber,
} from '../../../agent/src/lib/utils.js';

const PRICE_SCALE = 1_000_000n;
const USDC_DECIMALS = 6;
const SHARE_DECIMALS = 6;
const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';
const DEFAULT_CLOB_REQUEST_TIMEOUT_MS = 15_000;

function normalizeNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function parseOptionalPositiveInteger(value) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        return null;
    }
    return normalized;
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
    } catch (error) {
        return null;
    }
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
    } catch (error) {
        return null;
    }
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
    } catch (error) {
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

    const normalizedFeeShareAmount = parseOptionalNonNegativeIntegerString(feeShareAmount);
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

    const feeShareAmount = parseOptionalShareAmountString(
        trade?.fee ??
            trade?.fee_amount ??
            trade?.feeAmount ??
            trade?.fee_paid ??
            trade?.feePaid
    );
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
        orderSummary?.makerAmountFilled ?? orderSummary?.makingAmountFilled
    );
    if (orderSummarySpend) {
        return orderSummarySpend;
    }

    const confirmedTradeSpend = sumConfirmedTradeSpendWei({ relatedTrades });
    if (confirmedTradeSpend) {
        return confirmedTradeSpend;
    }

    return null;
}

function resolveFilledBuyShareAmount({ intent, orderSummary, relatedTrades }) {
    const netTakerAmountFilled = subtractFilledShareFee(
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
    const minimumShareAmount = parseOptionalNonNegativeIntegerString(intent?.orderTakerAmount);
    if (
        sizeMatchedShares &&
        BigInt(sizeMatchedShares) > 0n &&
        (!minimumShareAmount || BigInt(sizeMatchedShares) >= BigInt(minimumShareAmount))
    ) {
        return sizeMatchedShares;
    }

    return null;
}

function normalizeClobHost(host) {
    return (normalizeNonEmptyString(host) ?? DEFAULT_CLOB_HOST).replace(/\/+$/, '');
}

export function getClobAuthAddress({ config, accountAddress }) {
    return (
        normalizeAddressOrNull(config?.polymarketClobAddress) ??
        normalizeAddressOrNull(accountAddress)
    );
}

export async function fetchClobFeeRateBps({ config, tokenId }) {
    const timeoutMs =
        parseOptionalPositiveInteger(config?.polymarketClobRequestTimeoutMs) ??
        DEFAULT_CLOB_REQUEST_TIMEOUT_MS;
    const url = new URL('/fee-rate', `${normalizeClobHost(config?.polymarketClobHost)}/`);
    url.searchParams.set('token_id', String(tokenId));

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Failed to fetch Polymarket fee rate for token ${tokenId} (${response.status} ${response.statusText}): ${body}`
        );
    }

    const payload = await response.json();
    const feeRateBps = Number(payload?.base_fee ?? payload?.baseFee);
    if (!Number.isInteger(feeRateBps) || feeRateBps < 0) {
        throw new Error(
            `Polymarket fee-rate response missing non-negative integer base_fee for token ${tokenId}.`
        );
    }

    return String(feeRateBps);
}

async function fetchRelatedClobTrades({
    config,
    signingAddress,
    orderId,
    market,
    clobAuthAddress,
    submittedMs,
}) {
    const afterSeconds = Math.max(
        0,
        Math.floor((Number(submittedMs ?? Date.now()) - 60_000) / 1000)
    );
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

export function extractOrderIdFromSubmission(parsedOutput) {
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

export function extractOrderStatusFromSubmission(parsedOutput) {
    return normalizeClobStatus(
        parsedOutput?.result?.order?.status ??
            parsedOutput?.result?.status ??
            parsedOutput?.order?.status
    );
}

export async function refreshOrderStatus({
    openIntents,
    account,
    config,
    policy,
    hasTimedOut,
    markTerminalIntentFailure,
    observeFilledTokenInventoryDelta,
    nowMs = Date.now(),
}) {
    const clobAuthAddress = getClobAuthAddress({
        config,
        accountAddress: account?.address,
    });
    if (!clobAuthAddress) {
        return false;
    }

    let changed = false;
    for (const intent of Array.isArray(openIntents) ? openIntents : []) {
        if (intent.orderFilled) {
            continue;
        }
        if (!intent.orderId) {
            if (hasTimedOut(intent.orderSubmittedAtMs, policy.pendingTxTimeoutMs, nowMs)) {
                const detail =
                    intent.lastOrderSubmissionStatus === 'missing_order_id'
                        ? 'Polymarket order submission returned submitted without an order id; refusing automatic retry and waiting for manual reconciliation.'
                        : intent.lastOrderSubmissionError ??
                          'Polymarket order submission outcome remained ambiguous until timeout; refusing automatic retry.';
                if (
                    intent.lastOrderStatusRefreshError !== detail ||
                    !Number.isInteger(intent.orderStatusRefreshFailedAtMs)
                ) {
                    intent.lastOrderStatusRefreshError = detail;
                    intent.orderStatusRefreshFailedAtMs = nowMs;
                    intent.updatedAtMs = nowMs;
                    changed = true;
                }
                changed = true;
            }
            continue;
        }

        try {
            const orderPayload = await getClobOrder({
                config,
                signingAddress: clobAuthAddress,
                orderId: intent.orderId,
            });
            const orderSummary = extractOrderSummary(orderPayload);
            if (orderSummary?.status && orderSummary.status !== intent.orderStatus) {
                intent.orderStatus = orderSummary.status;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
            const orderFailed = CLOB_ORDER_FAILURE_STATUSES.has(orderSummary?.status ?? '');
            if (orderFailed) {
                markTerminalIntentFailure(intent, {
                    stage: 'order',
                    status: orderSummary?.status ?? 'failed',
                    detail: 'Polymarket order failed or was rejected.',
                    releaseCredit: true,
                });
                changed = true;
                continue;
            }

            const relatedTrades = await fetchRelatedClobTrades({
                config,
                signingAddress: clobAuthAddress,
                orderId: intent.orderId,
                market: policy.marketId,
                clobAuthAddress,
                submittedMs: intent.orderSubmittedAtMs,
            });
            if (intent.lastOrderStatusRefreshError || intent.orderStatusRefreshFailedAtMs) {
                delete intent.lastOrderStatusRefreshError;
                delete intent.orderStatusRefreshFailedAtMs;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
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

            if (anyFailedTrade) {
                markTerminalIntentFailure(intent, {
                    stage: 'order',
                    status: orderSummary?.status ?? 'failed',
                    detail: 'Polymarket order failed or was rejected.',
                    releaseCredit: true,
                });
                changed = true;
                continue;
            }

            const reimbursementAmountWei = resolveFilledBuySpendWei({
                orderSummary,
                relatedTrades,
            });
            let filledShareAmount = resolveFilledBuyShareAmount({
                intent,
                orderSummary,
                relatedTrades,
            });
            const observedFilledShareAmount = await observeFilledTokenInventoryDelta({
                intent,
            });
            const configuredFeeRateBps = parseOptionalNonNegativeIntegerString(intent.feeRateBps);
            const feeEnabledBuy =
                (configuredFeeRateBps && BigInt(configuredFeeRateBps) > 0n) ||
                Boolean(orderSummary?.feeAmount);
            if (
                feeEnabledBuy &&
                observedFilledShareAmount &&
                filledShareAmount &&
                BigInt(observedFilledShareAmount) > 0n &&
                BigInt(observedFilledShareAmount) < BigInt(filledShareAmount)
            ) {
                filledShareAmount = observedFilledShareAmount;
            }
            const tokenBalanceSettlementReady =
                orderFilled &&
                relatedStatuses.length === 0 &&
                Boolean(reimbursementAmountWei) &&
                Boolean(filledShareAmount) &&
                Boolean(observedFilledShareAmount) &&
                BigInt(observedFilledShareAmount) >= BigInt(filledShareAmount);

            if ((allConfirmedTrades && orderFilled) || tokenBalanceSettlementReady) {
                if (!reimbursementAmountWei) {
                    throw new Error(
                        `Unable to determine actual USDC spent for filled Polymarket BUY order ${intent.orderId}.`
                    );
                }
                if (!filledShareAmount) {
                    throw new Error(
                        `Unable to determine acquired share amount for filled Polymarket BUY order ${intent.orderId}.`
                    );
                }
                intent.orderFilled = true;
                intent.orderFilledAtMs = nowMs;
                intent.reimbursementAmountWei = reimbursementAmountWei;
                intent.reservedCreditAmountWei = reimbursementAmountWei;
                intent.filledShareAmount = filledShareAmount;
                intent.orderSettlementEvidence = tokenBalanceSettlementReady
                    ? 'token_balance'
                    : 'confirmed_trades';
                intent.updatedAtMs = nowMs;
                changed = true;
            }
        } catch (error) {
            if (!hasTimedOut(intent.orderSubmittedAtMs, policy.pendingTxTimeoutMs, nowMs)) {
                continue;
            }
            const detail = error?.message ?? String(error);
            if (
                intent.lastOrderStatusRefreshError !== detail ||
                !Number.isInteger(intent.orderStatusRefreshFailedAtMs)
            ) {
                intent.lastOrderStatusRefreshError = detail;
                intent.orderStatusRefreshFailedAtMs = nowMs;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
        }
    }

    return changed;
}
