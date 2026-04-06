import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, hexToString } from 'viem';
import {
    findContractDeploymentBlock,
    getBlockTimestampMs,
    getLogsChunked,
} from '../../../agent/src/lib/chain-history.js';
import {
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
} from '../../../agent/src/lib/og.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import {
    normalizeAddressOrThrow,
    normalizeHashOrNull,
} from '../../../agent/src/lib/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CANONICAL_SYMBOLS = Object.freeze({
    USDC: 'USDC',
    WETH: 'WETH',
    CBBTC: 'cbBTC',
});
const MOMENTUM_SYMBOLS = Object.freeze([CANONICAL_SYMBOLS.WETH, CANONICAL_SYMBOLS.CBBTC]);
const REIMBURSEMENT_SYMBOLS = Object.freeze([
    CANONICAL_SYMBOLS.USDC,
    CANONICAL_SYMBOLS.WETH,
    CANONICAL_SYMBOLS.CBBTC,
]);
const DEFAULT_POLICY = Object.freeze({
    tradeAmountUsd: '25',
    epochSeconds: 21_600,
    daySeconds: 86_400,
    pendingEpochTtlMs: 30 * 60 * 1000,
    proposalScanChunkSize: 5_000n,
    tieBreakAssetOrder: Object.freeze([CANONICAL_SYMBOLS.WETH, CANONICAL_SYMBOLS.CBBTC]),
});
const DEFAULT_PRICE_FEED = Object.freeze({
    provider: 'alchemy',
    apiBaseUrl: 'https://api.g.alchemy.com/prices/v1',
    quoteCurrency: 'USD',
    symbols: Object.freeze({
        WETH: 'ETH',
        cbBTC: 'BTC',
        USDC: 'USDC',
    }),
});
const CURRENT_PRICE_CACHE_TTL_MS = 60_000;
const MICRO_USD_SCALE = 1_000_000n;
const STRATEGY_TAG = 'first-proxy-momentum';
const moduleCaches = {
    deployment: new Map(),
    currentPrices: new Map(),
    historicalRanges: new Map(),
    tokenMeta: new Map(),
};
const strategyState = {
    submittedEpochs: new Map(),
    pendingPlan: null,
};
let activeStatePath = null;
let hydratedStatePath = null;
let lastValidatedEpoch = null;
let lastValidatedPendingPlan = null;

function canonicalizeSymbol(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'usdc') return CANONICAL_SYMBOLS.USDC;
    if (normalized === 'weth') return CANONICAL_SYMBOLS.WETH;
    if (normalized === 'cbbtc') return CANONICAL_SYMBOLS.CBBTC;
    throw new Error(`Unsupported asset symbol: ${value}`);
}

function displaySymbol(symbol) {
    return canonicalizeSymbol(symbol);
}

function normalizeAddress(value) {
    return normalizeAddressOrThrow(value, { requireHex: false });
}

function normalizeAlchemySymbol(value, label) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) {
        throw new Error(`${label} is required.`);
    }
    return normalized;
}

function normalizeQuoteCurrency(value, label) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) {
        throw new Error(`${label} is required.`);
    }
    return normalized;
}

function parsePositiveInteger(value, label) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return numeric;
}

function parseBigIntValue(value, label) {
    try {
        const parsed = BigInt(String(value));
        if (parsed <= 0n) {
            throw new Error(`${label} must be greater than zero.`);
        }
        return parsed;
    } catch {
        throw new Error(`${label} must be an integer string.`);
    }
}

function parseUsdToMicros(value, label) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        throw new Error(`${label} is required.`);
    }
    const match = raw.match(/^(\d+)(?:\.(\d{1,6})\d*)?$/);
    if (!match) {
        throw new Error(`${label} must be a positive decimal with up to 6 decimals.`);
    }
    const whole = BigInt(match[1]);
    const fractional = BigInt((match[2] ?? '').padEnd(6, '0'));
    const total = whole * MICRO_USD_SCALE + fractional;
    if (total <= 0n) {
        throw new Error(`${label} must be greater than zero.`);
    }
    return total;
}

function encodeReturnBps(value) {
    return Math.round(Number(value) * 10_000);
}

function getStatePath(config) {
    const configured =
        config?.agentConfig?.firstProxy?.stateFile ??
        config?.firstProxy?.stateFile ??
        config?.agentConfig?.firstProxy?.proposalStateFile ??
        config?.firstProxy?.proposalStateFile ??
        process.env.FIRST_PROXY_STATE_FILE;
    if (configured && String(configured).trim()) {
        return path.resolve(String(configured).trim());
    }
    return path.join(__dirname, '.momentum-state.json');
}

function normalizePendingPlan(rawPlan) {
    if (!rawPlan || typeof rawPlan !== 'object') return null;
    const epochIndex = Number(rawPlan.epochIndex);
    if (!Number.isInteger(epochIndex) || epochIndex < 0) {
        return null;
    }
    try {
        const winnerSymbol = canonicalizeSymbol(rawPlan.winnerSymbol);
        const depositAsset = normalizeAddress(rawPlan.depositAsset);
        const depositAmountWei = BigInt(String(rawPlan.depositAmountWei));
        if (!MOMENTUM_SYMBOLS.includes(winnerSymbol) || depositAmountWei <= 0n) {
            return null;
        }
        const actions = Array.isArray(rawPlan.actions)
            ? rawPlan.actions
                  .map((action) => {
                      if (action?.kind !== 'erc20_transfer') return null;
                      const token = normalizeAddress(action.token);
                      const to = normalizeAddress(action.to);
                      const amountWei = BigInt(String(action.amountWei));
                      if (amountWei <= 0n) return null;
                      return {
                          kind: 'erc20_transfer',
                          token,
                          to,
                          amountWei: amountWei.toString(),
                          operation: 0,
                      };
                  })
                  .filter(Boolean)
            : [];
        if (actions.length === 0) {
            return null;
        }
        const explanation =
            typeof rawPlan.explanation === 'string' && rawPlan.explanation.trim()
                ? rawPlan.explanation.trim()
                : null;
        if (!explanation) {
            return null;
        }
        return {
            epochIndex,
            winnerSymbol,
            depositAsset,
            depositAmountWei: depositAmountWei.toString(),
            actions,
            explanation,
            plannedAtMs: Number(rawPlan.plannedAtMs ?? 0),
        };
    } catch {
        return null;
    }
}

function ensureStateScope(config) {
    const statePath = getStatePath(config);
    if (activeStatePath !== statePath) {
        activeStatePath = statePath;
        hydratedStatePath = null;
        strategyState.submittedEpochs = new Map();
        strategyState.pendingPlan = null;
        lastValidatedEpoch = null;
        lastValidatedPendingPlan = null;
    }
    return statePath;
}

async function hydrateStrategyState(config) {
    const statePath = ensureStateScope(config);
    if (hydratedStatePath === statePath) return;
    hydratedStatePath = statePath;
    try {
        const raw = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw);
        const submittedEpochs = new Map();
        for (const [epochKey, value] of Object.entries(parsed?.submittedEpochs ?? {})) {
            const epochIndex = Number(epochKey);
            if (!Number.isInteger(epochIndex) || epochIndex < 0) continue;
            submittedEpochs.set(epochIndex, {
                proposalHash: normalizeHashOrNull(value?.proposalHash) ?? null,
                submittedAtMs: Number(value?.submittedAtMs ?? 0),
            });
        }
        strategyState.submittedEpochs = submittedEpochs;
        strategyState.pendingPlan = normalizePendingPlan(parsed?.pendingPlan);
    } catch {
        // Missing/corrupt state file is treated as empty.
    }
}

async function persistStrategyState(config) {
    const statePath = ensureStateScope(config);
    const submittedEpochs = {};
    for (const [epochIndex, entry] of strategyState.submittedEpochs.entries()) {
        submittedEpochs[String(epochIndex)] = {
            proposalHash: entry?.proposalHash ?? null,
            submittedAtMs: Number(entry?.submittedAtMs ?? 0),
        };
    }
    await writeFile(
        statePath,
        JSON.stringify(
            {
                submittedEpochs,
                pendingPlan: strategyState.pendingPlan,
            },
            null,
            2
        ),
        'utf8'
    );
}

async function setPendingPlan({ plan, config }) {
    strategyState.pendingPlan = normalizePendingPlan(plan);
    await persistStrategyState(config);
}

async function clearPendingPlan({ config }) {
    if (!strategyState.pendingPlan) return;
    strategyState.pendingPlan = null;
    await persistStrategyState(config);
}

async function markEpochSubmitted({ epochIndex, proposalHash = null, config }) {
    strategyState.submittedEpochs.set(epochIndex, {
        proposalHash: normalizeHashOrNull(proposalHash) ?? null,
        submittedAtMs: Date.now(),
    });
    if (strategyState.pendingPlan?.epochIndex === epochIndex) {
        strategyState.pendingPlan = null;
    }
    await persistStrategyState(config);
}

function resolveSubmittedProposalHash(parsedOutput) {
    const txHash = normalizeHashOrNull(parsedOutput?.transactionHash);
    const explicitOgHash = normalizeHashOrNull(parsedOutput?.ogProposalHash);
    const legacyHash = normalizeHashOrNull(parsedOutput?.proposalHash);
    return explicitOgHash ?? txHash ?? legacyHash ?? null;
}

function getConfigChainId(config) {
    if (config?.chainId !== undefined && config?.chainId !== null && `${config.chainId}` !== '') {
        const chainId = Number(config.chainId);
        if (Number.isInteger(chainId) && chainId > 0) {
            return chainId;
        }
    }
    const byChainKeys = Object.keys(config?.byChain ?? {});
    if (byChainKeys.length === 1) {
        const only = Number(byChainKeys[0]);
        if (Number.isInteger(only) && only > 0) {
            return only;
        }
    }
    return null;
}

function resolveChainConfig(config, chainId) {
    const byChain = config?.byChain ?? {};
    return byChain?.[String(chainId)] ?? byChain?.[chainId] ?? {};
}

function normalizeTieBreakOrder(rawOrder) {
    const values = Array.isArray(rawOrder) ? rawOrder : DEFAULT_POLICY.tieBreakAssetOrder;
    const order = [];
    for (const value of values) {
        const symbol = canonicalizeSymbol(value);
        if (!MOMENTUM_SYMBOLS.includes(symbol) || order.includes(symbol)) {
            continue;
        }
        order.push(symbol);
    }
    for (const symbol of MOMENTUM_SYMBOLS) {
        if (!order.includes(symbol)) {
            order.push(symbol);
        }
    }
    return order;
}

function normalizePriceFeed(rawPriceFeed) {
    const provider = String(rawPriceFeed?.provider ?? DEFAULT_PRICE_FEED.provider)
        .trim()
        .toLowerCase();
    if (provider !== 'alchemy') {
        throw new Error(`Unsupported firstProxy.priceFeed.provider: ${provider}`);
    }

    const apiBaseUrl = String(rawPriceFeed?.apiBaseUrl ?? DEFAULT_PRICE_FEED.apiBaseUrl)
        .trim()
        .replace(/\/+$/, '');
    const quoteCurrency = normalizeQuoteCurrency(
        rawPriceFeed?.quoteCurrency ?? rawPriceFeed?.vsCurrency ?? DEFAULT_PRICE_FEED.quoteCurrency,
        'firstProxy.priceFeed.quoteCurrency'
    );
    const rawSymbols = {
        ...DEFAULT_PRICE_FEED.symbols,
        ...(rawPriceFeed?.symbols ?? rawPriceFeed?.assetIds ?? {}),
    };

    return {
        provider,
        apiBaseUrl,
        quoteCurrency,
        symbols: {
            [CANONICAL_SYMBOLS.WETH]: normalizeAlchemySymbol(
                rawSymbols.WETH,
                'firstProxy.priceFeed.symbols.WETH'
            ),
            [CANONICAL_SYMBOLS.CBBTC]: normalizeAlchemySymbol(
                rawSymbols.cbBTC ?? rawSymbols.CBBTC,
                'firstProxy.priceFeed.symbols.cbBTC'
            ),
            [CANONICAL_SYMBOLS.USDC]: normalizeAlchemySymbol(
                rawSymbols.USDC,
                'firstProxy.priceFeed.symbols.USDC'
            ),
        },
    };
}

function resolvePolicyConfig(config, chainId) {
    const resolvedChainId = chainId ?? getConfigChainId(config);
    if (!resolvedChainId) {
        throw new Error('Unable to resolve chainId for first-proxy policy.');
    }
    const chainConfig = resolveChainConfig(config, resolvedChainId);
    const rawPolicy = {
        ...(config?.firstProxy ?? {}),
        ...(chainConfig?.firstProxy ?? {}),
    };
    const tokens = {
        [CANONICAL_SYMBOLS.USDC]: normalizeAddress(rawPolicy?.tokens?.USDC),
        [CANONICAL_SYMBOLS.WETH]: normalizeAddress(rawPolicy?.tokens?.WETH),
        [CANONICAL_SYMBOLS.CBBTC]: normalizeAddress(rawPolicy?.tokens?.cbBTC ?? rawPolicy?.tokens?.CBBTC),
    };
    const priceFeed = normalizePriceFeed(rawPolicy?.priceFeed ?? {});
    return {
        chainId: resolvedChainId,
        tradeAmountUsdMicros: parseUsdToMicros(
            rawPolicy.tradeAmountUsd ?? DEFAULT_POLICY.tradeAmountUsd,
            'firstProxy.tradeAmountUsd'
        ),
        epochSeconds: parsePositiveInteger(
            rawPolicy.epochSeconds ?? DEFAULT_POLICY.epochSeconds,
            'firstProxy.epochSeconds'
        ),
        daySeconds: parsePositiveInteger(
            rawPolicy.daySeconds ?? DEFAULT_POLICY.daySeconds,
            'firstProxy.daySeconds'
        ),
        pendingEpochTtlMs: parsePositiveInteger(
            rawPolicy.pendingEpochTtlMs ?? DEFAULT_POLICY.pendingEpochTtlMs,
            'firstProxy.pendingEpochTtlMs'
        ),
        proposalScanChunkSize: rawPolicy.proposalScanChunkSize
            ? parseBigIntValue(rawPolicy.proposalScanChunkSize, 'firstProxy.proposalScanChunkSize')
            : DEFAULT_POLICY.proposalScanChunkSize,
        tieBreakAssetOrder: normalizeTieBreakOrder(rawPolicy.tieBreakAssetOrder),
        tokens,
        priceFeed,
    };
}

async function loadTokenDecimals({ publicClient, token }) {
    const cacheKey = token.toLowerCase();
    if (moduleCaches.tokenMeta.has(cacheKey)) {
        return moduleCaches.tokenMeta.get(cacheKey);
    }
    const decimals = Number(
        await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'decimals',
        })
    );
    moduleCaches.tokenMeta.set(cacheKey, decimals);
    return decimals;
}

function extractAlchemyApiKeyFromRpcUrl(rpcUrl) {
    if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
        return null;
    }
    try {
        const url = new URL(rpcUrl);
        if (!/alchemy\.com$/i.test(url.hostname)) {
            return null;
        }
        const segments = url.pathname.split('/').filter(Boolean);
        const versionIndex = segments.findIndex((segment) => /^v[23]$/i.test(segment));
        if (versionIndex < 0 || versionIndex + 1 >= segments.length) {
            return null;
        }
        return segments[versionIndex + 1] || null;
    } catch {
        return null;
    }
}

function resolveAlchemyApiKey({ config, chainId }) {
    const explicitApiKey =
        process.env.ALCHEMY_PRICES_API_KEY?.trim() || process.env.ALCHEMY_API_KEY?.trim();
    if (explicitApiKey) {
        return explicitApiKey;
    }
    const chainConfig = resolveChainConfig(config, chainId);
    const candidateRpcUrls = [config?.rpcUrl, chainConfig?.rpcUrl];
    for (const rpcUrl of candidateRpcUrls) {
        const derivedApiKey = extractAlchemyApiKeyFromRpcUrl(rpcUrl);
        if (derivedApiKey) {
            return derivedApiKey;
        }
    }
    throw new Error(
        'Unable to resolve an Alchemy API key for first-proxy pricing. Set ALCHEMY_PRICES_API_KEY or use an Alchemy rpcUrl.'
    );
}

async function fetchAlchemyJson({
    policy,
    config,
    chainId,
    pathname,
    method = 'GET',
    searchParams = null,
    body = null,
    cacheKey = null,
}) {
    const requestKey = cacheKey ?? `${method}:${pathname}:${searchParams?.toString() ?? ''}`;
    const apiKey = resolveAlchemyApiKey({ config, chainId });
    const url = new URL(`${policy.priceFeed.apiBaseUrl}/${apiKey}${pathname}`);
    if (searchParams) {
        url.search = searchParams.toString();
    }

    const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        const error = new Error(`Alchemy Prices API error: ${response.status} ${url.pathname}`);
        error.statusCode = response.status;
        error.url = url.toString();
        error.cacheKey = requestKey;
        throw error;
    }
    return response.json();
}

async function fetchCurrentPricesFromAlchemy({ policy, config }) {
    const requestedSymbols = REIMBURSEMENT_SYMBOLS.map((symbol) => policy.priceFeed.symbols[symbol]);
    const cacheKey = `current:${policy.priceFeed.quoteCurrency}:${requestedSymbols.join(',')}`;
    const cached = moduleCaches.currentPrices.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
        return cached.payload;
    }

    const searchParams = new URLSearchParams();
    for (const symbol of requestedSymbols) {
        searchParams.append('symbols', symbol);
    }
    const payload = await fetchAlchemyJson({
        policy,
        config,
        chainId: policy.chainId,
        pathname: '/tokens/by-symbol',
        searchParams,
        cacheKey,
    });
    moduleCaches.currentPrices.set(cacheKey, {
        expiresAtMs: Date.now() + CURRENT_PRICE_CACHE_TTL_MS,
        payload,
    });
    return payload;
}

async function fetchHistoricalRangeFromAlchemy({
    config,
    policy,
    symbol,
    fromSeconds,
    toSeconds,
}) {
    const cacheKey = `historical:${symbol}:${policy.priceFeed.quoteCurrency}:${fromSeconds}:${toSeconds}`;
    if (moduleCaches.historicalRanges.has(cacheKey)) {
        return moduleCaches.historicalRanges.get(cacheKey);
    }

    const payload = await fetchAlchemyJson({
        policy,
        config,
        chainId: policy.chainId,
        pathname: '/tokens/historical',
        method: 'POST',
        body: {
            symbol,
            startTime: new Date(fromSeconds * 1000).toISOString(),
            endTime: new Date(toSeconds * 1000).toISOString(),
        },
        cacheKey,
    });
    moduleCaches.historicalRanges.set(cacheKey, payload);
    return payload;
}

function normalizeAlchemyCurrentPricePayload(payload, quoteCurrency) {
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const pricesBySymbol = new Map();
    for (const entry of entries) {
        const symbol = normalizeAlchemySymbol(entry?.symbol, 'Alchemy current price symbol');
        if (entry?.error) {
            throw new Error(`Alchemy current price error for ${symbol}: ${entry.error}`);
        }
        const prices = Array.isArray(entry?.prices) ? entry.prices : [];
        const matchingPrice =
            prices.find(
                (priceEntry) =>
                    normalizeQuoteCurrency(
                        priceEntry?.currency,
                        `Alchemy current price currency for ${symbol}`
                    ) === quoteCurrency
            ) ?? prices[0];
        const price = Number(matchingPrice?.value);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Alchemy current price missing for ${symbol}.`);
        }
        pricesBySymbol.set(symbol, price);
    }
    return pricesBySymbol;
}

function normalizeHistoricalPriceSeries(payload, symbol) {
    const series = Array.isArray(payload?.data?.prices) ? payload.data.prices : [];
    const normalized = series
        .map((entry) => {
            const timestampMs = Date.parse(String(entry?.timestamp ?? ''));
            const price = Number(entry?.value);
            if (!Number.isFinite(timestampMs) || !Number.isFinite(price) || price <= 0) {
                return null;
            }
            return {
                timestampSeconds: Math.floor(timestampMs / 1000),
                price,
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.timestampSeconds - right.timestampSeconds);
    if (normalized.length === 0) {
        throw new Error(`Alchemy historical prices returned no valid points for ${symbol}.`);
    }
    return normalized;
}

function pickClosestPricePoint(series, targetSeconds) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of series) {
        const distance = Math.abs(point.timestampSeconds - targetSeconds);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
            continue;
        }
        if (distance === bestDistance && best && point.timestampSeconds <= targetSeconds) {
            best = point;
        }
    }
    return best ?? series[series.length - 1];
}

async function fetchHistoricalPointFromAlchemy({
    config,
    policy,
    symbol,
    targetSeconds,
    radiusSeconds,
}) {
    const payload = await fetchHistoricalRangeFromAlchemy({
        config,
        policy,
        symbol,
        fromSeconds: Math.max(0, targetSeconds - radiusSeconds),
        toSeconds: targetSeconds + radiusSeconds,
    });
    return pickClosestPricePoint(normalizeHistoricalPriceSeries(payload, symbol), targetSeconds);
}

async function resolveStartBlock({ publicClient, config, latestBlock }) {
    if (config?.startBlock !== undefined && config?.startBlock !== null) {
        return BigInt(config.startBlock);
    }
    const deploymentKey = `${config?.ogModule ?? 'no-og'}:${latestBlock.toString()}`;
    if (moduleCaches.deployment.has(deploymentKey)) {
        return moduleCaches.deployment.get(deploymentKey);
    }
    const discovered = await findContractDeploymentBlock({
        publicClient,
        address: config.ogModule,
        latestBlock,
    });
    if (discovered === null) {
        throw new Error('Unable to auto-discover OG deployment block.');
    }
    moduleCaches.deployment.set(deploymentKey, discovered);
    return discovered;
}

async function findBlockAtOrBeforeTimestamp({
    publicClient,
    fromBlock,
    toBlock,
    targetTimestampSeconds,
    cache,
}) {
    let left = BigInt(fromBlock);
    let right = BigInt(toBlock);
    let best = left;
    while (left <= right) {
        const middle = (left + right) / 2n;
        const timestampMs = await getBlockTimestampMs(publicClient, middle, cache);
        const timestampSeconds = BigInt(Math.floor(timestampMs / 1000));
        if (timestampSeconds <= targetTimestampSeconds) {
            best = middle;
            left = middle + 1n;
        } else {
            if (middle === 0n) break;
            right = middle - 1n;
        }
    }
    return best;
}

function computeClosedEpochIndex({ nowSeconds, deploymentTimestampSeconds, epochSeconds }) {
    const elapsed = nowSeconds - deploymentTimestampSeconds;
    if (elapsed < BigInt(epochSeconds)) {
        return -1;
    }
    return Number(elapsed / BigInt(epochSeconds)) - 1;
}

function rankMomentumWinner({ returnsBySymbol, tieBreakAssetOrder }) {
    const ordered = [...MOMENTUM_SYMBOLS].sort((left, right) => {
        const leftReturn = Number(returnsBySymbol[left] ?? 0);
        const rightReturn = Number(returnsBySymbol[right] ?? 0);
        if (leftReturn !== rightReturn) {
            return rightReturn - leftReturn;
        }
        return tieBreakAssetOrder.indexOf(left) - tieBreakAssetOrder.indexOf(right);
    });
    return ordered[0];
}

function resolveFundingOrder({ winnerSymbol, returnsBySymbol, balancesBySymbol }) {
    const bothMomentumAssetsUp =
        Number(returnsBySymbol[CANONICAL_SYMBOLS.WETH] ?? 0) > 0 &&
        Number(returnsBySymbol[CANONICAL_SYMBOLS.CBBTC] ?? 0) > 0;

    const candidates = REIMBURSEMENT_SYMBOLS.filter(
        (symbol) => symbol !== winnerSymbol && BigInt(balancesBySymbol[symbol]?.amountWei ?? 0n) > 0n
    );

    if (bothMomentumAssetsUp && candidates.includes(CANONICAL_SYMBOLS.USDC)) {
        return [
            CANONICAL_SYMBOLS.USDC,
            ...candidates
                .filter((symbol) => symbol !== CANONICAL_SYMBOLS.USDC)
                .sort(
                    (left, right) => Number(returnsBySymbol[left] ?? 0) - Number(returnsBySymbol[right] ?? 0)
                ),
        ];
    }

    return candidates.sort(
        (left, right) => Number(returnsBySymbol[left] ?? 0) - Number(returnsBySymbol[right] ?? 0)
    );
}

function computeUsdValueMicros({ amountWei, decimals, priceMicros }) {
    return (BigInt(amountWei) * BigInt(priceMicros)) / 10n ** BigInt(decimals);
}

function computeTokenAmountForUsdMicros({ usdMicros, decimals, priceMicros }) {
    const denominator = BigInt(priceMicros);
    if (denominator <= 0n) {
        throw new Error('priceMicros must be positive.');
    }
    return (BigInt(usdMicros) * 10n ** BigInt(decimals)) / denominator;
}

function parseExplanationFields(explanation) {
    const fields = {};
    for (const part of String(explanation ?? '').split('|')) {
        if (!part) continue;
        const separatorIndex = part.indexOf('=');
        if (separatorIndex <= 0) continue;
        const key = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();
        if (!key) continue;
        fields[key] = value;
    }
    return fields;
}

function parseStrategyEpochFromExplanation(explanation) {
    const fields = parseExplanationFields(explanation);
    if (fields.strategy !== STRATEGY_TAG) {
        return null;
    }
    const epochIndex = Number(fields.epoch);
    return Number.isInteger(epochIndex) && epochIndex >= 0 ? epochIndex : null;
}

function decodeExplanation(explanationHex) {
    if (!explanationHex || typeof explanationHex !== 'string') {
        return undefined;
    }
    if (!explanationHex.startsWith('0x')) {
        return explanationHex;
    }
    try {
        return hexToString(explanationHex);
    } catch {
        return undefined;
    }
}

function mergeEpochStatus(existing, incoming) {
    if (!existing) return incoming;
    const rank = { deleted: 1, pending: 2, executed: 3 };
    return rank[incoming.status] >= rank[existing.status] ? incoming : existing;
}

async function collectEpochStatuses({
    publicClient,
    ogModule,
    fromBlock,
    toBlock,
    chunkSize,
}) {
    const [proposedLogs, executedLogs, deletedLogs] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock,
            chunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock,
            chunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock,
            chunkSize,
        }),
    ]);

    const executedHashes = new Set(
        executedLogs.map((log) => normalizeHashOrNull(log?.args?.proposalHash)).filter(Boolean)
    );
    const deletedHashes = new Set(
        deletedLogs.map((log) => normalizeHashOrNull(log?.args?.proposalHash)).filter(Boolean)
    );

    const statusesByEpoch = new Map();
    for (const log of proposedLogs) {
        const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
        if (!proposalHash) continue;
        const epochIndex = parseStrategyEpochFromExplanation(decodeExplanation(log?.args?.explanation));
        if (epochIndex === null) continue;
        const status = executedHashes.has(proposalHash)
            ? 'executed'
            : deletedHashes.has(proposalHash)
              ? 'deleted'
              : 'pending';
        statusesByEpoch.set(
            epochIndex,
            mergeEpochStatus(statusesByEpoch.get(epochIndex), {
                status,
                proposalHash,
            })
        );
    }
    return statusesByEpoch;
}

async function reconcileStrategyState({
    config,
    policy,
    publicClient,
    latestBlock,
}) {
    await hydrateStrategyState(config);
    const startBlock = await resolveStartBlock({ publicClient, config, latestBlock });
    const statusesByEpoch = await collectEpochStatuses({
        publicClient,
        ogModule: config.ogModule,
        fromBlock: startBlock,
        toBlock: latestBlock,
        chunkSize: policy.proposalScanChunkSize,
    });

    let changed = false;
    const nowMs = Date.now();
    for (const [epochIndex, entry] of [...strategyState.submittedEpochs.entries()]) {
        if (statusesByEpoch.has(epochIndex)) {
            strategyState.submittedEpochs.delete(epochIndex);
            changed = true;
            continue;
        }
        if (nowMs - Number(entry?.submittedAtMs ?? 0) > policy.pendingEpochTtlMs) {
            strategyState.submittedEpochs.delete(epochIndex);
            changed = true;
        }
    }

    const pendingPlanEpoch = strategyState.pendingPlan?.epochIndex;
    if (pendingPlanEpoch !== undefined) {
        const pendingStatus = statusesByEpoch.get(pendingPlanEpoch);
        if (pendingStatus && pendingStatus.status !== 'deleted') {
            strategyState.pendingPlan = null;
            changed = true;
        }
        if (strategyState.submittedEpochs.has(pendingPlanEpoch)) {
            strategyState.pendingPlan = null;
            changed = true;
        }
    }

    if (changed) {
        await persistStrategyState(config);
    }
    return { statusesByEpoch, startBlock };
}

async function resolveCurrentPrices({
    config,
    policy,
}) {
    const payload = await fetchCurrentPricesFromAlchemy({ policy, config });
    const currentPrices = normalizeAlchemyCurrentPricePayload(payload, policy.priceFeed.quoteCurrency);
    const pricesBySymbol = {};
    for (const symbol of REIMBURSEMENT_SYMBOLS) {
        const providerSymbol = policy.priceFeed.symbols[symbol];
        const price = currentPrices.get(providerSymbol);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Alchemy current price missing for ${symbol} (${providerSymbol}).`);
        }
        pricesBySymbol[symbol] = price;
    }
    return pricesBySymbol;
}

async function resolveHistoricalReturns({
    config,
    policy,
    windowStartSeconds,
    windowEndSeconds,
}) {
    const returnsBySymbol = {
        [CANONICAL_SYMBOLS.USDC]: 0,
    };
    const pricesAtWindow = {};

    for (const symbol of MOMENTUM_SYMBOLS) {
        const providerSymbol = policy.priceFeed.symbols[symbol];
        const history = await fetchHistoricalRangeFromAlchemy({
            config,
            policy,
            symbol: providerSymbol,
            fromSeconds: Number(windowStartSeconds),
            toSeconds: Number(windowEndSeconds),
        });
        const series = normalizeHistoricalPriceSeries(history, providerSymbol);
        let startPoint = pickClosestPricePoint(series, Number(windowStartSeconds));
        let endPoint = pickClosestPricePoint(series, Number(windowEndSeconds));
        if (series.length < 2 || startPoint.timestampSeconds === endPoint.timestampSeconds) {
            const fallbackRadiusSeconds = Math.max(300, Math.floor(policy.epochSeconds / 4));
            [startPoint, endPoint] = await Promise.all([
                fetchHistoricalPointFromAlchemy({
                    config,
                    policy,
                    symbol: providerSymbol,
                    targetSeconds: Number(windowStartSeconds),
                    radiusSeconds: fallbackRadiusSeconds,
                }),
                fetchHistoricalPointFromAlchemy({
                    config,
                    policy,
                    symbol: providerSymbol,
                    targetSeconds: Number(windowEndSeconds),
                    radiusSeconds: fallbackRadiusSeconds,
                }),
            ]);
        }
        const startPrice = startPoint.price;
        const endPrice = endPoint.price;
        if (startPrice <= 0 || endPrice <= 0) {
            throw new Error(`Historical valuation for ${symbol} returned non-positive price.`);
        }
        returnsBySymbol[symbol] = (endPrice - startPrice) / startPrice;
        pricesAtWindow[symbol] = {
            startPrice,
            endPrice,
        };
    }

    return {
        returnsBySymbol,
        pricesAtWindow,
    };
}

async function readCurrentBalances({ publicClient, policy, commitmentSafe, latestBlock }) {
    const balancesBySymbol = {};
    const decimalsBySymbol = {};
    for (const symbol of REIMBURSEMENT_SYMBOLS) {
        const token = policy.tokens[symbol];
        const [amountWei, decimals] = await Promise.all([
            publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [commitmentSafe],
                blockNumber: latestBlock,
            }),
            loadTokenDecimals({ publicClient, token }),
        ]);
        balancesBySymbol[symbol] = {
            amountWei: BigInt(amountWei),
        };
        decimalsBySymbol[symbol] = decimals;
    }
    return {
        balancesBySymbol,
        decimalsBySymbol,
    };
}

function priceMicrosFromFloat(value) {
    return BigInt(Math.max(1, Math.round(Number(value) * 1e6)));
}

function allocateReimbursementLegs({
    reimbursementOrder,
    balancesBySymbol,
    currentPriceMicrosBySymbol,
    decimalsBySymbol,
    reimbursementTargetUsdMicros,
}) {
    const reimbursementLegs = [];
    let remainingUsdMicros = BigInt(reimbursementTargetUsdMicros);
    let totalAvailableUsdMicros = 0n;

    for (const symbol of reimbursementOrder) {
        const priceMicros = currentPriceMicrosBySymbol[symbol];
        const amountWei = BigInt(balancesBySymbol[symbol]?.amountWei ?? 0n);
        if (amountWei <= 0n) continue;
        const availableUsdMicros = computeUsdValueMicros({
            amountWei,
            decimals: decimalsBySymbol[symbol],
            priceMicros,
        });
        if (availableUsdMicros <= 0n) continue;
        totalAvailableUsdMicros += availableUsdMicros;

        const desiredUsdMicros =
            availableUsdMicros <= remainingUsdMicros ? availableUsdMicros : remainingUsdMicros;
        const amountToUseWei =
            availableUsdMicros <= remainingUsdMicros
                ? amountWei
                : computeTokenAmountForUsdMicros({
                      usdMicros: desiredUsdMicros,
                      decimals: decimalsBySymbol[symbol],
                      priceMicros,
                  });
        if (amountToUseWei <= 0n) continue;

        const actualUsdMicros = computeUsdValueMicros({
            amountWei: amountToUseWei,
            decimals: decimalsBySymbol[symbol],
            priceMicros,
        });
        if (actualUsdMicros <= 0n) continue;

        reimbursementLegs.push({
            tokenSymbol: symbol,
            amountWei: amountToUseWei,
            usdNotionalMicros: actualUsdMicros,
        });
        remainingUsdMicros =
            remainingUsdMicros > actualUsdMicros ? remainingUsdMicros - actualUsdMicros : 0n;
        if (remainingUsdMicros === 0n) {
            break;
        }
    }

    return {
        reimbursementLegs,
        remainingUsdMicros,
        totalAvailableUsdMicros,
        reimbursedUsdMicros: BigInt(reimbursementTargetUsdMicros) - remainingUsdMicros,
    };
}

function buildExplanation({
    epochIndex,
    winnerSymbol,
    reimbursementLegs,
    windowStartSeconds,
    windowEndSeconds,
    returnsBySymbol,
    currentPriceMicrosBySymbol,
    depositUsdMicros,
    reimbursedUsdMicros,
}) {
    const fundingSymbols = reimbursementLegs.map((leg) => displaySymbol(leg.tokenSymbol)).join(',');
    return [
        `strategy=${STRATEGY_TAG}`,
        `epoch=${epochIndex}`,
        `winner=${displaySymbol(winnerSymbol)}`,
        `funding=${fundingSymbols}`,
        `windowStart=${windowStartSeconds.toString()}`,
        `windowEnd=${windowEndSeconds.toString()}`,
        `wethReturnBps=${encodeReturnBps(returnsBySymbol[CANONICAL_SYMBOLS.WETH])}`,
        `cbBtcReturnBps=${encodeReturnBps(returnsBySymbol[CANONICAL_SYMBOLS.CBBTC])}`,
        `usdcPriceMicros=${currentPriceMicrosBySymbol[CANONICAL_SYMBOLS.USDC].toString()}`,
        `wethPriceMicros=${currentPriceMicrosBySymbol[CANONICAL_SYMBOLS.WETH].toString()}`,
        `cbBtcPriceMicros=${currentPriceMicrosBySymbol[CANONICAL_SYMBOLS.CBBTC].toString()}`,
        `depositUsdMicros=${depositUsdMicros.toString()}`,
        `reimbursementUsdMicros=${reimbursedUsdMicros.toString()}`,
    ].join('|');
}

function buildReplayPlan({ pendingPlan, config }) {
    return {
        epochIndex: pendingPlan.epochIndex,
        winnerSymbol: pendingPlan.winnerSymbol,
        requiresDeposit: false,
        depositAsset: pendingPlan.depositAsset,
        depositAmountWei: pendingPlan.depositAmountWei,
        actions: pendingPlan.actions,
        transactions: buildOgTransactions(pendingPlan.actions, { config }),
        explanation: pendingPlan.explanation,
    };
}

async function buildMomentumPlan({
    signals,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal,
}) {
    const chainId = getConfigChainId(config) ?? (await publicClient.getChainId());
    const policy = resolvePolicyConfig(config, chainId);
    const safeAddress = normalizeAddress(commitmentSafe);
    const normalizedAgentAddress = normalizeAddress(agentAddress);
    const latestBlock = await publicClient.getBlockNumber();
    const latestBlockData = await publicClient.getBlock({ blockNumber: latestBlock });
    const nowSeconds = BigInt(latestBlockData.timestamp);

    const { statusesByEpoch, startBlock } = await reconcileStrategyState({
        config,
        policy,
        publicClient,
        latestBlock,
    });

    if (strategyState.pendingPlan) {
        if (onchainPendingProposal) {
            return null;
        }
        return buildReplayPlan({
            pendingPlan: strategyState.pendingPlan,
            config,
        });
    }

    const deploymentTimestampSeconds = BigInt(
        Math.floor((await getBlockTimestampMs(publicClient, startBlock, new Map())) / 1000)
    );
    const closedEpochIndex = computeClosedEpochIndex({
        nowSeconds,
        deploymentTimestampSeconds,
        epochSeconds: policy.epochSeconds,
    });
    if (closedEpochIndex < 0) {
        return null;
    }
    if (onchainPendingProposal) {
        return null;
    }
    if (strategyState.submittedEpochs.has(closedEpochIndex)) {
        return null;
    }
    const chainEpochStatus = statusesByEpoch.get(closedEpochIndex);
    if (chainEpochStatus && chainEpochStatus.status !== 'deleted') {
        return null;
    }

    const epochStartSeconds =
        deploymentTimestampSeconds + BigInt(closedEpochIndex * policy.epochSeconds);
    const epochEndSeconds =
        deploymentTimestampSeconds + BigInt((closedEpochIndex + 1) * policy.epochSeconds);

    const { returnsBySymbol, pricesAtWindow } = await resolveHistoricalReturns({
        config,
        policy,
        windowStartSeconds: epochStartSeconds,
        windowEndSeconds: epochEndSeconds,
    });
    const winnerSymbol = rankMomentumWinner({
        returnsBySymbol,
        tieBreakAssetOrder: policy.tieBreakAssetOrder,
    });
    const currentPricesBySymbol = await resolveCurrentPrices({
        config,
        policy,
    });
    const currentPriceMicrosBySymbol = {
        [CANONICAL_SYMBOLS.USDC]: priceMicrosFromFloat(currentPricesBySymbol[CANONICAL_SYMBOLS.USDC]),
        [CANONICAL_SYMBOLS.WETH]: priceMicrosFromFloat(currentPricesBySymbol[CANONICAL_SYMBOLS.WETH]),
        [CANONICAL_SYMBOLS.CBBTC]: priceMicrosFromFloat(currentPricesBySymbol[CANONICAL_SYMBOLS.CBBTC]),
    };
    const { balancesBySymbol, decimalsBySymbol } = await readCurrentBalances({
        publicClient,
        policy,
        commitmentSafe: safeAddress,
        latestBlock,
    });

    const depositDecimals = decimalsBySymbol[winnerSymbol];
    const depositAsset = policy.tokens[winnerSymbol];
    const depositAmountWei = computeTokenAmountForUsdMicros({
        usdMicros: policy.tradeAmountUsdMicros,
        decimals: depositDecimals,
        priceMicros: currentPriceMicrosBySymbol[winnerSymbol],
    });
    if (depositAmountWei <= 0n) {
        return null;
    }
    const depositUsdMicros = computeUsdValueMicros({
        amountWei: depositAmountWei,
        decimals: depositDecimals,
        priceMicros: currentPriceMicrosBySymbol[winnerSymbol],
    });
    if (depositUsdMicros <= 0n) {
        return null;
    }

    const reimbursementOrder = resolveFundingOrder({
        winnerSymbol,
        returnsBySymbol,
        balancesBySymbol,
    });
    const {
        reimbursementLegs,
        remainingUsdMicros,
        totalAvailableUsdMicros,
        reimbursedUsdMicros,
    } = allocateReimbursementLegs({
        reimbursementOrder,
        balancesBySymbol,
        currentPriceMicrosBySymbol,
        decimalsBySymbol,
        reimbursementTargetUsdMicros: depositUsdMicros,
    });
    if (reimbursementLegs.length === 0 || totalAvailableUsdMicros < depositUsdMicros) {
        return null;
    }
    if (reimbursedUsdMicros <= 0n) {
        return null;
    }

    const actions = reimbursementLegs.map((leg) => ({
        kind: 'erc20_transfer',
        token: policy.tokens[leg.tokenSymbol],
        to: normalizedAgentAddress,
        amountWei: leg.amountWei.toString(),
        operation: 0,
    }));
    const explanation = buildExplanation({
        epochIndex: closedEpochIndex,
        winnerSymbol,
        reimbursementLegs,
        windowStartSeconds: epochStartSeconds,
        windowEndSeconds: epochEndSeconds,
        returnsBySymbol,
        currentPriceMicrosBySymbol,
        depositUsdMicros,
        reimbursedUsdMicros,
    });
    const transactions = buildOgTransactions(actions, { config });

    return {
        epochIndex: closedEpochIndex,
        winnerSymbol,
        requiresDeposit: true,
        depositAsset,
        depositAmountWei: depositAmountWei.toString(),
        actions,
        transactions,
        explanation,
        returnsBySymbol,
        reimbursementLegs,
        pricesAtWindow,
        currentPriceMicrosBySymbol,
        depositUsdMicros,
        reimbursedUsdMicros,
        remainingUsdMicros,
    };
}

function getSystemPrompt({ commitmentText }) {
    return [
        'You are a deterministic first-proxy momentum agent.',
        'The runtime should rely on getDeterministicToolCalls() rather than LLM reasoning.',
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function augmentSignals(signals, { nowMs } = {}) {
    return [
        ...signals,
        {
            kind: 'deterministicTick',
            nowMs: nowMs ?? Date.now(),
        },
    ];
}

const getPollingOptions = getAlwaysEmitBalanceSnapshotPollingOptions;

function getPriceTriggers({ config }) {
    return [];
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal = false,
}) {
    const plan = await buildMomentumPlan({
        signals,
        commitmentSafe,
        agentAddress,
        publicClient,
        config,
        onchainPendingProposal,
    });
    if (!plan) {
        return [];
    }

    const toolCalls = [];
    if (plan.requiresDeposit) {
        toolCalls.push({
            callId: `first-proxy-deposit-epoch-${plan.epochIndex}`,
            name: 'make_deposit',
            arguments: JSON.stringify({
                asset: plan.depositAsset,
                amountWei: plan.depositAmountWei,
            }),
        });
    }
    toolCalls.push(
        {
            callId: `first-proxy-build-epoch-${plan.epochIndex}`,
            name: 'build_og_transactions',
            arguments: JSON.stringify({
                actions: plan.actions,
            }),
        },
        {
            callId: `first-proxy-propose-epoch-${plan.epochIndex}`,
            name: 'post_bond_and_propose',
            arguments: JSON.stringify({
                transactions: plan.transactions,
                explanation: plan.explanation,
            }),
        }
    );
    return toolCalls;
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch {
            return null;
        }
    }
    return null;
}

function getPriceMicrosFromExplanationFields(fields, symbol) {
    if (symbol === CANONICAL_SYMBOLS.USDC) {
        return MICRO_USD_SCALE;
    }
    const fieldName = symbol === CANONICAL_SYMBOLS.WETH ? 'wethPriceMicros' : 'cbBtcPriceMicros';
    return parseBigIntValue(fields[fieldName], fieldName);
}

async function validateToolCalls({
    toolCalls,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal,
}) {
    const chainId = getConfigChainId(config) ?? (await publicClient.getChainId());
    const policy = resolvePolicyConfig(config, chainId);
    const safeAddress = normalizeAddress(commitmentSafe);
    const normalizedAgentAddress = normalizeAddress(agentAddress);

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return [];
    }
    if (onchainPendingProposal) {
        throw new Error('Pending proposal exists onchain; wait before proposing again.');
    }

    const allowedNames = new Set(['make_deposit', 'build_og_transactions', 'post_bond_and_propose']);
    if (toolCalls.some((call) => call?.name && !allowedNames.has(call.name))) {
        throw new Error('first-proxy only allows make_deposit, build_og_transactions, and post_bond_and_propose.');
    }

    const hasDeposit = toolCalls.some((call) => call?.name === 'make_deposit');
    if (hasDeposit) {
        if (toolCalls.length !== 3) {
            throw new Error('Fresh first-proxy runs must include make_deposit, build_og_transactions, and post_bond_and_propose.');
        }
        if (
            toolCalls[0]?.name !== 'make_deposit' ||
            toolCalls[1]?.name !== 'build_og_transactions' ||
            toolCalls[2]?.name !== 'post_bond_and_propose'
        ) {
            throw new Error('first-proxy must execute make_deposit before build_og_transactions and post_bond_and_propose.');
        }
    } else {
        if (toolCalls.length !== 2) {
            throw new Error('Replay first-proxy runs must include build_og_transactions and post_bond_and_propose only.');
        }
        if (
            toolCalls[0]?.name !== 'build_og_transactions' ||
            toolCalls[1]?.name !== 'post_bond_and_propose'
        ) {
            throw new Error('Replay first-proxy runs must execute build_og_transactions before post_bond_and_propose.');
        }
    }

    const buildCall = toolCalls.find((call) => call?.name === 'build_og_transactions');
    const postCall = toolCalls.find((call) => call?.name === 'post_bond_and_propose');
    if (!buildCall || !postCall) {
        throw new Error('first-proxy requires build_og_transactions and post_bond_and_propose.');
    }

    const buildArgs = parseCallArgs(buildCall);
    const postArgs = parseCallArgs(postCall);
    if (!buildArgs || !Array.isArray(buildArgs.actions) || buildArgs.actions.length === 0) {
        throw new Error('build_og_transactions must include a non-empty actions array.');
    }
    if (!postArgs || !Array.isArray(postArgs.transactions)) {
        throw new Error('post_bond_and_propose must include transactions.');
    }
    if (typeof postArgs.explanation !== 'string' || !postArgs.explanation.trim()) {
        throw new Error('post_bond_and_propose must include a non-empty explanation.');
    }

    const normalizedExplanation = postArgs.explanation.trim();
    const explanationFields = parseExplanationFields(normalizedExplanation);
    const epochIndex = parseStrategyEpochFromExplanation(normalizedExplanation);
    if (epochIndex === null) {
        throw new Error('first-proxy proposal explanation must include strategy and epoch.');
    }
    const winnerSymbol = canonicalizeSymbol(explanationFields.winner);
    if (!MOMENTUM_SYMBOLS.includes(winnerSymbol)) {
        throw new Error('first-proxy winner must be WETH or cbBTC.');
    }

    const depositUsdMicros = parseBigIntValue(explanationFields.depositUsdMicros, 'depositUsdMicros');
    const reimbursementUsdMicros = parseBigIntValue(
        explanationFields.reimbursementUsdMicros,
        'reimbursementUsdMicros'
    );
    const normalizedActions = [];
    let computedReimbursementUsdMicros = 0n;
    for (const action of buildArgs.actions) {
        if (action?.kind !== 'erc20_transfer') {
            throw new Error('Only erc20_transfer reimbursement actions are allowed.');
        }
        const token = normalizeAddress(action.token);
        const to = normalizeAddress(action.to);
        const amountWei = BigInt(String(action.amountWei));
        if (amountWei <= 0n) {
            throw new Error('Reimbursement amountWei must be positive.');
        }
        if (to !== normalizedAgentAddress) {
            throw new Error('Reimbursement recipient must be agentAddress.');
        }
        const matchingSymbol = REIMBURSEMENT_SYMBOLS.find((symbol) => policy.tokens[symbol] === token);
        if (!matchingSymbol) {
            throw new Error('Reimbursement token is not allowlisted for first-proxy.');
        }
        if (matchingSymbol === winnerSymbol) {
            throw new Error('Winner asset cannot also be used as a reimbursement token.');
        }

        const decimals = await loadTokenDecimals({ publicClient, token });
        const priceMicros = getPriceMicrosFromExplanationFields(explanationFields, matchingSymbol);
        computedReimbursementUsdMicros += computeUsdValueMicros({
            amountWei,
            decimals,
            priceMicros,
        });

        normalizedActions.push({
            kind: 'erc20_transfer',
            token,
            to,
            amountWei: amountWei.toString(),
            operation: 0,
        });
    }

    if (computedReimbursementUsdMicros !== reimbursementUsdMicros) {
        throw new Error('Reimbursement actions do not match the explanation reimbursement value snapshot.');
    }
    if (computedReimbursementUsdMicros <= 0n) {
        throw new Error('Reimbursement value must be positive.');
    }
    if (computedReimbursementUsdMicros > depositUsdMicros) {
        throw new Error('Reimbursement value must not exceed the deposited winner-token value.');
    }

    let normalizedDepositCall = null;
    if (hasDeposit) {
        const depositCall = toolCalls[0];
        const depositArgs = parseCallArgs(depositCall);
        if (!depositArgs) {
            throw new Error('Invalid JSON arguments for make_deposit.');
        }
        const asset = normalizeAddress(depositArgs.asset);
        const amountWei = BigInt(String(depositArgs.amountWei));
        if (asset !== policy.tokens[winnerSymbol]) {
            throw new Error('make_deposit asset must match the explanation winner token.');
        }
        if (amountWei <= 0n) {
            throw new Error('make_deposit amountWei must be positive.');
        }
        const depositDecimals = await loadTokenDecimals({ publicClient, token: asset });
        const winnerPriceMicros = getPriceMicrosFromExplanationFields(explanationFields, winnerSymbol);
        const computedDepositUsdMicros = computeUsdValueMicros({
            amountWei,
            decimals: depositDecimals,
            priceMicros: winnerPriceMicros,
        });
        if (computedDepositUsdMicros !== depositUsdMicros) {
            throw new Error('make_deposit does not match the explanation deposit value snapshot.');
        }
        normalizedDepositCall = {
            name: 'make_deposit',
            callId: depositCall.callId,
            parsedArguments: {
                asset,
                amountWei: amountWei.toString(),
            },
        };
        lastValidatedPendingPlan = {
            epochIndex,
            winnerSymbol,
            depositAsset: asset,
            depositAmountWei: amountWei.toString(),
            actions: normalizedActions,
            explanation: normalizedExplanation,
            plannedAtMs: Date.now(),
        };
    } else {
        if (!strategyState.pendingPlan || strategyState.pendingPlan.epochIndex !== epochIndex) {
            throw new Error('Replay proposals require a matching persisted pending plan.');
        }
        lastValidatedPendingPlan = null;
    }

    const normalizedTransactions = buildOgTransactions(normalizedActions, { config });
    lastValidatedEpoch = epochIndex;

    return [
        ...(normalizedDepositCall ? [normalizedDepositCall] : []),
        {
            name: 'build_og_transactions',
            callId: buildCall.callId,
            parsedArguments: {
                actions: normalizedActions,
            },
        },
        {
            name: 'post_bond_and_propose',
            callId: postCall.callId,
            parsedArguments: {
                transactions: normalizedTransactions,
                explanation: normalizedExplanation,
            },
        },
    ];
}

async function onToolOutput({ name, parsedOutput, config }) {
    const status = String(parsedOutput?.status ?? '').trim().toLowerCase();
    const committed = Boolean(parsedOutput?.sideEffectsLikelyCommitted);
    const hasHash =
        Boolean(parsedOutput?.transactionHash) ||
        Boolean(parsedOutput?.proposalHash) ||
        Boolean(parsedOutput?.ogProposalHash);
    const successish = status === 'confirmed' || status === 'submitted' || status === 'pending' || committed || hasHash;

    if (name === 'make_deposit') {
        if (successish && lastValidatedPendingPlan) {
            await setPendingPlan({
                plan: lastValidatedPendingPlan,
                config,
            });
        }
        return;
    }

    if (name !== 'post_bond_and_propose' && name !== 'auto_post_bond_and_propose') {
        return;
    }
    if (lastValidatedEpoch === null || !successish) {
        return;
    }

    await markEpochSubmitted({
        epochIndex: lastValidatedEpoch,
        proposalHash: resolveSubmittedProposalHash(parsedOutput),
        config,
    });
    lastValidatedPendingPlan = null;
}

function resetStrategyState({ config } = {}) {
    const statePath = ensureStateScope(config);
    hydratedStatePath = statePath;
    strategyState.submittedEpochs = new Map();
    strategyState.pendingPlan = null;
    moduleCaches.currentPrices.clear();
    moduleCaches.historicalRanges.clear();
    lastValidatedEpoch = null;
    lastValidatedPendingPlan = null;
    void unlink(statePath).catch(() => {});
}

function getSubmittedEpochs() {
    return new Map(strategyState.submittedEpochs);
}

function getPendingPlan() {
    return strategyState.pendingPlan ? { ...strategyState.pendingPlan } : null;
}

export {
    augmentSignals,
    buildMomentumPlan,
    computeClosedEpochIndex,
    getDeterministicToolCalls,
    getPendingPlan,
    getPollingOptions,
    getPriceTriggers,
    getSubmittedEpochs,
    getSystemPrompt,
    onToolOutput,
    resetStrategyState,
    validateToolCalls,
};
