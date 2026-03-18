import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';

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
        out.keys = parseStringRecord(value.keys, `${label}.keys`);
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

function resolveAgentRuntimeConfig({ baseConfig, agentConfigFile, chainId }) {
    const rawAgentConfig = agentConfigFile?.raw;
    if (!rawAgentConfig) {
        return {
            agentConfig: {},
            commitmentSafe: baseConfig.commitmentSafe,
            ogModule: baseConfig.ogModule,
            watchAssets: baseConfig.watchAssets,
            watchErc1155Assets: baseConfig.watchErc1155Assets,
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

    const { byChain, ...sharedConfig } = rawAgentConfig;
    if (byChain !== undefined && (!byChain || typeof byChain !== 'object' || Array.isArray(byChain))) {
        throw new Error(`${agentConfigFile.path} field "byChain" must be a JSON object`);
    }

    const chainKey = String(chainId);
    const chainOverrides = byChain?.[chainKey];
    if (
        chainOverrides !== undefined &&
        (!chainOverrides || typeof chainOverrides !== 'object' || Array.isArray(chainOverrides))
    ) {
        throw new Error(`${agentConfigFile.path} field "byChain.${chainKey}" must be a JSON object`);
    }

    const resolvedAgentConfig = {
        ...sharedConfig,
        ...(chainOverrides ?? {}),
    };
    const sharedMessageApi = parseMessageApiOverride(
        sharedConfig.messageApi,
        `${agentConfigFile.path} field "messageApi"`
    );
    const chainMessageApi = parseMessageApiOverride(
        chainOverrides?.messageApi,
        `${agentConfigFile.path} field "byChain.${chainKey}.messageApi"`
    );
    const mergedMessageApiOverride =
        sharedMessageApi || chainMessageApi
            ? {
                  ...(sharedMessageApi ?? {}),
                  ...(chainMessageApi ?? {}),
              }
            : undefined;
    const resolvedMessageApi = resolveMessageApiRuntimeConfig({
        baseConfig,
        override: mergedMessageApiOverride,
        label: `${agentConfigFile.path} field "messageApi"`,
    });

    const commitmentSafe = hasOwn(resolvedAgentConfig, 'commitmentSafe')
        ? (parseOptionalAddress(
              resolvedAgentConfig.commitmentSafe,
              `${agentConfigFile.path} field "commitmentSafe"`
          ) ?? baseConfig.commitmentSafe)
        : baseConfig.commitmentSafe;
    const ogModule = hasOwn(resolvedAgentConfig, 'ogModule')
        ? (parseOptionalAddress(
              resolvedAgentConfig.ogModule,
              `${agentConfigFile.path} field "ogModule"`
          ) ?? baseConfig.ogModule)
        : baseConfig.ogModule;

    const watchAssets = hasOwn(resolvedAgentConfig, 'watchAssets')
        ? parseAddressArray(
              resolvedAgentConfig.watchAssets,
              `${agentConfigFile.path} field "watchAssets"`
          )
        : baseConfig.watchAssets;
    const watchErc1155Assets = hasOwn(resolvedAgentConfig, 'watchErc1155Assets')
        ? parseErc1155AssetArray(
              resolvedAgentConfig.watchErc1155Assets,
              `${agentConfigFile.path} field "watchErc1155Assets"`
          )
        : baseConfig.watchErc1155Assets;

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
        ...resolvedMessageApi,
    };
}

export {
    loadAgentConfigFile,
    resolveAgentRuntimeConfig,
};
