import { erc20Abi, getAddress, parseAbi, zeroAddress } from 'viem';

const uniswapV3PoolAbi = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function liquidity() view returns (uint128)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const uniswapV3FactoryAbi = parseAbi([
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const defaultFactoryByChainId = new Map([
    [1, '0x1F98431c8aD98523631AE4a59f267346ea31F984'],
    [11155111, '0x0227628f3F023bb0B980b67D528571c95c6DaC1c'],
]);

async function getFactoryAddress({ publicClient, configuredFactory }) {
    if (configuredFactory) return configuredFactory;
    const chainId = await publicClient.getChainId();
    const factory = defaultFactoryByChainId.get(chainId);
    if (!factory) {
        throw new Error(
            `No Uniswap V3 factory configured for chainId ${chainId}. Set UNISWAP_V3_FACTORY.`
        );
    }
    return getAddress(factory);
}

async function loadPoolMeta({ publicClient, pool, tokenMetaCache, poolMetaCache }) {
    const cached = poolMetaCache.get(pool);
    if (cached) return cached;

    const [token0, token1, fee] = await Promise.all([
        publicClient.readContract({
            address: pool,
            abi: uniswapV3PoolAbi,
            functionName: 'token0',
        }),
        publicClient.readContract({
            address: pool,
            abi: uniswapV3PoolAbi,
            functionName: 'token1',
        }),
        publicClient.readContract({
            address: pool,
            abi: uniswapV3PoolAbi,
            functionName: 'fee',
        }),
    ]);

    const [normalizedToken0, normalizedToken1] = [getAddress(token0), getAddress(token1)];

    const ensureDecimals = async (token) => {
        if (tokenMetaCache.has(token)) return tokenMetaCache.get(token);
        const decimals = Number(
            await publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'decimals',
            })
        );
        tokenMetaCache.set(token, { decimals });
        return tokenMetaCache.get(token);
    };

    await Promise.all([ensureDecimals(normalizedToken0), ensureDecimals(normalizedToken1)]);

    const meta = {
        token0: normalizedToken0,
        token1: normalizedToken1,
        fee: Number(fee),
    };
    poolMetaCache.set(pool, meta);
    return meta;
}

async function resolvePoolForTrigger({
    publicClient,
    trigger,
    config,
    resolvedPoolCache,
}) {
    const baseToken = getAddress(trigger.baseToken);
    const quoteToken = getAddress(trigger.quoteToken);
    const cacheKey = `${baseToken}:${quoteToken}:${trigger.pool ?? trigger.poolSelection ?? ''}`;
    if (resolvedPoolCache.has(cacheKey)) {
        return resolvedPoolCache.get(cacheKey);
    }

    if (trigger.pool) {
        const resolved = { pool: getAddress(trigger.pool) };
        resolvedPoolCache.set(cacheKey, resolved);
        return resolved;
    }

    if (trigger.poolSelection !== 'high-liquidity') {
        throw new Error(
            `Trigger ${trigger.id} must provide pool or poolSelection=high-liquidity`
        );
    }

    const factory = await getFactoryAddress({
        publicClient,
        configuredFactory: config.uniswapV3Factory,
    });

    let best = null;
    for (const feeTier of config.uniswapV3FeeTiers ?? [500, 3000, 10000]) {
        const pool = await publicClient.readContract({
            address: factory,
            abi: uniswapV3FactoryAbi,
            functionName: 'getPool',
            args: [baseToken, quoteToken, Number(feeTier)],
        });

        if (!pool || getAddress(pool) === zeroAddress) {
            continue;
        }

        const normalizedPool = getAddress(pool);
        const liquidity = await publicClient.readContract({
            address: normalizedPool,
            abi: uniswapV3PoolAbi,
            functionName: 'liquidity',
        });

        if (!best || BigInt(liquidity) > best.liquidity) {
            best = {
                pool: normalizedPool,
                liquidity: BigInt(liquidity),
            };
        }
    }

    if (!best) {
        throw new Error(
            `No Uniswap V3 pool found for ${baseToken}/${quoteToken} across fee tiers.`
        );
    }

    const resolved = { pool: best.pool };
    resolvedPoolCache.set(cacheKey, resolved);
    return resolved;
}

function quotePerBaseFromSqrtPriceX96({ sqrtPriceX96, token0Decimals, token1Decimals, baseIsToken0 }) {
    const sqrt = Number(sqrtPriceX96);
    if (!Number.isFinite(sqrt) || sqrt <= 0) {
        throw new Error('Invalid sqrtPriceX96 from pool slot0.');
    }

    const q192 = 2 ** 192;
    const rawToken1PerToken0 = (sqrt * sqrt) / q192;

    if (baseIsToken0) {
        return rawToken1PerToken0 * 10 ** (token0Decimals - token1Decimals);
    }

    if (rawToken1PerToken0 === 0) {
        throw new Error('Pool price resolved to zero.');
    }

    return (1 / rawToken1PerToken0) * 10 ** (token1Decimals - token0Decimals);
}

function evaluateComparator({ comparator, price, threshold }) {
    if (comparator === 'gte') return price >= threshold;
    if (comparator === 'lte') return price <= threshold;
    throw new Error(`Unsupported comparator: ${comparator}`);
}

async function collectPriceTriggerSignals({
    publicClient,
    config,
    triggers,
    nowMs,
    triggerState,
    tokenMetaCache,
    poolMetaCache,
    resolvedPoolCache,
}) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
        return [];
    }

    const evaluations = [];

    for (const trigger of triggers) {
        const triggerId = trigger && typeof trigger === 'object' && trigger.id !== undefined
            ? String(trigger.id)
            : 'unknown-trigger';
        if (!trigger || typeof trigger !== 'object') {
            console.warn(`[agent] Price trigger ${triggerId} skipped: malformed trigger entry.`);
            continue;
        }
        try {
            const baseToken = getAddress(trigger.baseToken);
            const quoteToken = getAddress(trigger.quoteToken);

            const resolved = await resolvePoolForTrigger({
                publicClient,
                trigger,
                config,
                resolvedPoolCache,
            });
            const pool = resolved.pool;

            const poolMeta = await loadPoolMeta({
                publicClient,
                pool,
                tokenMetaCache,
                poolMetaCache,
            });

            const baseIsToken0 = poolMeta.token0 === baseToken && poolMeta.token1 === quoteToken;
            const baseIsToken1 = poolMeta.token1 === baseToken && poolMeta.token0 === quoteToken;

            if (!baseIsToken0 && !baseIsToken1) {
                console.warn(
                    `[agent] Price trigger ${trigger.id} skipped: pool ${pool} does not match base/quote tokens.`
                );
                continue;
            }

            const slot0 = await publicClient.readContract({
                address: pool,
                abi: uniswapV3PoolAbi,
                functionName: 'slot0',
            });

            const token0Meta = tokenMetaCache.get(poolMeta.token0);
            const token1Meta = tokenMetaCache.get(poolMeta.token1);

            const price = quotePerBaseFromSqrtPriceX96({
                sqrtPriceX96: slot0[0],
                token0Decimals: token0Meta.decimals,
                token1Decimals: token1Meta.decimals,
                baseIsToken0,
            });

            const matches = evaluateComparator({
                comparator: trigger.comparator,
                price,
                threshold: trigger.threshold,
            });

            const prior = triggerState.get(trigger.id) ?? {
                fired: false,
                lastMatched: false,
            };

            const shouldEmit = matches && (!prior.lastMatched || (!trigger.emitOnce && !prior.fired));

            triggerState.set(trigger.id, {
                fired: prior.fired || (matches && trigger.emitOnce),
                lastMatched: matches,
            });

            if (!shouldEmit || (trigger.emitOnce && prior.fired)) {
                continue;
            }

            evaluations.push({
                kind: 'priceTrigger',
                triggerId: trigger.id,
                triggerLabel: trigger.label,
                priority: trigger.priority ?? 0,
                pool,
                poolFee: poolMeta.fee,
                baseToken,
                quoteToken,
                comparator: trigger.comparator,
                threshold: trigger.threshold,
                observedPrice: price,
                triggerTimestampMs: nowMs,
            });
        } catch (error) {
            console.warn(`[agent] Price trigger ${triggerId} skipped:`, error?.message ?? error);
            continue;
        }
    }

    evaluations.sort((a, b) => {
        const priorityOrder = Number(a.priority) - Number(b.priority);
        if (priorityOrder !== 0) return priorityOrder;
        return String(a.triggerId).localeCompare(String(b.triggerId));
    });

    return evaluations;
}

export { collectPriceTriggerSignals };
