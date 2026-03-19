import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import {
    IPFS_ENV_OVERRIDES,
    MESSAGE_API_ENV_OVERRIDES,
    resolveIpfsEnvConfig,
    resolveMessageApiEnvConfig,
} from './config.js';

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function parseOptionalAddress(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate) {
        throw new Error(`${label} must be a non-empty address string`);
    }
    return getAddress(candidate);
}

function parseAddressArray(values, label) {
    if (!Array.isArray(values)) {
        throw new Error(`${label} must be an array of address strings`);
    }
    return values.map((value, index) => {
        const candidate = typeof value === 'string' ? value.trim() : '';
        if (!candidate) {
            throw new Error(`${label}[${index}] must be a non-empty address string`);
        }
        return getAddress(candidate);
    });
}

function parseBooleanValue(value, label) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
            throw new Error(`${label} must not be blank`);
        }
        return normalized !== 'false';
    }
    throw new Error(`${label} must be a boolean`);
}

function parseHostValue(value, label) {
    if (typeof value !== 'string') {
        throw new Error(`${label} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${label} must not be blank`);
    }
    return trimmed;
}

function parseIntegerValue(value, label, { min = undefined, max = undefined } = {}) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`${label} must be >= ${min}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`${label} must be <= ${max}`);
    }
    return parsed;
}

function parseBigIntValue(value, label, { min = undefined, max = undefined } = {}) {
    let parsed;
    try {
        parsed = BigInt(value);
    } catch (error) {
        throw new Error(`${label} must be an integer`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`${label} must be >= ${min.toString()}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`${label} must be <= ${max.toString()}`);
    }
    return parsed;
}

function parseStringValue(value, label) {
    if (typeof value !== 'string') {
        throw new Error(`${label} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${label} must not be blank`);
    }
    return trimmed;
}

function parseStringRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }

    const out = {};
    for (const [keyRaw, itemRaw] of Object.entries(value)) {
        const key = String(keyRaw).trim();
        if (!key) {
            throw new Error(`${label} includes empty key`);
        }
        if (typeof itemRaw !== 'string') {
            throw new Error(`${label} value for "${key}" must be a string`);
        }
        const normalizedValue = itemRaw.trim();
        if (!normalizedValue) {
            throw new Error(`${label} value for "${key}" must be non-empty`);
        }
        out[key] = normalizedValue;
    }
    return out;
}

function parseErc1155AssetArray(values, label) {
    if (!Array.isArray(values)) {
        throw new Error(`${label} must be an array`);
    }

    return values.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}[${index}] must be an object`);
        }
        const tokenRaw = typeof item.token === 'string' ? item.token.trim() : '';
        if (!tokenRaw) {
            throw new Error(`${label}[${index}].token must be a non-empty address string`);
        }

        const tokenIdRaw =
            typeof item.tokenId === 'string' || typeof item.tokenId === 'number'
                ? String(item.tokenId).trim()
                : '';
        if (!tokenIdRaw) {
            throw new Error(`${label}[${index}].tokenId must be a non-empty integer string`);
        }

        let normalizedTokenId;
        try {
            normalizedTokenId = BigInt(tokenIdRaw);
        } catch (error) {
            throw new Error(`${label}[${index}].tokenId must be a non-negative integer`);
        }
        if (normalizedTokenId < 0n) {
            throw new Error(`${label}[${index}].tokenId must be a non-negative integer`);
        }

        let symbol;
        if (item.symbol !== undefined && item.symbol !== null) {
            if (typeof item.symbol !== 'string') {
                throw new Error(`${label}[${index}].symbol must be a string`);
            }
            const trimmedSymbol = item.symbol.trim();
            if (trimmedSymbol) {
                symbol = trimmedSymbol;
            }
        }

        return {
            token: getAddress(tokenRaw),
            tokenId: normalizedTokenId.toString(),
            symbol,
        };
    });
}

function parseBondSpenderValue(value, label) {
    const normalized = parseStringValue(value, label).toLowerCase();
    if (normalized !== 'og' && normalized !== 'oo' && normalized !== 'both') {
        throw new Error(`${label} must be one of: og, oo, both`);
    }
    return normalized;
}

function parseFeeTierArrayValue(value, label) {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array of positive integers`);
    }

    return value.map((item, index) =>
        parseIntegerValue(item, `${label}[${index}]`, { min: 1 })
    );
}

const SHARED_RUNTIME_FIELD_DEFINITIONS = Object.freeze([
    ['pollIntervalMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['logChunkSize', (value, label) => parseBigIntValue(value, label, { min: 1n })],
    ['startBlock', (value, label) => parseBigIntValue(value, label, { min: 0n })],
    ['watchNativeBalance', parseBooleanValue],
    ['defaultDepositAsset', parseOptionalAddress],
    ['defaultDepositAmountWei', (value, label) => parseBigIntValue(value, label, { min: 0n })],
    ['bondSpender', parseBondSpenderValue],
    ['openAiModel', parseStringValue],
    ['openAiBaseUrl', parseHostValue],
    ['openAiRequestTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['allowProposeOnSimulationFail', parseBooleanValue],
    ['proposeGasLimit', (value, label) => parseBigIntValue(value, label, { min: 1n })],
    ['executeRetryMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['executePendingTxTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['proposeEnabled', parseBooleanValue],
    ['disputeEnabled', parseBooleanValue],
    ['disputeRetryMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['proposalHashResolveTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    [
        'proposalHashResolvePollIntervalMs',
        (value, label) => parseIntegerValue(value, label, { min: 1 }),
    ],
    ['chainlinkPriceFeed', parseOptionalAddress],
    ['polymarketConditionalTokens', parseOptionalAddress],
    ['polymarketExchange', parseOptionalAddress],
    ['polymarketClobEnabled', parseBooleanValue],
    ['polymarketClobHost', parseHostValue],
    ['polymarketClobAddress', parseOptionalAddress],
    ['polymarketClobSignatureType', parseStringValue],
    ['polymarketClobRequestTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['polymarketClobMaxRetries', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['polymarketClobRetryDelayMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['polymarketRelayerEnabled', parseBooleanValue],
    ['polymarketRelayerHost', parseHostValue],
    ['polymarketRelayerTxType', parseStringValue],
    ['polymarketRelayerFromAddress', parseOptionalAddress],
    ['polymarketRelayerSafeFactory', parseOptionalAddress],
    ['polymarketRelayerProxyFactory', parseOptionalAddress],
    ['polymarketRelayerResolveProxyAddress', parseBooleanValue],
    ['polymarketRelayerAutoDeployProxy', parseBooleanValue],
    ['polymarketRelayerChainId', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['polymarketRelayerRequestTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['polymarketRelayerPollIntervalMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['polymarketRelayerPollTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['uniswapV3Factory', parseOptionalAddress],
    ['uniswapV3Quoter', parseOptionalAddress],
    ['uniswapV3FeeTiers', parseFeeTierArrayValue],
    ['ipfsEnabled', parseBooleanValue],
    ['ipfsApiUrl', parseHostValue],
    ['ipfsRequestTimeoutMs', (value, label) => parseIntegerValue(value, label, { min: 1 })],
    ['ipfsMaxRetries', (value, label) => parseIntegerValue(value, label, { min: 0 })],
    ['ipfsRetryDelayMs', (value, label) => parseIntegerValue(value, label, { min: 0 })],
]);

const SHARED_RUNTIME_FIELD_KEYS = Object.freeze(
    SHARED_RUNTIME_FIELD_DEFINITIONS.map(([key]) => key)
);

function isPlainObjectValue(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigObjects(base, override) {
    if (!isPlainObjectValue(base)) {
        return isPlainObjectValue(override) ? { ...override } : override;
    }
    if (!isPlainObjectValue(override)) {
        return override === undefined ? { ...base } : override;
    }

    const merged = { ...base };
    for (const [key, overrideValue] of Object.entries(override)) {
        const baseValue = merged[key];
        if (isPlainObjectValue(baseValue) && isPlainObjectValue(overrideValue)) {
            merged[key] = mergeConfigObjects(baseValue, overrideValue);
        } else {
            merged[key] = overrideValue;
        }
    }
    return merged;
}

function pickConfigFields(source, keys) {
    const out = {};
    for (const key of keys) {
        out[key] = source?.[key];
    }
    return out;
}

function hasExplicitConfigValue(source, key) {
    return hasOwn(source, key) && source[key] !== undefined && source[key] !== null;
}

function resolveFieldOverride({ resolvedAgentConfig, baseConfig, key, label, parser }) {
    if (!hasOwn(resolvedAgentConfig, key)) {
        return baseConfig[key];
    }

    const rawValue = resolvedAgentConfig[key];
    const resolvedValue =
        rawValue === undefined || rawValue === null ? baseConfig[key] : parser(rawValue, label);
    resolvedAgentConfig[key] = resolvedValue;
    return resolvedValue;
}

function parseMessageApiOverride(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }

    const out = {};
    if (hasOwn(value, 'enabled')) {
        out.enabled = parseBooleanValue(value.enabled, `${label}.enabled`);
    }
    if (hasOwn(value, 'host')) {
        out.host = parseHostValue(value.host, `${label}.host`);
    }
    if (hasOwn(value, 'port')) {
        out.port = parseIntegerValue(value.port, `${label}.port`, { min: 1 });
    }
    if (hasOwn(value, 'keys')) {
        throw new Error(
            `${label}.keys is not supported in config.json; use MESSAGE_API_KEYS_JSON for secret bearer tokens`
        );
    }
    if (hasOwn(value, 'requireSignerAllowlist')) {
        out.requireSignerAllowlist = parseBooleanValue(
            value.requireSignerAllowlist,
            `${label}.requireSignerAllowlist`
        );
    }
    if (hasOwn(value, 'signerAllowlist')) {
        out.signerAllowlist = parseAddressArray(
            value.signerAllowlist,
            `${label}.signerAllowlist`
        );
    }
    if (hasOwn(value, 'signatureMaxAgeSeconds')) {
        out.signatureMaxAgeSeconds = parseIntegerValue(
            value.signatureMaxAgeSeconds,
            `${label}.signatureMaxAgeSeconds`,
            { min: 1 }
        );
    }
    if (hasOwn(value, 'maxBodyBytes')) {
        out.maxBodyBytes = parseIntegerValue(value.maxBodyBytes, `${label}.maxBodyBytes`, {
            min: 1,
        });
    }
    if (hasOwn(value, 'maxTextLength')) {
        out.maxTextLength = parseIntegerValue(
            value.maxTextLength,
            `${label}.maxTextLength`,
            { min: 1 }
        );
    }
    if (hasOwn(value, 'queueLimit')) {
        out.queueLimit = parseIntegerValue(value.queueLimit, `${label}.queueLimit`, {
            min: 1,
        });
    }
    if (hasOwn(value, 'batchSize')) {
        out.batchSize = parseIntegerValue(value.batchSize, `${label}.batchSize`, { min: 1 });
    }
    if (hasOwn(value, 'defaultTtlSeconds')) {
        out.defaultTtlSeconds = parseIntegerValue(
            value.defaultTtlSeconds,
            `${label}.defaultTtlSeconds`,
            { min: 1 }
        );
    }
    if (hasOwn(value, 'minTtlSeconds')) {
        out.minTtlSeconds = parseIntegerValue(value.minTtlSeconds, `${label}.minTtlSeconds`, {
            min: 1,
        });
    }
    if (hasOwn(value, 'maxTtlSeconds')) {
        out.maxTtlSeconds = parseIntegerValue(value.maxTtlSeconds, `${label}.maxTtlSeconds`, {
            min: 1,
        });
    }
    if (hasOwn(value, 'idempotencyTtlSeconds')) {
        out.idempotencyTtlSeconds = parseIntegerValue(
            value.idempotencyTtlSeconds,
            `${label}.idempotencyTtlSeconds`,
            { min: 1 }
        );
    }
    if (hasOwn(value, 'rateLimitPerMinute')) {
        out.rateLimitPerMinute = parseIntegerValue(
            value.rateLimitPerMinute,
            `${label}.rateLimitPerMinute`,
            { min: 0 }
        );
    }
    if (hasOwn(value, 'rateLimitBurst')) {
        out.rateLimitBurst = parseIntegerValue(
            value.rateLimitBurst,
            `${label}.rateLimitBurst`,
            { min: 0 }
        );
    }

    if (
        out.minTtlSeconds !== undefined &&
        out.maxTtlSeconds !== undefined &&
        out.maxTtlSeconds < out.minTtlSeconds
    ) {
        throw new Error(`${label}.maxTtlSeconds must be >= ${label}.minTtlSeconds`);
    }

    return out;
}

function resolveMessageApiRuntimeConfig({ baseConfig, override, label }) {
    const resolved = {
        messageApiEnabled: override?.enabled ?? baseConfig.messageApiEnabled,
        messageApiHost: override?.host ?? baseConfig.messageApiHost,
        messageApiPort: override?.port ?? baseConfig.messageApiPort,
        messageApiKeys: override?.keys ?? baseConfig.messageApiKeys,
        messageApiRequireSignerAllowlist:
            override?.requireSignerAllowlist ?? baseConfig.messageApiRequireSignerAllowlist,
        messageApiSignerAllowlist:
            override?.signerAllowlist ?? baseConfig.messageApiSignerAllowlist,
        messageApiSignatureMaxAgeSeconds:
            override?.signatureMaxAgeSeconds ?? baseConfig.messageApiSignatureMaxAgeSeconds,
        messageApiMaxBodyBytes: override?.maxBodyBytes ?? baseConfig.messageApiMaxBodyBytes,
        messageApiMaxTextLength: override?.maxTextLength ?? baseConfig.messageApiMaxTextLength,
        messageApiQueueLimit: override?.queueLimit ?? baseConfig.messageApiQueueLimit,
        messageApiBatchSize: override?.batchSize ?? baseConfig.messageApiBatchSize,
        messageApiDefaultTtlSeconds:
            override?.defaultTtlSeconds ?? baseConfig.messageApiDefaultTtlSeconds,
        messageApiMinTtlSeconds: override?.minTtlSeconds ?? baseConfig.messageApiMinTtlSeconds,
        messageApiMaxTtlSeconds: override?.maxTtlSeconds ?? baseConfig.messageApiMaxTtlSeconds,
        messageApiIdempotencyTtlSeconds:
            override?.idempotencyTtlSeconds ?? baseConfig.messageApiIdempotencyTtlSeconds,
        messageApiRateLimitPerMinute:
            override?.rateLimitPerMinute ?? baseConfig.messageApiRateLimitPerMinute,
        messageApiRateLimitBurst:
            override?.rateLimitBurst ?? baseConfig.messageApiRateLimitBurst,
    };

    if (resolved.messageApiDefaultTtlSeconds < resolved.messageApiMinTtlSeconds) {
        throw new Error(
            `${label}.defaultTtlSeconds must be >= ${label}.minTtlSeconds after resolving overrides`
        );
    }
    if (resolved.messageApiDefaultTtlSeconds > resolved.messageApiMaxTtlSeconds) {
        throw new Error(
            `${label}.defaultTtlSeconds must be <= ${label}.maxTtlSeconds after resolving overrides`
        );
    }
    if (resolved.messageApiMaxTtlSeconds < resolved.messageApiMinTtlSeconds) {
        throw new Error(
            `${label}.maxTtlSeconds must be >= ${label}.minTtlSeconds after resolving overrides`
        );
    }
    if (
        resolved.messageApiEnabled &&
        resolved.messageApiRequireSignerAllowlist &&
        resolved.messageApiSignerAllowlist.length === 0
    ) {
        throw new Error(
            `${label} requires signerAllowlist when enabled=true and requireSignerAllowlist=true`
        );
    }

    return resolved;
}

async function loadAgentConfigFile(configPath) {
    try {
        const raw = await readFile(configPath, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Invalid JSON in ${configPath}: ${error?.message ?? error}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`${configPath} must be a JSON object`);
        }
        return {
            exists: true,
            path: configPath,
            raw: parsed,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {
                exists: false,
                path: configPath,
                raw: null,
            };
        }
        throw error;
    }
}

function parseConfigOverlayEnvValue(rawValue) {
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(path.delimiter)
        .map((value) => value.trim())
        .filter(Boolean);
}

function resolveAgentConfigLayerPaths(
    configPath,
    { localConfigPath, overlayPaths, env = process.env } = {}
) {
    const primaryPath = path.resolve(configPath);
    const candidatePaths = [
        {
            kind: 'config',
            path: primaryPath,
        },
    ];

    const resolvedLocalPath =
        localConfigPath === undefined
            ? path.join(path.dirname(primaryPath), 'config.local.json')
            : localConfigPath;
    if (resolvedLocalPath) {
        candidatePaths.push({
            kind: 'local',
            path: path.resolve(resolvedLocalPath),
        });
    }

    const explicitOverlayPaths = Array.isArray(overlayPaths)
        ? overlayPaths
        : overlayPaths === undefined || overlayPaths === null
            ? []
            : [overlayPaths];
    const envOverlayPaths = [
        ...(env?.AGENT_CONFIG_OVERLAY_PATH
            ? [String(env.AGENT_CONFIG_OVERLAY_PATH).trim()]
            : []),
        ...parseConfigOverlayEnvValue(env?.AGENT_CONFIG_OVERLAY_PATHS),
    ];

    for (const overlayPath of [...explicitOverlayPaths, ...envOverlayPaths]) {
        if (!overlayPath) {
            continue;
        }
        candidatePaths.push({
            kind: 'overlay',
            path: path.resolve(overlayPath),
        });
    }

    const dedupedPaths = [];
    const seen = new Set();
    for (const candidate of candidatePaths) {
        const normalizedPath = path.resolve(candidate.path);
        if (seen.has(normalizedPath)) {
            continue;
        }
        seen.add(normalizedPath);
        dedupedPaths.push({
            kind: candidate.kind,
            path: normalizedPath,
        });
    }

    return dedupedPaths;
}

async function loadAgentConfigStack(
    configPath,
    { localConfigPath, overlayPaths, env = process.env } = {}
) {
    const layerPaths = resolveAgentConfigLayerPaths(configPath, {
        localConfigPath,
        overlayPaths,
        env,
    });
    const layers = [];
    let mergedRaw = null;

    for (const layer of layerPaths) {
        const loadedLayer = await loadAgentConfigFile(layer.path);
        const normalizedLayer = {
            ...loadedLayer,
            kind: layer.kind,
        };
        layers.push(normalizedLayer);
        if (normalizedLayer.exists && normalizedLayer.raw) {
            mergedRaw =
                mergedRaw === null
                    ? mergeConfigObjects({}, normalizedLayer.raw)
                    : mergeConfigObjects(mergedRaw, normalizedLayer.raw);
        }
    }

    const existingLayers = layers.filter((layer) => layer.exists);
    const sourceLabel =
        existingLayers.length > 0
            ? existingLayers.map((layer) => layer.path).join(' + ')
            : path.resolve(configPath);

    return {
        exists: existingLayers.length > 0,
        path: path.resolve(configPath),
        raw: mergedRaw,
        layers,
        sourceLabel,
    };
}

function resolveAgentRuntimeConfig({ baseConfig, agentConfigFile, chainId }) {
    const rawAgentConfig = agentConfigFile?.raw;
    if (!rawAgentConfig) {
        return {
            agentConfig: {},
            commitmentSafe: baseConfig.commitmentSafe,
            ogModule: baseConfig.ogModule,
            watchAssets: baseConfig.watchAssets,
            watchErc1155Assets: baseConfig.watchErc1155Assets,
            ...pickConfigFields(baseConfig, SHARED_RUNTIME_FIELD_KEYS),
            ipfsHeaders: baseConfig.ipfsHeaders,
            messageApiEnabled: baseConfig.messageApiEnabled,
            messageApiHost: baseConfig.messageApiHost,
            messageApiPort: baseConfig.messageApiPort,
            messageApiKeys: baseConfig.messageApiKeys,
            messageApiRequireSignerAllowlist: baseConfig.messageApiRequireSignerAllowlist,
            messageApiSignerAllowlist: baseConfig.messageApiSignerAllowlist,
            messageApiSignatureMaxAgeSeconds: baseConfig.messageApiSignatureMaxAgeSeconds,
            messageApiMaxBodyBytes: baseConfig.messageApiMaxBodyBytes,
            messageApiMaxTextLength: baseConfig.messageApiMaxTextLength,
            messageApiQueueLimit: baseConfig.messageApiQueueLimit,
            messageApiBatchSize: baseConfig.messageApiBatchSize,
            messageApiDefaultTtlSeconds: baseConfig.messageApiDefaultTtlSeconds,
            messageApiMinTtlSeconds: baseConfig.messageApiMinTtlSeconds,
            messageApiMaxTtlSeconds: baseConfig.messageApiMaxTtlSeconds,
            messageApiIdempotencyTtlSeconds: baseConfig.messageApiIdempotencyTtlSeconds,
            messageApiRateLimitPerMinute: baseConfig.messageApiRateLimitPerMinute,
            messageApiRateLimitBurst: baseConfig.messageApiRateLimitBurst,
        };
    }

    const configSourceLabel = agentConfigFile?.sourceLabel ?? agentConfigFile?.path ?? 'agent config';

    const { byChain, ...sharedConfig } = rawAgentConfig;
    if (byChain !== undefined && (!byChain || typeof byChain !== 'object' || Array.isArray(byChain))) {
        throw new Error(`${configSourceLabel} field "byChain" must be a JSON object`);
    }

    const chainKey = String(chainId);
    const chainOverrides = byChain?.[chainKey];
    if (
        chainOverrides !== undefined &&
        (!chainOverrides || typeof chainOverrides !== 'object' || Array.isArray(chainOverrides))
    ) {
        throw new Error(`${configSourceLabel} field "byChain.${chainKey}" must be a JSON object`);
    }

    const resolvedAgentConfig = mergeConfigObjects(sharedConfig, chainOverrides ?? {});
    const sharedMessageApi = parseMessageApiOverride(
        sharedConfig.messageApi,
        `${configSourceLabel} field "messageApi"`
    );
    const chainMessageApi = parseMessageApiOverride(
        chainOverrides?.messageApi,
        `${configSourceLabel} field "byChain.${chainKey}.messageApi"`
    );
    const mergedMessageApiOverride =
        sharedMessageApi || chainMessageApi
            ? {
                  ...(sharedMessageApi ?? {}),
                  ...(chainMessageApi ?? {}),
              }
            : undefined;
    const effectiveIpfsEnabled = hasExplicitConfigValue(resolvedAgentConfig, 'ipfsEnabled')
        ? parseBooleanValue(
              resolvedAgentConfig.ipfsEnabled,
              `${configSourceLabel} field "ipfsEnabled"`
          )
        : baseConfig.ipfsEnabled;
    if (hasOwn(resolvedAgentConfig, 'ipfsEnabled')) {
        resolvedAgentConfig.ipfsEnabled = effectiveIpfsEnabled;
    }
    const deferredIpfsBaseConfig =
        baseConfig[IPFS_ENV_OVERRIDES] === undefined
            ? { ipfsEnabled: effectiveIpfsEnabled }
            : resolveIpfsEnvConfig({
                  enabled: effectiveIpfsEnabled,
                  envOverrides: baseConfig[IPFS_ENV_OVERRIDES],
                  override: {
                      ipfsEnabled: effectiveIpfsEnabled,
                      ipfsApiUrl: hasExplicitConfigValue(resolvedAgentConfig, 'ipfsApiUrl')
                          ? resolvedAgentConfig.ipfsApiUrl
                          : undefined,
                      ipfsRequestTimeoutMs: hasExplicitConfigValue(
                          resolvedAgentConfig,
                          'ipfsRequestTimeoutMs'
                      )
                          ? resolvedAgentConfig.ipfsRequestTimeoutMs
                          : undefined,
                      ipfsMaxRetries: hasExplicitConfigValue(resolvedAgentConfig, 'ipfsMaxRetries')
                          ? resolvedAgentConfig.ipfsMaxRetries
                          : undefined,
                      ipfsRetryDelayMs: hasExplicitConfigValue(
                          resolvedAgentConfig,
                          'ipfsRetryDelayMs'
                      )
                          ? resolvedAgentConfig.ipfsRetryDelayMs
                          : undefined,
                  },
              });
    const runtimeBaseConfig = {
        ...baseConfig,
        ...deferredIpfsBaseConfig,
    };
    const effectiveMessageApiEnabled = mergedMessageApiOverride?.enabled ?? baseConfig.messageApiEnabled;
    const deferredMessageApiBaseConfig = {
        ...runtimeBaseConfig,
        ...(baseConfig[MESSAGE_API_ENV_OVERRIDES] === undefined
            ? { messageApiEnabled: effectiveMessageApiEnabled }
            : resolveMessageApiEnvConfig({
                  enabled: effectiveMessageApiEnabled,
                  envOverrides: baseConfig[MESSAGE_API_ENV_OVERRIDES],
                  override: mergedMessageApiOverride,
              })),
    };
    const resolvedMessageApi = resolveMessageApiRuntimeConfig({
        baseConfig: deferredMessageApiBaseConfig,
        override: mergedMessageApiOverride,
        label: `${configSourceLabel} field "messageApi"`,
    });

    const commitmentSafe = hasOwn(resolvedAgentConfig, 'commitmentSafe')
        ? (parseOptionalAddress(
              resolvedAgentConfig.commitmentSafe,
              `${configSourceLabel} field "commitmentSafe"`
          ) ?? baseConfig.commitmentSafe)
        : baseConfig.commitmentSafe;
    const ogModule = hasOwn(resolvedAgentConfig, 'ogModule')
        ? (parseOptionalAddress(
              resolvedAgentConfig.ogModule,
              `${configSourceLabel} field "ogModule"`
          ) ?? baseConfig.ogModule)
        : baseConfig.ogModule;

    const watchAssets = hasOwn(resolvedAgentConfig, 'watchAssets')
        ? parseAddressArray(
              resolvedAgentConfig.watchAssets,
              `${configSourceLabel} field "watchAssets"`
          )
        : baseConfig.watchAssets;
    const watchErc1155Assets = hasOwn(resolvedAgentConfig, 'watchErc1155Assets')
        ? parseErc1155AssetArray(
              resolvedAgentConfig.watchErc1155Assets,
              `${configSourceLabel} field "watchErc1155Assets"`
          )
        : baseConfig.watchErc1155Assets;
    const sharedRuntimeConfig = Object.fromEntries(
        SHARED_RUNTIME_FIELD_DEFINITIONS.map(([key, parser]) => [
            key,
            resolveFieldOverride({
                resolvedAgentConfig,
                baseConfig: runtimeBaseConfig,
                key,
                label: `${configSourceLabel} field "${key}"`,
                parser,
            }),
        ])
    );

    if (hasOwn(resolvedAgentConfig, 'watchAssets')) {
        resolvedAgentConfig.watchAssets = watchAssets;
    }
    if (hasOwn(resolvedAgentConfig, 'watchErc1155Assets')) {
        resolvedAgentConfig.watchErc1155Assets = watchErc1155Assets;
    }
    if (hasOwn(resolvedAgentConfig, 'commitmentSafe')) {
        resolvedAgentConfig.commitmentSafe = commitmentSafe;
    }
    if (hasOwn(resolvedAgentConfig, 'ogModule')) {
        resolvedAgentConfig.ogModule = ogModule;
    }
    if (mergedMessageApiOverride) {
        resolvedAgentConfig.messageApi = {
            enabled: resolvedMessageApi.messageApiEnabled,
            host: resolvedMessageApi.messageApiHost,
            port: resolvedMessageApi.messageApiPort,
            keys: resolvedMessageApi.messageApiKeys,
            requireSignerAllowlist: resolvedMessageApi.messageApiRequireSignerAllowlist,
            signerAllowlist: resolvedMessageApi.messageApiSignerAllowlist,
            signatureMaxAgeSeconds: resolvedMessageApi.messageApiSignatureMaxAgeSeconds,
            maxBodyBytes: resolvedMessageApi.messageApiMaxBodyBytes,
            maxTextLength: resolvedMessageApi.messageApiMaxTextLength,
            queueLimit: resolvedMessageApi.messageApiQueueLimit,
            batchSize: resolvedMessageApi.messageApiBatchSize,
            defaultTtlSeconds: resolvedMessageApi.messageApiDefaultTtlSeconds,
            minTtlSeconds: resolvedMessageApi.messageApiMinTtlSeconds,
            maxTtlSeconds: resolvedMessageApi.messageApiMaxTtlSeconds,
            idempotencyTtlSeconds: resolvedMessageApi.messageApiIdempotencyTtlSeconds,
            rateLimitPerMinute: resolvedMessageApi.messageApiRateLimitPerMinute,
            rateLimitBurst: resolvedMessageApi.messageApiRateLimitBurst,
        };
    }

    return {
        agentConfig: resolvedAgentConfig,
        commitmentSafe,
        ogModule,
        watchAssets,
        watchErc1155Assets,
        ...sharedRuntimeConfig,
        ipfsHeaders: runtimeBaseConfig.ipfsHeaders,
        ...resolvedMessageApi,
    };
}

export {
    loadAgentConfigFile,
    loadAgentConfigStack,
    resolveAgentConfigLayerPaths,
    resolveAgentRuntimeConfig,
};
