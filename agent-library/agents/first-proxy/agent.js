import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, hexToString, parseAbi } from 'viem';
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
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import {
    normalizeAddressOrNull,
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
const POOL_ABI = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const MICRO_USD_SCALE = 1_000_000n;
const STRATEGY_TAG = 'first-proxy-momentum';
const moduleCaches = {
    deployment: new Map(),
    poolMeta: new Map(),
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

function normalizeValuationPools(rawPools, tokens) {
    const out = {};
    for (const symbol of MOMENTUM_SYMBOLS) {
        const entry = rawPools?.[symbol] ?? rawPools?.[displaySymbol(symbol)] ?? null;
        if (!entry) continue;
        const pool = typeof entry === 'string' ? entry : entry.pool;
        out[symbol] = {
            pool: normalizeAddress(pool),
            baseToken: normalizeAddress(entry.baseToken ?? tokens[symbol]),
            quoteToken: normalizeAddress(entry.quoteToken ?? tokens[CANONICAL_SYMBOLS.USDC]),
        };
    }
    return out;
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
    const valuationPools = normalizeValuationPools(rawPolicy?.valuationPools ?? {}, tokens);
    if (!valuationPools[CANONICAL_SYMBOLS.WETH] || !valuationPools[CANONICAL_SYMBOLS.CBBTC]) {
        throw new Error('first-proxy requires valuationPools for WETH and cbBTC.');
    }
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
        valuationPools,
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

async function loadPoolMeta({ publicClient, pool }) {
    const cacheKey = pool.toLowerCase();
    if (moduleCaches.poolMeta.has(cacheKey)) {
        return moduleCaches.poolMeta.get(cacheKey);
    }

    const [token0, token1] = await Promise.all([
        publicClient.readContract({
            address: pool,
            abi: POOL_ABI,
            functionName: 'token0',
        }),
        publicClient.readContract({
            address: pool,
            abi: POOL_ABI,
            functionName: 'token1',
        }),
    ]);

    const normalizedToken0 = normalizeAddress(token0);
    const normalizedToken1 = normalizeAddress(token1);
    const [token0Decimals, token1Decimals] = await Promise.all([
        loadTokenDecimals({ publicClient, token: normalizedToken0 }),
        loadTokenDecimals({ publicClient, token: normalizedToken1 }),
    ]);

    const meta = {
        token0: normalizedToken0,
        token1: normalizedToken1,
        token0Decimals,
        token1Decimals,
    };
    moduleCaches.poolMeta.set(cacheKey, meta);
    return meta;
}

function quotePerBaseFromSqrtPriceX96({
    sqrtPriceX96,
    token0Decimals,
    token1Decimals,
    baseIsToken0,
}) {
    const sqrt = Number(sqrtPriceX96);
    if (!Number.isFinite(sqrt) || sqrt <= 0) {
        throw new Error('Invalid sqrtPriceX96.');
    }
    const rawToken1PerToken0 = (sqrt * sqrt) / 2 ** 192;
    if (baseIsToken0) {
        return rawToken1PerToken0 * 10 ** (token0Decimals - token1Decimals);
    }
    if (rawToken1PerToken0 === 0) {
        throw new Error('Pool price resolved to zero.');
    }
    return (1 / rawToken1PerToken0) * 10 ** (token1Decimals - token0Decimals);
}

async function readPoolPriceQuotePerBase({
    publicClient,
    pool,
    baseToken,
    quoteToken,
    blockNumber,
}) {
    const meta = await loadPoolMeta({ publicClient, pool });
    const base = normalizeAddress(baseToken);
    const quote = normalizeAddress(quoteToken);
    const baseIsToken0 = meta.token0 === base && meta.token1 === quote;
    const baseIsToken1 = meta.token1 === base && meta.token0 === quote;
    if (!baseIsToken0 && !baseIsToken1) {
        throw new Error(`Pool ${pool} does not match requested base/quote tokens.`);
    }
    const slot0 = await publicClient.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: 'slot0',
        blockNumber,
    });
    return quotePerBaseFromSqrtPriceX96({
        sqrtPriceX96: slot0[0],
        token0Decimals: meta.token0Decimals,
        token1Decimals: meta.token1Decimals,
        baseIsToken0,
    });
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
    signals,
    publicClient,
    policy,
    latestBlock,
}) {
    const pricesBySymbol = {};
    for (const signal of signals ?? []) {
        if (signal?.kind !== 'priceTrigger') continue;
        const baseToken = normalizeAddressOrNull(signal?.baseToken, { requireHex: false });
        if (!baseToken) continue;
        for (const symbol of MOMENTUM_SYMBOLS) {
            if (baseToken === policy.tokens[symbol]) {
                const observedPrice = Number(signal?.observedPrice);
                if (Number.isFinite(observedPrice) && observedPrice > 0) {
                    pricesBySymbol[symbol] = observedPrice;
                }
            }
        }
    }

    for (const symbol of MOMENTUM_SYMBOLS) {
        if (Number.isFinite(pricesBySymbol[symbol]) && pricesBySymbol[symbol] > 0) {
            continue;
        }
        const valuation = policy.valuationPools[symbol];
        pricesBySymbol[symbol] = await readPoolPriceQuotePerBase({
            publicClient,
            pool: valuation.pool,
            baseToken: valuation.baseToken,
            quoteToken: valuation.quoteToken,
            blockNumber: latestBlock,
        });
    }
    pricesBySymbol[CANONICAL_SYMBOLS.USDC] = 1;
    return pricesBySymbol;
}

async function resolveHistoricalReturns({
    publicClient,
    policy,
    startBlock,
    latestBlock,
    windowStartSeconds,
    windowEndSeconds,
}) {
    const blockTimestampCache = new Map();
    const windowStartBlock =
        windowStartSeconds === 0n
            ? startBlock
            : await findBlockAtOrBeforeTimestamp({
                  publicClient,
                  fromBlock: startBlock,
                  toBlock: latestBlock,
                  targetTimestampSeconds: windowStartSeconds,
                  cache: blockTimestampCache,
              });
    const windowEndBlock = await findBlockAtOrBeforeTimestamp({
        publicClient,
        fromBlock: startBlock,
        toBlock: latestBlock,
        targetTimestampSeconds: windowEndSeconds,
        cache: blockTimestampCache,
    });

    const returnsBySymbol = {
        [CANONICAL_SYMBOLS.USDC]: 0,
    };
    const pricesAtWindow = {};

    for (const symbol of MOMENTUM_SYMBOLS) {
        const valuation = policy.valuationPools[symbol];
        const [startPrice, endPrice] = await Promise.all([
            readPoolPriceQuotePerBase({
                publicClient,
                pool: valuation.pool,
                baseToken: valuation.baseToken,
                quoteToken: valuation.quoteToken,
                blockNumber: windowStartBlock,
            }),
            readPoolPriceQuotePerBase({
                publicClient,
                pool: valuation.pool,
                baseToken: valuation.baseToken,
                quoteToken: valuation.quoteToken,
                blockNumber: windowEndBlock,
            }),
        ]);
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
        publicClient,
        policy,
        startBlock,
        latestBlock,
        windowStartSeconds: epochStartSeconds,
        windowEndSeconds: epochEndSeconds,
    });
    const winnerSymbol = rankMomentumWinner({
        returnsBySymbol,
        tieBreakAssetOrder: policy.tieBreakAssetOrder,
    });
    const currentPricesBySymbol = await resolveCurrentPrices({
        signals,
        publicClient,
        policy,
        latestBlock,
    });
    const currentPriceMicrosBySymbol = {
        [CANONICAL_SYMBOLS.USDC]: MICRO_USD_SCALE,
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

function getPriceTriggers({ config }) {
    try {
        const policy = resolvePolicyConfig(config, getConfigChainId(config));
        return MOMENTUM_SYMBOLS.map((symbol, index) => ({
            id: `first-proxy-heartbeat-${symbol}`,
            label: `First Proxy ${displaySymbol(symbol)} heartbeat`,
            pool: policy.valuationPools[symbol].pool,
            baseToken: policy.tokens[symbol],
            quoteToken: policy.tokens[CANONICAL_SYMBOLS.USDC],
            comparator: 'gte',
            threshold: 0,
            priority: index,
            emitOnce: false,
        }));
    } catch {
        return [];
    }
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
    buildMomentumPlan,
    computeClosedEpochIndex,
    getDeterministicToolCalls,
    getPendingPlan,
    getPriceTriggers,
    getSubmittedEpochs,
    getSystemPrompt,
    onToolOutput,
    resetStrategyState,
    validateToolCalls,
};
