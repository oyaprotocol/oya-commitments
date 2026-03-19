import { getAddress } from 'viem';
import { mustGetEnv, parseAddressList } from './utils.js';

function parseFeeTierList(raw) {
    if (!raw) return [500, 3000, 10000];
    const values = raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value));
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new Error('UNISWAP_V3_FEE_TIERS must be comma-separated positive integers');
    }
    return values;
}

function parsePositiveBigInt(raw, envName) {
    if (!raw) return undefined;
    let parsed;
    try {
        parsed = BigInt(raw);
    } catch (error) {
        throw new Error(`${envName} must be a positive integer`);
    }
    if (parsed <= 0n) {
        throw new Error(`${envName} must be a positive integer`);
    }
    return parsed;
}

function parsePositiveInteger(raw, envName, fallback, { min = 1, max = undefined } = {}) {
    const parsed = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${envName} must be an integer`);
    }
    if (parsed < min) {
        throw new Error(`${envName} must be >= ${min}`);
    }
    if (max !== undefined && parsed > max) {
        throw new Error(`${envName} must be <= ${max}`);
    }
    return parsed;
}

function parseNonNegativeInteger(raw, envName, fallback, { max = undefined } = {}) {
    return parsePositiveInteger(raw, envName, fallback, { min: 0, max });
}

function parseOptionalPositiveInteger(raw, envName, { min = 1, max = undefined } = {}) {
    if (raw === undefined || raw === null || raw === '') {
        return undefined;
    }
    return parsePositiveInteger(raw, envName, undefined, { min, max });
}

function parseBoolean(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    const normalized = String(raw).trim().toLowerCase();
    if (!normalized) return fallback;
    return normalized !== 'false';
}

function parseHost(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    const trimmed = String(raw).trim();
    return trimmed || fallback;
}

function parseMessageApiKeys(raw) {
    if (!raw) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error('MESSAGE_API_KEYS_JSON must be valid JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('MESSAGE_API_KEYS_JSON must be a JSON object');
    }

    const out = {};
    for (const [keyIdRaw, tokenRaw] of Object.entries(parsed)) {
        const keyId = String(keyIdRaw).trim();
        if (!keyId) {
            throw new Error('MESSAGE_API_KEYS_JSON includes empty key id');
        }
        const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';
        if (!token) {
            throw new Error(`MESSAGE_API_KEYS_JSON token for key "${keyId}" must be non-empty`);
        }
        out[keyId] = token;
    }
    return out;
}

function parseStringMap(raw, envName) {
    if (!raw) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${envName} must be valid JSON object`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${envName} must be a JSON object`);
    }

    const out = {};
    for (const [keyRaw, valueRaw] of Object.entries(parsed)) {
        const key = String(keyRaw).trim();
        if (!key) {
            throw new Error(`${envName} includes empty key`);
        }
        if (typeof valueRaw !== 'string') {
            throw new Error(`${envName} value for "${key}" must be a string`);
        }
        out[key] = valueRaw;
    }
    return out;
}

function parseErc1155AssetList(raw, envName) {
    if (!raw) return [];

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${envName} must be valid JSON array`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${envName} must be a JSON array`);
    }

    return parsed.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${envName}[${index}] must be an object`);
        }
        const tokenRaw = typeof item.token === 'string' ? item.token.trim() : '';
        if (!tokenRaw) {
            throw new Error(`${envName}[${index}].token must be a non-empty address string`);
        }

        const tokenIdRaw =
            typeof item.tokenId === 'string' || typeof item.tokenId === 'number'
                ? String(item.tokenId).trim()
                : '';
        if (!tokenIdRaw) {
            throw new Error(`${envName}[${index}].tokenId must be a non-empty integer string`);
        }

        let normalizedTokenId;
        try {
            normalizedTokenId = BigInt(tokenIdRaw);
        } catch (error) {
            throw new Error(`${envName}[${index}].tokenId must be a non-negative integer`);
        }
        if (normalizedTokenId < 0n) {
            throw new Error(`${envName}[${index}].tokenId must be a non-negative integer`);
        }

        let symbol;
        if (item.symbol !== undefined && item.symbol !== null) {
            if (typeof item.symbol !== 'string') {
                throw new Error(`${envName}[${index}].symbol must be a string`);
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

const MESSAGE_API_DEFAULTS = Object.freeze({
    messageApiHost: '127.0.0.1',
    messageApiPort: 8787,
    messageApiMaxBodyBytes: 8192,
    messageApiMaxTextLength: 2000,
    messageApiQueueLimit: 500,
    messageApiBatchSize: 25,
    messageApiDefaultTtlSeconds: 3600,
    messageApiMinTtlSeconds: 30,
    messageApiMaxTtlSeconds: 86400,
    messageApiIdempotencyTtlSeconds: 86400,
    messageApiRateLimitPerMinute: 30,
    messageApiRateLimitBurst: 10,
    messageApiRequireSignerAllowlist: true,
    messageApiSignerAllowlist: [],
    messageApiSignatureMaxAgeSeconds: 300,
    messageApiKeys: {},
});

const IPFS_DEFAULTS = Object.freeze({
    ipfsApiUrl: 'http://127.0.0.1:5001',
    ipfsHeaders: {},
    ipfsRequestTimeoutMs: 15_000,
    ipfsMaxRetries: 1,
    ipfsRetryDelayMs: 250,
});

const DEFAULT_POLYMARKET_CONDITIONAL_TOKENS =
    '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const MESSAGE_API_ENV_OVERRIDES = Symbol('messageApiEnvOverrides');
const IPFS_ENV_OVERRIDES = Symbol('ipfsEnvOverrides');

function collectMessageApiEnvOverrides(env = process.env) {
    return {
        keysJson: env.MESSAGE_API_KEYS_JSON,
    };
}

function collectIpfsEnvOverrides(env = process.env) {
    return {
        headersJson: env.IPFS_HEADERS_JSON,
    };
}

function resolveMessageApiEnvConfig({ enabled, envOverrides = {} } = {}) {
    if (!enabled) {
        return {
            messageApiEnabled: false,
            ...MESSAGE_API_DEFAULTS,
        };
    }

    return {
        messageApiEnabled: true,
        ...MESSAGE_API_DEFAULTS,
        messageApiKeys: parseMessageApiKeys(envOverrides.keysJson),
    };
}

function resolveIpfsEnvConfig({ enabled, envOverrides = {} } = {}) {
    if (!enabled) {
        return {
            ipfsEnabled: false,
            ...IPFS_DEFAULTS,
        };
    }

    return {
        ipfsEnabled: true,
        ...IPFS_DEFAULTS,
        ipfsHeaders: parseStringMap(envOverrides.headersJson, 'IPFS_HEADERS_JSON'),
    };
}

function createDefaultRuntimeConfig({ env = process.env, rpcUrl } = {}) {
    return {
        rpcUrl,
        commitmentSafe: undefined,
        ogModule: undefined,
        pollIntervalMs: 10_000,
        logChunkSize: undefined,
        startBlock: undefined,
        watchAssets: [],
        watchErc1155Assets: [],
        watchNativeBalance: true,
        defaultDepositAsset: undefined,
        defaultDepositAmountWei: undefined,
        bondSpender: 'og',
        openAiApiKey: env.OPENAI_API_KEY,
        openAiModel: 'gpt-4.1-mini',
        openAiBaseUrl: 'https://api.openai.com/v1',
        openAiRequestTimeoutMs: 60_000,
        allowProposeOnSimulationFail: false,
        proposeGasLimit: 2_000_000n,
        executeRetryMs: 60_000,
        executePendingTxTimeoutMs: 900_000,
        proposeEnabled: true,
        disputeEnabled: true,
        disputeRetryMs: 60_000,
        proposalHashResolveTimeoutMs: 15_000,
        proposalHashResolvePollIntervalMs: 1_500,
        agentModule: env.AGENT_MODULE,
        chainlinkPriceFeed: undefined,
        polymarketConditionalTokens: getAddress(DEFAULT_POLYMARKET_CONDITIONAL_TOKENS),
        polymarketExchange: undefined,
        polymarketClobEnabled: false,
        polymarketClobHost: 'https://clob.polymarket.com',
        polymarketClobAddress: undefined,
        polymarketClobSignatureType: undefined,
        polymarketClobApiKey: env.POLYMARKET_CLOB_API_KEY,
        polymarketClobApiSecret: env.POLYMARKET_CLOB_API_SECRET,
        polymarketClobApiPassphrase: env.POLYMARKET_CLOB_API_PASSPHRASE,
        polymarketClobRequestTimeoutMs: 15_000,
        polymarketClobMaxRetries: 1,
        polymarketClobRetryDelayMs: 250,
        polymarketRelayerEnabled: false,
        polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
        polymarketRelayerTxType: 'SAFE',
        polymarketRelayerFromAddress: undefined,
        polymarketRelayerSafeFactory: undefined,
        polymarketRelayerProxyFactory: undefined,
        polymarketRelayerResolveProxyAddress: true,
        polymarketRelayerAutoDeployProxy: false,
        polymarketRelayerChainId: undefined,
        polymarketRelayerRequestTimeoutMs: 15_000,
        polymarketRelayerPollIntervalMs: 2_000,
        polymarketRelayerPollTimeoutMs: 120_000,
        polymarketApiKey: env.POLYMARKET_API_KEY,
        polymarketApiSecret: env.POLYMARKET_API_SECRET,
        polymarketApiPassphrase: env.POLYMARKET_API_PASSPHRASE,
        polymarketBuilderApiKey:
            env.POLYMARKET_BUILDER_API_KEY ?? env.POLYMARKET_API_KEY,
        polymarketBuilderSecret:
            env.POLYMARKET_BUILDER_SECRET ?? env.POLYMARKET_API_SECRET,
        polymarketBuilderPassphrase:
            env.POLYMARKET_BUILDER_PASSPHRASE ?? env.POLYMARKET_API_PASSPHRASE,
        uniswapV3Factory: undefined,
        uniswapV3Quoter: undefined,
        uniswapV3FeeTiers: [500, 3000, 10000],
        messageApiEnabled: false,
        ...MESSAGE_API_DEFAULTS,
        ipfsEnabled: false,
        ...IPFS_DEFAULTS,
    };
}

function buildConfig() {
    const rpcUrl = mustGetEnv('RPC_URL');

    const messageApiEnvOverrides = collectMessageApiEnvOverrides();
    const ipfsEnvOverrides = collectIpfsEnvOverrides();

    const config = createDefaultRuntimeConfig({ rpcUrl });

    Object.defineProperty(config, MESSAGE_API_ENV_OVERRIDES, {
        value: messageApiEnvOverrides,
        enumerable: false,
    });
    Object.defineProperty(config, IPFS_ENV_OVERRIDES, {
        value: ipfsEnvOverrides,
        enumerable: false,
    });

    return config;
}

export {
    createDefaultRuntimeConfig,
    DEFAULT_POLYMARKET_CONDITIONAL_TOKENS,
    buildConfig,
    IPFS_ENV_OVERRIDES,
    MESSAGE_API_ENV_OVERRIDES,
    resolveIpfsEnvConfig,
    resolveMessageApiEnvConfig,
};
