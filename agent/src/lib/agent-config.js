import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import {
    IPFS_ENV_OVERRIDES,
    MESSAGE_API_ENV_OVERRIDES,
    MESSAGE_PUBLISH_API_ENV_OVERRIDES,
    PROPOSAL_PUBLISH_API_ENV_OVERRIDES,
    resolveIpfsEnvConfig,
    resolveMessageApiEnvConfig,
    resolveMessagePublishApiEnvConfig,
    resolveProposalPublishApiEnvConfig,
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

function parseProposalPublishModeValue(value, label) {
    const normalized = parseStringValue(value, label).toLowerCase();
    if (normalized !== 'publish' && normalized !== 'propose') {
        throw new Error(`${label} must be one of: publish, propose`);
    }
    return normalized;
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

function parseChainIdValue(value, label) {
    return parseIntegerValue(value, label, { min: 1 });
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

const CORE_RUNTIME_FIELD_DEFINITIONS = Object.freeze([
    { key: 'commitmentSafe', parser: parseOptionalAddress },
    { key: 'ogModule', parser: parseOptionalAddress },
    { key: 'watchAssets', parser: parseAddressArray },
    { key: 'watchErc1155Assets', parser: parseErc1155AssetArray },
]);

const SHARED_RUNTIME_FIELD_DEFINITIONS = Object.freeze([
    { key: 'rpcUrl', parser: parseHostValue },
    { key: 'pollIntervalMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'logChunkSize', parser: (value, label) => parseBigIntValue(value, label, { min: 1n }) },
    { key: 'startBlock', parser: (value, label) => parseBigIntValue(value, label, { min: 0n }) },
    { key: 'watchNativeBalance', parser: parseBooleanValue },
    { key: 'defaultDepositAsset', parser: parseOptionalAddress },
    { key: 'defaultDepositAmountWei', parser: (value, label) => parseBigIntValue(value, label, { min: 0n }) },
    { key: 'bondSpender', parser: parseBondSpenderValue },
    { key: 'openAiModel', parser: parseStringValue },
    { key: 'openAiBaseUrl', parser: parseHostValue },
    { key: 'openAiRequestTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'allowProposeOnSimulationFail', parser: parseBooleanValue },
    { key: 'proposeGasLimit', parser: (value, label) => parseBigIntValue(value, label, { min: 1n }) },
    { key: 'executeRetryMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'executePendingTxTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'proposeEnabled', parser: parseBooleanValue },
    { key: 'disputeEnabled', parser: parseBooleanValue },
    { key: 'disputeRetryMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'proposalHashResolveTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    {
        key: 'proposalHashResolvePollIntervalMs',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    { key: 'chainlinkPriceFeed', parser: parseOptionalAddress },
    { key: 'polymarketConditionalTokens', parser: parseOptionalAddress },
    { key: 'polymarketExchange', parser: parseOptionalAddress },
    { key: 'polymarketClobEnabled', parser: parseBooleanValue },
    { key: 'polymarketClobHost', parser: parseHostValue },
    { key: 'polymarketClobAddress', parser: parseOptionalAddress },
    { key: 'polymarketClobSignatureType', parser: parseStringValue },
    { key: 'polymarketClobRequestTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'polymarketClobMaxRetries', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'polymarketClobRetryDelayMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'polymarketRelayerEnabled', parser: parseBooleanValue },
    { key: 'polymarketRelayerHost', parser: parseHostValue },
    { key: 'polymarketRelayerTxType', parser: parseStringValue },
    { key: 'polymarketRelayerFromAddress', parser: parseOptionalAddress },
    { key: 'polymarketRelayerSafeFactory', parser: parseOptionalAddress },
    { key: 'polymarketRelayerProxyFactory', parser: parseOptionalAddress },
    { key: 'polymarketRelayerResolveProxyAddress', parser: parseBooleanValue },
    { key: 'polymarketRelayerAutoDeployProxy', parser: parseBooleanValue },
    { key: 'polymarketRelayerChainId', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'polymarketRelayerRequestTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'polymarketRelayerPollIntervalMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'polymarketRelayerPollTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'uniswapV3Factory', parser: parseOptionalAddress },
    { key: 'uniswapV3Quoter', parser: parseOptionalAddress },
    { key: 'uniswapV3FeeTiers', parser: parseFeeTierArrayValue },
    { key: 'ipfsEnabled', parser: parseBooleanValue },
    { key: 'ipfsApiUrl', parser: parseHostValue },
    { key: 'ipfsRequestTimeoutMs', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    { key: 'ipfsMaxRetries', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
    { key: 'ipfsRetryDelayMs', parser: (value, label) => parseIntegerValue(value, label, { min: 0 }) },
]);

const MESSAGE_API_FIELD_DEFINITIONS = Object.freeze([
    { key: 'enabled', runtimeKey: 'messageApiEnabled', parser: parseBooleanValue },
    { key: 'host', runtimeKey: 'messageApiHost', parser: parseHostValue },
    { key: 'port', runtimeKey: 'messageApiPort', parser: (value, label) => parseIntegerValue(value, label, { min: 1 }) },
    {
        key: 'requireSignerAllowlist',
        runtimeKey: 'messageApiRequireSignerAllowlist',
        parser: parseBooleanValue,
    },
    {
        key: 'signerAllowlist',
        runtimeKey: 'messageApiSignerAllowlist',
        parser: parseAddressArray,
    },
    {
        key: 'signatureMaxAgeSeconds',
        runtimeKey: 'messageApiSignatureMaxAgeSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'maxBodyBytes',
        runtimeKey: 'messageApiMaxBodyBytes',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'maxTextLength',
        runtimeKey: 'messageApiMaxTextLength',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'queueLimit',
        runtimeKey: 'messageApiQueueLimit',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'batchSize',
        runtimeKey: 'messageApiBatchSize',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'defaultTtlSeconds',
        runtimeKey: 'messageApiDefaultTtlSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'minTtlSeconds',
        runtimeKey: 'messageApiMinTtlSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'maxTtlSeconds',
        runtimeKey: 'messageApiMaxTtlSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'idempotencyTtlSeconds',
        runtimeKey: 'messageApiIdempotencyTtlSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'rateLimitPerMinute',
        runtimeKey: 'messageApiRateLimitPerMinute',
        parser: (value, label) => parseIntegerValue(value, label, { min: 0 }),
    },
    {
        key: 'rateLimitBurst',
        runtimeKey: 'messageApiRateLimitBurst',
        parser: (value, label) => parseIntegerValue(value, label, { min: 0 }),
    },
]);

const PROPOSAL_PUBLISH_API_FIELD_DEFINITIONS = Object.freeze([
    { key: 'enabled', runtimeKey: 'proposalPublishApiEnabled', parser: parseBooleanValue },
    { key: 'host', runtimeKey: 'proposalPublishApiHost', parser: parseHostValue },
    {
        key: 'port',
        runtimeKey: 'proposalPublishApiPort',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'mode',
        runtimeKey: 'proposalPublishApiMode',
        parser: parseProposalPublishModeValue,
    },
    {
        key: 'requireSignerAllowlist',
        runtimeKey: 'proposalPublishApiRequireSignerAllowlist',
        parser: parseBooleanValue,
    },
    {
        key: 'signerAllowlist',
        runtimeKey: 'proposalPublishApiSignerAllowlist',
        parser: parseAddressArray,
    },
    {
        key: 'signatureMaxAgeSeconds',
        runtimeKey: 'proposalPublishApiSignatureMaxAgeSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'maxBodyBytes',
        runtimeKey: 'proposalPublishApiMaxBodyBytes',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'stateFile',
        runtimeKey: 'proposalPublishApiStateFile',
        parser: parseStringValue,
    },
    {
        key: 'nodeName',
        runtimeKey: 'proposalPublishApiNodeName',
        parser: parseStringValue,
    },
]);

const MESSAGE_PUBLISH_API_FIELD_DEFINITIONS = Object.freeze([
    { key: 'enabled', runtimeKey: 'messagePublishApiEnabled', parser: parseBooleanValue },
    { key: 'host', runtimeKey: 'messagePublishApiHost', parser: parseHostValue },
    {
        key: 'port',
        runtimeKey: 'messagePublishApiPort',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'requireSignerAllowlist',
        runtimeKey: 'messagePublishApiRequireSignerAllowlist',
        parser: parseBooleanValue,
    },
    {
        key: 'signerAllowlist',
        runtimeKey: 'messagePublishApiSignerAllowlist',
        parser: parseAddressArray,
    },
    {
        key: 'signatureMaxAgeSeconds',
        runtimeKey: 'messagePublishApiSignatureMaxAgeSeconds',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'maxBodyBytes',
        runtimeKey: 'messagePublishApiMaxBodyBytes',
        parser: (value, label) => parseIntegerValue(value, label, { min: 1 }),
    },
    {
        key: 'stateFile',
        runtimeKey: 'messagePublishApiStateFile',
        parser: parseStringValue,
    },
    {
        key: 'nodeName',
        runtimeKey: 'messagePublishApiNodeName',
        parser: parseStringValue,
    },
]);

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

function parseObjectWithFieldDefinitions(value, label, definitions) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }

    const out = {};
    for (const definition of definitions) {
        if (!hasOwn(value, definition.key)) {
            continue;
        }
        const rawFieldValue = value[definition.key];
        out[definition.key] =
            rawFieldValue === undefined || rawFieldValue === null
                ? rawFieldValue
                : definition.parser(rawFieldValue, `${label}.${definition.key}`);
    }
    return out;
}

function resolveFieldDefinitions({ definitions, resolvedAgentConfig, baseConfig, configSourceLabel }) {
    return Object.fromEntries(
        definitions.map(({ key, parser }) => [
            key,
            resolveFieldOverride({
                resolvedAgentConfig,
                baseConfig,
                key,
                label: `${configSourceLabel} field "${key}"`,
                parser,
            }),
        ])
    );
}

function pickRuntimeFields(source, definitions) {
    const out = {};
    for (const definition of definitions) {
        const runtimeKey = definition.runtimeKey ?? definition.key;
        out[runtimeKey] = source?.[runtimeKey];
    }
    return out;
}

function resolveMappedRuntimeFields({ definitions, baseConfig, override }) {
    const out = {};
    for (const definition of definitions) {
        out[definition.runtimeKey] = override?.[definition.key] ?? baseConfig[definition.runtimeKey];
    }
    return out;
}

function serializeMappedRuntimeFields({ definitions, runtimeConfig }) {
    const out = {};
    for (const definition of definitions) {
        out[definition.key] = runtimeConfig[definition.runtimeKey];
    }
    return out;
}

function parseMessageApiOverride(value, label) {
    const out = parseObjectWithFieldDefinitions(value, label, MESSAGE_API_FIELD_DEFINITIONS);
    if (!out) {
        return undefined;
    }
    if (hasOwn(value, 'keys')) {
        throw new Error(
            `${label}.keys is not supported in config.json; use MESSAGE_API_KEYS_JSON for secret bearer tokens`
        );
    }

    if (
        out.minTtlSeconds !== undefined &&
        out.minTtlSeconds !== null &&
        out.maxTtlSeconds !== undefined &&
        out.maxTtlSeconds !== null &&
        out.maxTtlSeconds < out.minTtlSeconds
    ) {
        throw new Error(`${label}.maxTtlSeconds must be >= ${label}.minTtlSeconds`);
    }

    return out;
}

function resolveMessageApiRuntimeConfig({ baseConfig, override, label }) {
    const resolved = {
        ...resolveMappedRuntimeFields({
            definitions: MESSAGE_API_FIELD_DEFINITIONS,
            baseConfig,
            override,
        }),
        messageApiKeys: override?.keys ?? baseConfig.messageApiKeys,
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

function parseProposalPublishApiOverride(value, label) {
    const out = parseObjectWithFieldDefinitions(value, label, PROPOSAL_PUBLISH_API_FIELD_DEFINITIONS);
    if (!out) {
        return undefined;
    }
    if (hasOwn(value, 'keys')) {
        throw new Error(
            `${label}.keys is not supported in config.json; use PROPOSAL_PUBLISH_API_KEYS_JSON for secret bearer tokens`
        );
    }
    return out;
}

function resolveProposalPublishApiRuntimeConfig({ baseConfig, override, label }) {
    const resolved = {
        ...resolveMappedRuntimeFields({
            definitions: PROPOSAL_PUBLISH_API_FIELD_DEFINITIONS,
            baseConfig,
            override,
        }),
        proposalPublishApiKeys: override?.keys ?? baseConfig.proposalPublishApiKeys,
    };

    if (
        resolved.proposalPublishApiEnabled &&
        resolved.proposalPublishApiRequireSignerAllowlist &&
        resolved.proposalPublishApiSignerAllowlist.length === 0
    ) {
        throw new Error(
            `${label} requires signerAllowlist when enabled=true and requireSignerAllowlist=true`
        );
    }

    return resolved;
}

function parseMessagePublishApiOverride(value, label) {
    const out = parseObjectWithFieldDefinitions(value, label, MESSAGE_PUBLISH_API_FIELD_DEFINITIONS);
    if (!out) {
        return undefined;
    }
    if (hasOwn(value, 'keys')) {
        throw new Error(
            `${label}.keys is not supported in config.json; use MESSAGE_PUBLISH_API_KEYS_JSON for secret bearer tokens`
        );
    }
    return out;
}

function resolveMessagePublishApiRuntimeConfig({ baseConfig, override, label }) {
    const resolved = {
        ...resolveMappedRuntimeFields({
            definitions: MESSAGE_PUBLISH_API_FIELD_DEFINITIONS,
            baseConfig,
            override,
        }),
        messagePublishApiKeys: override?.keys ?? baseConfig.messagePublishApiKeys,
    };

    if (
        resolved.messagePublishApiEnabled &&
        resolved.messagePublishApiRequireSignerAllowlist &&
        resolved.messagePublishApiSignerAllowlist.length === 0
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

function resolveConfiguredChainId({ agentConfigFile, explicitChainId } = {}) {
    const normalizedExplicitChainId =
        explicitChainId === undefined || explicitChainId === null || explicitChainId === ''
            ? undefined
            : parseChainIdValue(explicitChainId, 'chainId');
    const rawAgentConfig = agentConfigFile?.raw;
    if (!rawAgentConfig) {
        return normalizedExplicitChainId;
    }

    const configSourceLabel = agentConfigFile?.sourceLabel ?? agentConfigFile?.path ?? 'agent config';
    const { byChain } = rawAgentConfig;
    if (byChain !== undefined && (!byChain || typeof byChain !== 'object' || Array.isArray(byChain))) {
        throw new Error(`${configSourceLabel} field "byChain" must be a JSON object`);
    }

    const configuredChainId =
        rawAgentConfig.chainId === undefined || rawAgentConfig.chainId === null
            ? undefined
            : parseChainIdValue(rawAgentConfig.chainId, `${configSourceLabel} field "chainId"`);
    const byChainKeys = byChain ? Object.keys(byChain) : [];

    if (configuredChainId !== undefined) {
        if (
            normalizedExplicitChainId !== undefined &&
            normalizedExplicitChainId !== configuredChainId
        ) {
            throw new Error(
                `${configSourceLabel} selects chainId ${configuredChainId}, but received conflicting chainId ${normalizedExplicitChainId}.`
            );
        }
        return configuredChainId;
    }

    if (byChainKeys.length === 0) {
        return normalizedExplicitChainId;
    }

    if (byChainKeys.length === 1) {
        const inferredChainId = parseChainIdValue(
            byChainKeys[0],
            `${configSourceLabel} field "byChain" key`
        );
        if (
            normalizedExplicitChainId !== undefined &&
            normalizedExplicitChainId !== inferredChainId
        ) {
            throw new Error(
                `${configSourceLabel} infers chainId ${inferredChainId} from byChain, but received conflicting chainId ${normalizedExplicitChainId}.`
            );
        }
        return inferredChainId;
    }

    if (normalizedExplicitChainId !== undefined) {
        return normalizedExplicitChainId;
    }

    throw new Error(
        `${configSourceLabel} defines multiple byChain entries (${byChainKeys.join(
            ', '
        )}) but no top-level chainId. Add "chainId" to the agent config to choose the active chain.`
    );
}

function resolveAgentRuntimeConfig({
    baseConfig,
    agentConfigFile,
    chainId,
    allowAmbiguousChainId = false,
}) {
    let resolvedChainId;
    try {
        resolvedChainId =
            resolveConfiguredChainId({
                agentConfigFile,
                explicitChainId: chainId,
            }) ?? baseConfig.chainId;
    } catch (error) {
        if (
            allowAmbiguousChainId &&
            (chainId === undefined || chainId === null) &&
            String(error?.message ?? '').includes('defines multiple byChain entries')
        ) {
            resolvedChainId = baseConfig.chainId;
        } else {
            throw error;
        }
    }
    const rawAgentConfig = agentConfigFile?.raw;
    if (!rawAgentConfig) {
        return {
            agentConfig: {},
            chainId: resolvedChainId,
            ...pickRuntimeFields(baseConfig, CORE_RUNTIME_FIELD_DEFINITIONS),
            ...pickRuntimeFields(baseConfig, SHARED_RUNTIME_FIELD_DEFINITIONS),
            ipfsHeaders: baseConfig.ipfsHeaders,
            ...pickRuntimeFields(baseConfig, MESSAGE_API_FIELD_DEFINITIONS),
            messageApiKeys: baseConfig.messageApiKeys,
            ...pickRuntimeFields(baseConfig, MESSAGE_PUBLISH_API_FIELD_DEFINITIONS),
            messagePublishApiKeys: baseConfig.messagePublishApiKeys,
            ...pickRuntimeFields(baseConfig, PROPOSAL_PUBLISH_API_FIELD_DEFINITIONS),
            proposalPublishApiKeys: baseConfig.proposalPublishApiKeys,
        };
    }

    const configSourceLabel = agentConfigFile?.sourceLabel ?? agentConfigFile?.path ?? 'agent config';

    const { byChain, ...sharedConfig } = rawAgentConfig;
    if (byChain !== undefined && (!byChain || typeof byChain !== 'object' || Array.isArray(byChain))) {
        throw new Error(`${configSourceLabel} field "byChain" must be a JSON object`);
    }

    const chainKey = resolvedChainId === undefined ? undefined : String(resolvedChainId);
    const chainOverrides = chainKey === undefined ? undefined : byChain?.[chainKey];
    if (
        chainOverrides !== undefined &&
        (!chainOverrides || typeof chainOverrides !== 'object' || Array.isArray(chainOverrides))
    ) {
        throw new Error(`${configSourceLabel} field "byChain.${chainKey}" must be a JSON object`);
    }

    const resolvedAgentConfig = mergeConfigObjects(sharedConfig, chainOverrides ?? {});
    if (resolvedChainId !== undefined) {
        resolvedAgentConfig.chainId = resolvedChainId;
    }
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
    const sharedProposalPublishApi = parseProposalPublishApiOverride(
        sharedConfig.proposalPublishApi,
        `${configSourceLabel} field "proposalPublishApi"`
    );
    const chainProposalPublishApi = parseProposalPublishApiOverride(
        chainOverrides?.proposalPublishApi,
        `${configSourceLabel} field "byChain.${chainKey}.proposalPublishApi"`
    );
    const mergedProposalPublishApiOverride =
        sharedProposalPublishApi || chainProposalPublishApi
            ? {
                  ...(sharedProposalPublishApi ?? {}),
                  ...(chainProposalPublishApi ?? {}),
              }
            : undefined;
    const sharedMessagePublishApi = parseMessagePublishApiOverride(
        sharedConfig.messagePublishApi,
        `${configSourceLabel} field "messagePublishApi"`
    );
    const chainMessagePublishApi = parseMessagePublishApiOverride(
        chainOverrides?.messagePublishApi,
        `${configSourceLabel} field "byChain.${chainKey}.messagePublishApi"`
    );
    const mergedMessagePublishApiOverride =
        sharedMessagePublishApi || chainMessagePublishApi
            ? {
                  ...(sharedMessagePublishApi ?? {}),
                  ...(chainMessagePublishApi ?? {}),
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
              })),
    };
    const resolvedMessageApi = resolveMessageApiRuntimeConfig({
        baseConfig: deferredMessageApiBaseConfig,
        override: mergedMessageApiOverride,
        label: `${configSourceLabel} field "messageApi"`,
    });
    const effectiveMessagePublishApiEnabled =
        mergedMessagePublishApiOverride?.enabled ?? baseConfig.messagePublishApiEnabled;
    const deferredMessagePublishApiBaseConfig = {
        ...runtimeBaseConfig,
        ...(baseConfig[MESSAGE_PUBLISH_API_ENV_OVERRIDES] === undefined
            ? { messagePublishApiEnabled: effectiveMessagePublishApiEnabled }
            : resolveMessagePublishApiEnvConfig({
                  enabled: effectiveMessagePublishApiEnabled,
                  envOverrides: baseConfig[MESSAGE_PUBLISH_API_ENV_OVERRIDES],
              })),
    };
    const resolvedMessagePublishApi = resolveMessagePublishApiRuntimeConfig({
        baseConfig: deferredMessagePublishApiBaseConfig,
        override: mergedMessagePublishApiOverride,
        label: `${configSourceLabel} field "messagePublishApi"`,
    });
    const effectiveProposalPublishApiEnabled =
        mergedProposalPublishApiOverride?.enabled ?? baseConfig.proposalPublishApiEnabled;
    const deferredProposalPublishApiBaseConfig = {
        ...runtimeBaseConfig,
        ...(baseConfig[PROPOSAL_PUBLISH_API_ENV_OVERRIDES] === undefined
            ? { proposalPublishApiEnabled: effectiveProposalPublishApiEnabled }
            : resolveProposalPublishApiEnvConfig({
                  enabled: effectiveProposalPublishApiEnabled,
                  envOverrides: baseConfig[PROPOSAL_PUBLISH_API_ENV_OVERRIDES],
              })),
    };
    const resolvedProposalPublishApi = resolveProposalPublishApiRuntimeConfig({
        baseConfig: deferredProposalPublishApiBaseConfig,
        override: mergedProposalPublishApiOverride,
        label: `${configSourceLabel} field "proposalPublishApi"`,
    });

    const coreRuntimeConfig = resolveFieldDefinitions({
        definitions: CORE_RUNTIME_FIELD_DEFINITIONS,
        resolvedAgentConfig,
        baseConfig,
        configSourceLabel,
    });
    const sharedRuntimeConfig = resolveFieldDefinitions({
        definitions: SHARED_RUNTIME_FIELD_DEFINITIONS,
        resolvedAgentConfig,
        baseConfig: runtimeBaseConfig,
        configSourceLabel,
    });
    if (mergedMessageApiOverride) {
        resolvedAgentConfig.messageApi = {
            ...serializeMappedRuntimeFields({
                definitions: MESSAGE_API_FIELD_DEFINITIONS,
                runtimeConfig: resolvedMessageApi,
            }),
            keys: resolvedMessageApi.messageApiKeys,
        };
    }
    if (mergedProposalPublishApiOverride) {
        resolvedAgentConfig.proposalPublishApi = {
            ...serializeMappedRuntimeFields({
                definitions: PROPOSAL_PUBLISH_API_FIELD_DEFINITIONS,
                runtimeConfig: resolvedProposalPublishApi,
            }),
            keys: resolvedProposalPublishApi.proposalPublishApiKeys,
        };
    }
    if (mergedMessagePublishApiOverride) {
        resolvedAgentConfig.messagePublishApi = {
            ...serializeMappedRuntimeFields({
                definitions: MESSAGE_PUBLISH_API_FIELD_DEFINITIONS,
                runtimeConfig: resolvedMessagePublishApi,
            }),
            keys: resolvedMessagePublishApi.messagePublishApiKeys,
        };
    }

    return {
        agentConfig: resolvedAgentConfig,
        chainId: resolvedChainId,
        ...coreRuntimeConfig,
        ...sharedRuntimeConfig,
        ipfsHeaders: runtimeBaseConfig.ipfsHeaders,
        ...resolvedMessageApi,
        ...resolvedMessagePublishApi,
        ...resolvedProposalPublishApi,
    };
}

export {
    loadAgentConfigFile,
    loadAgentConfigStack,
    resolveConfiguredChainId,
    resolveAgentConfigLayerPaths,
    resolveAgentRuntimeConfig,
};
