import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
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
            watchAssets: baseConfig.watchAssets,
            watchErc1155Assets: baseConfig.watchErc1155Assets,
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

    return {
        agentConfig: resolvedAgentConfig,
        watchAssets,
        watchErc1155Assets,
    };
}

export {
    loadAgentConfigFile,
    resolveAgentRuntimeConfig,
};
