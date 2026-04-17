import { erc1155Abi, getAddress } from 'viem';
import { normalizeAddressOrNull } from '../../../agent/src/lib/utils.js';
import { applyObservedSettlement, isDirectTradingReady } from './trade-ledger.js';

const GAMMA_API_HOST = 'https://gamma-api.polymarket.com';
const DEFAULT_POLYMARKET_CTF_BY_CHAIN_ID = Object.freeze({
    137: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
});
const RESOLVED_SETTLEMENT_SOURCE = 'polymarket_resolved_state';
const REQUEST_TIMEOUT_MS = 10_000;
const FLOAT_TOLERANCE = 1e-9;
const EXPLICIT_RESOLVED_GAMMA_STATUSES = new Set(['resolved', 'finalized', 'settled']);

function normalizeNonEmptyString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function parseTimestampMs(value) {
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

function parseJsonArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeOutcome(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'yes') {
        return 'YES';
    }
    if (normalized === 'no') {
        return 'NO';
    }
    return null;
}

function approximatelyEqual(left, right) {
    return Math.abs(Number(left) - Number(right)) <= FLOAT_TOLERANCE;
}

function isExplicitlyResolvedMarket(marketPayload) {
    const candidates = [
        marketPayload?.umaResolutionStatus,
        marketPayload?.resolutionStatus,
        marketPayload?.marketStatus,
    ];
    for (const value of candidates) {
        const normalized = normalizeNonEmptyString(value)?.toLowerCase();
        if (normalized && EXPLICIT_RESOLVED_GAMMA_STATUSES.has(normalized)) {
            return true;
        }
    }
    return false;
}

function resolveGammaMarketRequest(marketConfig, market) {
    const slug = normalizeNonEmptyString(marketConfig?.gammaMarketSlug);
    if (slug) {
        return `${GAMMA_API_HOST}/markets/slug/${encodeURIComponent(slug)}`;
    }
    const marketId =
        normalizeNonEmptyString(marketConfig?.gammaMarketId) ??
        normalizeNonEmptyString(marketConfig?.sourceMarket) ??
        normalizeNonEmptyString(market?.stream?.marketId);
    if (!marketId) {
        return null;
    }
    return `${GAMMA_API_HOST}/markets/${encodeURIComponent(marketId)}`;
}

async function fetchGammaMarket({ marketConfig, market }) {
    const endpoint = resolveGammaMarketRequest(marketConfig, market);
    if (!endpoint) {
        return null;
    }
    const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Gamma market request failed (${response.status}).`);
    }
    return await response.json();
}

function parseResolutionPayout(marketPayload) {
    const outcomes = parseJsonArray(marketPayload?.outcomes)?.map(normalizeOutcome) ?? null;
    const prices =
        parseJsonArray(marketPayload?.outcomePrices)?.map((value) => Number(value)) ?? null;
    if (!outcomes || !prices || outcomes.length !== prices.length) {
        return null;
    }

    const byOutcome = new Map();
    for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        const price = prices[index];
        if (!outcome || !Number.isFinite(price)) {
            continue;
        }
        byOutcome.set(outcome, price);
    }

    const yesPrice = byOutcome.get('YES');
    const noPrice = byOutcome.get('NO');
    if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
        return null;
    }

    if (approximatelyEqual(yesPrice, 1) && approximatelyEqual(noPrice, 0)) {
        return {
            yesNumerator: 1n,
            noNumerator: 0n,
            denominator: 1n,
            settlementKind: 'resolved',
        };
    }
    if (approximatelyEqual(yesPrice, 0) && approximatelyEqual(noPrice, 1)) {
        return {
            yesNumerator: 0n,
            noNumerator: 1n,
            denominator: 1n,
            settlementKind: 'resolved',
        };
    }
    if (approximatelyEqual(yesPrice, 0.5) && approximatelyEqual(noPrice, 0.5)) {
        return {
            yesNumerator: 1n,
            noNumerator: 1n,
            denominator: 2n,
            settlementKind: 'resolved',
        };
    }
    return null;
}

function configuredTokensMatchMarket({
    marketPayload,
    yesTokenId,
    noTokenId,
}) {
    const configuredYesTokenId = normalizeNonEmptyString(yesTokenId);
    const configuredNoTokenId = normalizeNonEmptyString(noTokenId);
    if (!configuredYesTokenId || !configuredNoTokenId) {
        return false;
    }
    const tokenIds = parseJsonArray(marketPayload?.clobTokenIds)?.map((value) =>
        normalizeNonEmptyString(value)
    );
    if (!tokenIds || tokenIds.length < 2) {
        return true;
    }
    return tokenIds.includes(configuredYesTokenId) && tokenIds.includes(configuredNoTokenId);
}

function resolveCtfContract({ policy, config }) {
    const configured =
        normalizeAddressOrNull(policy?.ctfContract) ??
        normalizeAddressOrNull(config?.polymarketCtfContract) ??
        normalizeAddressOrNull(config?.polymarketConditionalTokens);
    if (configured) {
        return configured;
    }
    const fallback = DEFAULT_POLYMARKET_CTF_BY_CHAIN_ID[Number(config?.chainId)];
    return normalizeAddressOrNull(fallback);
}

function resolveSettlementHolderAddress({ policy, config, agentAddress }) {
    return (
        normalizeAddressOrNull(config?.polymarketClobAddress) ??
        normalizeAddressOrNull(policy?.tradingWallet) ??
        normalizeAddressOrNull(agentAddress)
    );
}

async function readOutcomeBalance({
    publicClient,
    ctfContract,
    tokenHolderAddress,
    tokenId,
}) {
    const balance = await publicClient.readContract({
        address: getAddress(ctfContract),
        abi: erc1155Abi,
        functionName: 'balanceOf',
        args: [getAddress(tokenHolderAddress), BigInt(tokenId)],
    });
    return BigInt(balance);
}

function computeSettlementValueWei({
    yesBalance,
    noBalance,
    payout,
}) {
    const numerator =
        yesBalance * BigInt(payout.yesNumerator) + noBalance * BigInt(payout.noNumerator);
    const denominator = BigInt(payout.denominator);
    if (denominator <= 0n) {
        throw new Error('Resolved payout denominator must be positive.');
    }
    // The collateral token settles in base units only, so round down
    // deterministically when the resolved payout lands between base units.
    return (numerator / denominator).toString();
}

async function refreshObservedSettlements({
    state,
    policy,
    config,
    publicClient,
    agentAddress,
}) {
    if (!publicClient || typeof publicClient.readContract !== 'function') {
        return false;
    }

    const ctfContract = resolveCtfContract({ policy, config });
    const tokenHolderAddress = resolveSettlementHolderAddress({
        policy,
        config,
        agentAddress,
    });
    if (!ctfContract || !tokenHolderAddress) {
        return false;
    }

    let changed = false;
    for (const market of Object.values(state.markets ?? {})) {
        const marketConfig = policy.marketsById?.[market.stream.marketId];
        if (!isDirectTradingReady(marketConfig)) {
            continue;
        }
        if (!Array.isArray(market.trades) || market.trades.length === 0) {
            continue;
        }
        if (
            Number.isInteger(market.settlement?.depositConfirmedAtMs) ||
            Number.isInteger(market.settlement?.depositSubmittedAtMs) ||
            normalizeNonEmptyString(market.settlement?.depositTxHash)
        ) {
            continue;
        }
        if (Number.isInteger(market.settlement?.settledAtMs)) {
            continue;
        }

        let marketPayload;
        try {
            marketPayload = await fetchGammaMarket({
                marketConfig,
                market,
            });
        } catch {
            continue;
        }
        if (!isExplicitlyResolvedMarket(marketPayload)) {
            continue;
        }
        const payout = parseResolutionPayout(marketPayload);
        if (!payout) {
            continue;
        }
        if (
            !configuredTokensMatchMarket({
                marketPayload,
                yesTokenId: marketConfig?.yesTokenId,
                noTokenId: marketConfig?.noTokenId,
            })
        ) {
            continue;
        }

        let yesBalance;
        let noBalance;
        try {
            yesBalance = await readOutcomeBalance({
                publicClient,
                ctfContract,
                tokenHolderAddress,
                tokenId: marketConfig.yesTokenId,
            });
            noBalance = await readOutcomeBalance({
                publicClient,
                ctfContract,
                tokenHolderAddress,
                tokenId: marketConfig.noTokenId,
            });
        } catch {
            continue;
        }

        let finalSettlementValueWei;
        try {
            finalSettlementValueWei = computeSettlementValueWei({
                yesBalance,
                noBalance,
                payout,
            });
        } catch {
            continue;
        }

        const settledAtMs =
            parseTimestampMs(
                marketPayload?.closedTime ??
                    marketPayload?.updatedAt ??
                    marketPayload?.endDateIso ??
                    marketPayload?.endDate
            ) ?? Date.now();

        changed =
            applyObservedSettlement(market, {
                finalSettlementValueWei,
                settledAtMs,
                settlementKind: payout.settlementKind,
                depositError: null,
                observationSource: RESOLVED_SETTLEMENT_SOURCE,
            }) || changed;
    }

    return changed;
}

export { refreshObservedSettlements };
