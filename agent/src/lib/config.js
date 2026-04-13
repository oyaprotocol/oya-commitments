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
    return parseApiKeyMap(raw, 'MESSAGE_API_KEYS_JSON');
}

function parseProposalPublishApiKeys(raw) {
    return parseApiKeyMap(raw, 'PROPOSAL_PUBLISH_API_KEYS_JSON');
}

function parseMessagePublishApiKeys(raw) {
    return parseApiKeyMap(raw, 'MESSAGE_PUBLISH_API_KEYS_JSON');
}

function parseApiKeyMap(raw, envName) {
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
    for (const [keyIdRaw, tokenRaw] of Object.entries(parsed)) {
        const keyId = String(keyIdRaw).trim();
        if (!keyId) {
            throw new Error(`${envName} includes empty key id`);
        }
        const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';
        if (!token) {
            throw new Error(`${envName} token for key "${keyId}" must be non-empty`);
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

const PROPOSAL_PUBLISH_API_DEFAULTS = Object.freeze({
    proposalPublishApiHost: '127.0.0.1',
    proposalPublishApiPort: 9890,
    proposalPublishApiMode: 'publish',
    proposalPublishApiMaxBodyBytes: 65_536,
    proposalPublishApiRequireSignerAllowlist: true,
    proposalPublishApiSignerAllowlist: [],
    proposalPublishApiSignatureMaxAgeSeconds: 300,
    proposalPublishApiStateFile: undefined,
    proposalPublishApiNodeName: undefined,
    proposalPublishApiKeys: {},
});

const MESSAGE_PUBLISH_API_DEFAULTS = Object.freeze({
    messagePublishApiHost: '127.0.0.1',
    messagePublishApiPort: 9892,
    messagePublishApiMaxBodyBytes: 65_536,
    messagePublishApiRequireSignerAllowlist: true,
    messagePublishApiSignerAllowlist: [],
    messagePublishApiSignatureMaxAgeSeconds: 300,
    messagePublishApiStateFile: undefined,
    messagePublishApiNodeName: undefined,
    messagePublishApiKeys: {},
});

const DEFAULT_POLYMARKET_CONDITIONAL_TOKENS =
    '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const MESSAGE_API_ENV_OVERRIDES = Symbol('messageApiEnvOverrides');
const IPFS_ENV_OVERRIDES = Symbol('ipfsEnvOverrides');
const PROPOSAL_PUBLISH_API_ENV_OVERRIDES = Symbol('proposalPublishApiEnvOverrides');
const MESSAGE_PUBLISH_API_ENV_OVERRIDES = Symbol('messagePublishApiEnvOverrides');
const DEPRECATED_SHARED_CONFIG_ENV_VARS = Object.freeze([
    'CHAIN_ID',
    'COMMITMENT_SAFE',
    'OG_MODULE',
    'WATCH_ASSETS',
    'WATCH_ERC1155_ASSETS_JSON',
    'POLL_INTERVAL_MS',
    'LOG_CHUNK_SIZE',
    'START_BLOCK',
    'WATCH_NATIVE_BALANCE',
    'DEFAULT_DEPOSIT_ASSET',
    'DEFAULT_DEPOSIT_AMOUNT_WEI',
    'BOND_SPENDER',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_REQUEST_TIMEOUT_MS',
    'ALLOW_PROPOSE_ON_SIMULATION_FAIL',
    'PROPOSE_GAS_LIMIT',
    'EXECUTE_RETRY_MS',
    'EXECUTE_PENDING_TX_TIMEOUT_MS',
    'PROPOSE_ENABLED',
    'DISPUTE_ENABLED',
    'DISPUTE_RETRY_MS',
    'PROPOSAL_HASH_RESOLVE_TIMEOUT_MS',
    'PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS',
    'CHAINLINK_PRICE_FEED',
    'POLYMARKET_CONDITIONAL_TOKENS',
    'POLYMARKET_EXCHANGE',
    'POLYMARKET_CLOB_ENABLED',
    'POLYMARKET_CLOB_HOST',
    'POLYMARKET_CLOB_ADDRESS',
    'POLYMARKET_CLOB_SIGNATURE_TYPE',
    'POLYMARKET_CLOB_REQUEST_TIMEOUT_MS',
    'POLYMARKET_CLOB_MAX_RETRIES',
    'POLYMARKET_CLOB_RETRY_DELAY_MS',
    'POLYMARKET_RELAYER_ENABLED',
    'POLYMARKET_RELAYER_HOST',
    'POLYMARKET_RELAYER_TX_TYPE',
    'POLYMARKET_RELAYER_FROM_ADDRESS',
    'POLYMARKET_RELAYER_SAFE_FACTORY',
    'POLYMARKET_RELAYER_PROXY_FACTORY',
    'POLYMARKET_RELAYER_RESOLVE_PROXY_ADDRESS',
    'POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY',
    'POLYMARKET_RELAYER_CHAIN_ID',
    'POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS',
    'POLYMARKET_RELAYER_POLL_INTERVAL_MS',
    'POLYMARKET_RELAYER_POLL_TIMEOUT_MS',
    'UNISWAP_V3_FACTORY',
    'UNISWAP_V3_QUOTER',
    'UNISWAP_V3_FEE_TIERS',
    'IPFS_ENABLED',
    'IPFS_API_URL',
    'IPFS_REQUEST_TIMEOUT_MS',
    'IPFS_MAX_RETRIES',
    'IPFS_RETRY_DELAY_MS',
    'MESSAGE_API_ENABLED',
    'MESSAGE_API_HOST',
    'MESSAGE_API_PORT',
    'MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST',
    'MESSAGE_API_SIGNER_ALLOWLIST',
    'MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS',
    'MESSAGE_API_MAX_BODY_BYTES',
    'MESSAGE_API_MAX_TEXT_LENGTH',
    'MESSAGE_API_QUEUE_LIMIT',
    'MESSAGE_API_BATCH_SIZE',
    'MESSAGE_API_DEFAULT_TTL_SECONDS',
    'MESSAGE_API_MIN_TTL_SECONDS',
    'MESSAGE_API_MAX_TTL_SECONDS',
    'MESSAGE_API_IDEMPOTENCY_TTL_SECONDS',
    'MESSAGE_API_RATE_LIMIT_PER_MINUTE',
    'MESSAGE_API_RATE_LIMIT_BURST',
    'MESSAGE_PUBLISH_API_ENABLED',
    'MESSAGE_PUBLISH_API_HOST',
    'MESSAGE_PUBLISH_API_PORT',
    'MESSAGE_PUBLISH_API_REQUIRE_SIGNER_ALLOWLIST',
    'MESSAGE_PUBLISH_API_SIGNER_ALLOWLIST',
    'MESSAGE_PUBLISH_API_SIGNATURE_MAX_AGE_SECONDS',
    'MESSAGE_PUBLISH_API_MAX_BODY_BYTES',
    'MESSAGE_PUBLISH_API_STATE_FILE',
    'MESSAGE_PUBLISH_API_NODE_NAME',
]);
const DEPRECATED_AGENT_CONFIG_ENV_VARS = Object.freeze({
    'copy-trading': Object.freeze([
        'COPY_TRADING_SOURCE_USER',
        'COPY_TRADING_MARKET',
        'COPY_TRADING_YES_TOKEN_ID',
        'COPY_TRADING_NO_TOKEN_ID',
        'COPY_TRADING_COLLATERAL_TOKEN',
        'COPY_TRADING_CTF_CONTRACT',
    ]),
    'deterministic-dca-agent': Object.freeze([
        'DETERMINISTIC_DCA_POLICY_PRESET',
        'DETERMINISTIC_DCA_LOG_CHUNK_SIZE',
    ]),
});

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

function collectProposalPublishApiEnvOverrides(env = process.env) {
    return {
        keysJson: env.PROPOSAL_PUBLISH_API_KEYS_JSON,
    };
}

function collectMessagePublishApiEnvOverrides(env = process.env) {
    return {
        keysJson: env.MESSAGE_PUBLISH_API_KEYS_JSON,
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

function resolveProposalPublishApiEnvConfig({ enabled, envOverrides = {} } = {}) {
    if (!enabled) {
        return {
            proposalPublishApiEnabled: false,
            ...PROPOSAL_PUBLISH_API_DEFAULTS,
        };
    }

    return {
        proposalPublishApiEnabled: true,
        ...PROPOSAL_PUBLISH_API_DEFAULTS,
        proposalPublishApiKeys: parseProposalPublishApiKeys(envOverrides.keysJson),
    };
}

function resolveMessagePublishApiEnvConfig({ enabled, envOverrides = {} } = {}) {
    if (!enabled) {
        return {
            messagePublishApiEnabled: false,
            ...MESSAGE_PUBLISH_API_DEFAULTS,
        };
    }

    return {
        messagePublishApiEnabled: true,
        ...MESSAGE_PUBLISH_API_DEFAULTS,
        messagePublishApiKeys: parseMessagePublishApiKeys(envOverrides.keysJson),
    };
}

function hasConfiguredEnvValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function findDeprecatedConfigEnvVars({ env = process.env, agentModuleName } = {}) {
    const names = [
        ...DEPRECATED_SHARED_CONFIG_ENV_VARS,
        ...(DEPRECATED_AGENT_CONFIG_ENV_VARS[agentModuleName] ?? []),
    ];
    return names.filter((name) => hasConfiguredEnvValue(env[name]));
}

function listDeprecatedConfigEnvVars({ agentModuleName } = {}) {
    return [
        ...DEPRECATED_SHARED_CONFIG_ENV_VARS,
        ...(DEPRECATED_AGENT_CONFIG_ENV_VARS[agentModuleName] ?? []),
    ];
}

function assertNoDeprecatedConfigEnvVars({ env = process.env, agentModuleName } = {}) {
    const names = findDeprecatedConfigEnvVars({ env, agentModuleName });
    if (names.length === 0) {
        return;
    }

    const scopeLabel = agentModuleName
        ? ` for agent "${agentModuleName}"`
        : '';
    throw new Error(
        `Legacy non-secret env config is no longer supported${scopeLabel}. Move these settings into the active agent config stack (config.json/config.local.json/overlay) and remove them from agent/.env: ${names.join(
            ', '
        )}. Use node agent/scripts/migrate-agent-config-from-env.mjs --module=${
            agentModuleName ?? '<agent-name>'
        } for one-time migration.`
    );
}

function createDefaultRuntimeConfig({ env = process.env, rpcUrl } = {}) {
    return {
        rpcUrl,
        chainId: undefined,
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
        proposalVerificationMode: 'off',
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
        messagePublishApiEnabled: false,
        ...MESSAGE_PUBLISH_API_DEFAULTS,
        proposalPublishApiEnabled: false,
        ...PROPOSAL_PUBLISH_API_DEFAULTS,
        ipfsEnabled: false,
        ...IPFS_DEFAULTS,
    };
}

function buildConfig({ env = process.env, requireRpcUrl = true, fallbackRpcUrl = undefined } = {}) {
    const rpcUrl = requireRpcUrl ? mustGetEnv('RPC_URL') : env.RPC_URL ?? fallbackRpcUrl;

    const messageApiEnvOverrides = collectMessageApiEnvOverrides(env);
    const ipfsEnvOverrides = collectIpfsEnvOverrides(env);
    const proposalPublishApiEnvOverrides = collectProposalPublishApiEnvOverrides(env);
    const messagePublishApiEnvOverrides = collectMessagePublishApiEnvOverrides(env);

    const config = createDefaultRuntimeConfig({ env, rpcUrl });

    Object.defineProperty(config, MESSAGE_API_ENV_OVERRIDES, {
        value: messageApiEnvOverrides,
        enumerable: false,
    });
    Object.defineProperty(config, IPFS_ENV_OVERRIDES, {
        value: ipfsEnvOverrides,
        enumerable: false,
    });
    Object.defineProperty(config, PROPOSAL_PUBLISH_API_ENV_OVERRIDES, {
        value: proposalPublishApiEnvOverrides,
        enumerable: false,
    });
    Object.defineProperty(config, MESSAGE_PUBLISH_API_ENV_OVERRIDES, {
        value: messagePublishApiEnvOverrides,
        enumerable: false,
    });

    return config;
}

export {
    assertNoDeprecatedConfigEnvVars,
    createDefaultRuntimeConfig,
    DEFAULT_POLYMARKET_CONDITIONAL_TOKENS,
    buildConfig,
    findDeprecatedConfigEnvVars,
    IPFS_ENV_OVERRIDES,
    listDeprecatedConfigEnvVars,
    MESSAGE_API_ENV_OVERRIDES,
    MESSAGE_PUBLISH_API_DEFAULTS,
    MESSAGE_PUBLISH_API_ENV_OVERRIDES,
    PROPOSAL_PUBLISH_API_ENV_OVERRIDES,
    PROPOSAL_PUBLISH_API_DEFAULTS,
    resolveIpfsEnvConfig,
    resolveMessageApiEnvConfig,
    resolveMessagePublishApiEnvConfig,
    resolveProposalPublishApiEnvConfig,
};
