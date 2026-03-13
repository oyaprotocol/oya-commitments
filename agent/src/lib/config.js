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

function parseOptionalAddressEnv(raw, envName) {
    if (raw === undefined || raw === null) return undefined;
    const trimmed = String(raw).trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        return getAddress(trimmed);
    } catch (error) {
        throw new Error(`${envName} must be a valid address`);
    }
}

function buildConfig() {
    const rpcUrl = mustGetEnv('RPC_URL');
    const commitmentSafe = parseOptionalAddressEnv(process.env.COMMITMENT_SAFE, 'COMMITMENT_SAFE');
    const ogModule = parseOptionalAddressEnv(process.env.OG_MODULE, 'OG_MODULE');

    const messageApiEnabled = parseBoolean(process.env.MESSAGE_API_ENABLED, false);
    // Keep optional ingress isolated: malformed keys should only fail when the feature is enabled.
    const messageApiKeys = messageApiEnabled
        ? parseMessageApiKeys(process.env.MESSAGE_API_KEYS_JSON)
        : {};
    const messageApiSignerAllowlist = messageApiEnabled
        ? parseAddressList(process.env.MESSAGE_API_SIGNER_ALLOWLIST)
        : [];
    if (messageApiEnabled && messageApiSignerAllowlist.length === 0) {
        throw new Error(
            'MESSAGE_API_ENABLED=true requires MESSAGE_API_SIGNER_ALLOWLIST. MESSAGE_API_KEYS_JSON is optional additional bearer gating.'
        );
    }
    // Keep disabled ingress fully inert: optional MESSAGE_API_* parsing/validation
    // should not abort unrelated agent runs when the API is turned off.
    const messageApiConfig = messageApiEnabled
        ? {
              messageApiHost: parseHost(process.env.MESSAGE_API_HOST, '127.0.0.1'),
              messageApiPort: parsePositiveInteger(
                  process.env.MESSAGE_API_PORT,
                  'MESSAGE_API_PORT',
                  8787
              ),
              messageApiMaxBodyBytes: parsePositiveInteger(
                  process.env.MESSAGE_API_MAX_BODY_BYTES,
                  'MESSAGE_API_MAX_BODY_BYTES',
                  8192
              ),
              messageApiMaxTextLength: parsePositiveInteger(
                  process.env.MESSAGE_API_MAX_TEXT_LENGTH,
                  'MESSAGE_API_MAX_TEXT_LENGTH',
                  2000
              ),
              messageApiQueueLimit: parsePositiveInteger(
                  process.env.MESSAGE_API_QUEUE_LIMIT,
                  'MESSAGE_API_QUEUE_LIMIT',
                  500
              ),
              messageApiBatchSize: parsePositiveInteger(
                  process.env.MESSAGE_API_BATCH_SIZE,
                  'MESSAGE_API_BATCH_SIZE',
                  25
              ),
              messageApiDefaultTtlSeconds: parsePositiveInteger(
                  process.env.MESSAGE_API_DEFAULT_TTL_SECONDS,
                  'MESSAGE_API_DEFAULT_TTL_SECONDS',
                  3600
              ),
              messageApiMinTtlSeconds: parsePositiveInteger(
                  process.env.MESSAGE_API_MIN_TTL_SECONDS,
                  'MESSAGE_API_MIN_TTL_SECONDS',
                  30
              ),
              messageApiMaxTtlSeconds: parsePositiveInteger(
                  process.env.MESSAGE_API_MAX_TTL_SECONDS,
                  'MESSAGE_API_MAX_TTL_SECONDS',
                  86400
              ),
              messageApiIdempotencyTtlSeconds: parsePositiveInteger(
                  process.env.MESSAGE_API_IDEMPOTENCY_TTL_SECONDS,
                  'MESSAGE_API_IDEMPOTENCY_TTL_SECONDS',
                  86400
              ),
              messageApiRateLimitPerMinute: parsePositiveInteger(
                  process.env.MESSAGE_API_RATE_LIMIT_PER_MINUTE,
                  'MESSAGE_API_RATE_LIMIT_PER_MINUTE',
                  30,
                  { min: 0 }
              ),
              messageApiRateLimitBurst: parsePositiveInteger(
                  process.env.MESSAGE_API_RATE_LIMIT_BURST,
                  'MESSAGE_API_RATE_LIMIT_BURST',
                  10,
                  { min: 0 }
              ),
              messageApiSignerAllowlist,
              messageApiSignatureMaxAgeSeconds: parsePositiveInteger(
                  process.env.MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS,
                  'MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS',
                  300
              ),
          }
        : {
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
              messageApiSignerAllowlist: [],
              messageApiSignatureMaxAgeSeconds: 300,
          };
    const ipfsEnabled = parseBoolean(process.env.IPFS_ENABLED, false);
    const ipfsConfig = ipfsEnabled
        ? {
              ipfsApiUrl: parseHost(process.env.IPFS_API_URL, 'http://127.0.0.1:5001'),
              ipfsHeaders: parseStringMap(process.env.IPFS_HEADERS_JSON, 'IPFS_HEADERS_JSON'),
              ipfsRequestTimeoutMs: parsePositiveInteger(
                  process.env.IPFS_REQUEST_TIMEOUT_MS,
                  'IPFS_REQUEST_TIMEOUT_MS',
                  15_000
              ),
              ipfsMaxRetries: parsePositiveInteger(
                  process.env.IPFS_MAX_RETRIES,
                  'IPFS_MAX_RETRIES',
                  1,
                  { min: 0 }
              ),
              ipfsRetryDelayMs: parsePositiveInteger(
                  process.env.IPFS_RETRY_DELAY_MS,
                  'IPFS_RETRY_DELAY_MS',
                  250,
                  { min: 0 }
              ),
          }
        : {
              ipfsApiUrl: 'http://127.0.0.1:5001',
              ipfsHeaders: {},
              ipfsRequestTimeoutMs: 15_000,
              ipfsMaxRetries: 1,
              ipfsRetryDelayMs: 250,
          };

    return {
        rpcUrl,
        commitmentSafe,
        ogModule,
        pollIntervalMs: parsePositiveInteger(
            process.env.POLL_INTERVAL_MS,
            'POLL_INTERVAL_MS',
            10_000
        ),
        logChunkSize: parsePositiveBigInt(process.env.LOG_CHUNK_SIZE, 'LOG_CHUNK_SIZE'),
        startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : undefined,
        watchAssets: parseAddressList(process.env.WATCH_ASSETS),
        watchErc1155Assets: parseErc1155AssetList(
            process.env.WATCH_ERC1155_ASSETS_JSON,
            'WATCH_ERC1155_ASSETS_JSON'
        ),
        watchNativeBalance:
            process.env.WATCH_NATIVE_BALANCE === undefined
                ? true
                : process.env.WATCH_NATIVE_BALANCE.toLowerCase() !== 'false',
        defaultDepositAsset: process.env.DEFAULT_DEPOSIT_ASSET
            ? getAddress(process.env.DEFAULT_DEPOSIT_ASSET)
            : undefined,
        defaultDepositAmountWei: process.env.DEFAULT_DEPOSIT_AMOUNT_WEI
            ? BigInt(process.env.DEFAULT_DEPOSIT_AMOUNT_WEI)
            : undefined,
        bondSpender: (process.env.BOND_SPENDER ?? 'og').toLowerCase(),
        openAiApiKey: process.env.OPENAI_API_KEY,
        openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
        openAiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        openAiRequestTimeoutMs: parsePositiveInteger(
            process.env.OPENAI_REQUEST_TIMEOUT_MS,
            'OPENAI_REQUEST_TIMEOUT_MS',
            60_000
        ),
        allowProposeOnSimulationFail:
            process.env.ALLOW_PROPOSE_ON_SIMULATION_FAIL === undefined
                ? false
                : process.env.ALLOW_PROPOSE_ON_SIMULATION_FAIL.toLowerCase() === 'true',
        proposeGasLimit: process.env.PROPOSE_GAS_LIMIT
            ? BigInt(process.env.PROPOSE_GAS_LIMIT)
            : 2_000_000n,
        executeRetryMs: parsePositiveInteger(
            process.env.EXECUTE_RETRY_MS,
            'EXECUTE_RETRY_MS',
            60_000
        ),
        executePendingTxTimeoutMs: parsePositiveInteger(
            process.env.EXECUTE_PENDING_TX_TIMEOUT_MS,
            'EXECUTE_PENDING_TX_TIMEOUT_MS',
            900_000
        ),
        proposeEnabled:
            process.env.PROPOSE_ENABLED === undefined
                ? true
                : process.env.PROPOSE_ENABLED.toLowerCase() !== 'false',
        disputeEnabled:
            process.env.DISPUTE_ENABLED === undefined
                ? true
                : process.env.DISPUTE_ENABLED.toLowerCase() !== 'false',
        disputeRetryMs: parsePositiveInteger(
            process.env.DISPUTE_RETRY_MS,
            'DISPUTE_RETRY_MS',
            60_000
        ),
        proposalHashResolveTimeoutMs: parseNonNegativeInteger(
            process.env.PROPOSAL_HASH_RESOLVE_TIMEOUT_MS,
            'PROPOSAL_HASH_RESOLVE_TIMEOUT_MS',
            15_000
        ),
        proposalHashResolvePollIntervalMs: parsePositiveInteger(
            process.env.PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS,
            'PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS',
            1_500
        ),
        agentModule: process.env.AGENT_MODULE,
        chainlinkPriceFeed: process.env.CHAINLINK_PRICE_FEED
            ? getAddress(process.env.CHAINLINK_PRICE_FEED)
            : undefined,
        polymarketConditionalTokens: process.env.POLYMARKET_CONDITIONAL_TOKENS
            ? getAddress(process.env.POLYMARKET_CONDITIONAL_TOKENS)
            : getAddress('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'),
        polymarketExchange: process.env.POLYMARKET_EXCHANGE
            ? getAddress(process.env.POLYMARKET_EXCHANGE)
            : undefined,
        polymarketClobEnabled:
            process.env.POLYMARKET_CLOB_ENABLED === undefined
                ? false
                : process.env.POLYMARKET_CLOB_ENABLED.toLowerCase() !== 'false',
        polymarketClobHost: process.env.POLYMARKET_CLOB_HOST ?? 'https://clob.polymarket.com',
        polymarketClobAddress: process.env.POLYMARKET_CLOB_ADDRESS
            ? getAddress(process.env.POLYMARKET_CLOB_ADDRESS)
            : undefined,
        polymarketClobSignatureType: process.env.POLYMARKET_CLOB_SIGNATURE_TYPE,
        polymarketClobApiKey: process.env.POLYMARKET_CLOB_API_KEY,
        polymarketClobApiSecret: process.env.POLYMARKET_CLOB_API_SECRET,
        polymarketClobApiPassphrase: process.env.POLYMARKET_CLOB_API_PASSPHRASE,
        polymarketClobRequestTimeoutMs: parseNonNegativeInteger(
            process.env.POLYMARKET_CLOB_REQUEST_TIMEOUT_MS,
            'POLYMARKET_CLOB_REQUEST_TIMEOUT_MS',
            15_000
        ),
        polymarketClobMaxRetries: parseNonNegativeInteger(
            process.env.POLYMARKET_CLOB_MAX_RETRIES,
            'POLYMARKET_CLOB_MAX_RETRIES',
            1
        ),
        polymarketClobRetryDelayMs: parseNonNegativeInteger(
            process.env.POLYMARKET_CLOB_RETRY_DELAY_MS,
            'POLYMARKET_CLOB_RETRY_DELAY_MS',
            250
        ),
        polymarketRelayerEnabled:
            process.env.POLYMARKET_RELAYER_ENABLED === undefined
                ? false
                : process.env.POLYMARKET_RELAYER_ENABLED.toLowerCase() !== 'false',
        polymarketRelayerHost:
            process.env.POLYMARKET_RELAYER_HOST ?? 'https://relayer-v2.polymarket.com',
        polymarketRelayerTxType: process.env.POLYMARKET_RELAYER_TX_TYPE ?? 'SAFE',
        polymarketRelayerFromAddress: process.env.POLYMARKET_RELAYER_FROM_ADDRESS
            ? getAddress(process.env.POLYMARKET_RELAYER_FROM_ADDRESS)
            : undefined,
        polymarketRelayerSafeFactory: process.env.POLYMARKET_RELAYER_SAFE_FACTORY
            ? getAddress(process.env.POLYMARKET_RELAYER_SAFE_FACTORY)
            : undefined,
        polymarketRelayerProxyFactory: process.env.POLYMARKET_RELAYER_PROXY_FACTORY
            ? getAddress(process.env.POLYMARKET_RELAYER_PROXY_FACTORY)
            : undefined,
        polymarketRelayerResolveProxyAddress:
            process.env.POLYMARKET_RELAYER_RESOLVE_PROXY_ADDRESS === undefined
                ? true
                : process.env.POLYMARKET_RELAYER_RESOLVE_PROXY_ADDRESS.toLowerCase() !==
                  'false',
        polymarketRelayerAutoDeployProxy:
            process.env.POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY === undefined
                ? false
                : process.env.POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY.toLowerCase() === 'true',
        polymarketRelayerChainId: parseOptionalPositiveInteger(
            process.env.POLYMARKET_RELAYER_CHAIN_ID,
            'POLYMARKET_RELAYER_CHAIN_ID'
        ),
        polymarketRelayerRequestTimeoutMs: parseNonNegativeInteger(
            process.env.POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS,
            'POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS',
            15_000
        ),
        polymarketRelayerPollIntervalMs: parsePositiveInteger(
            process.env.POLYMARKET_RELAYER_POLL_INTERVAL_MS,
            'POLYMARKET_RELAYER_POLL_INTERVAL_MS',
            2_000
        ),
        polymarketRelayerPollTimeoutMs: parseNonNegativeInteger(
            process.env.POLYMARKET_RELAYER_POLL_TIMEOUT_MS,
            'POLYMARKET_RELAYER_POLL_TIMEOUT_MS',
            120_000
        ),
        polymarketApiKey: process.env.POLYMARKET_API_KEY,
        polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
        polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
        polymarketBuilderApiKey:
            process.env.POLYMARKET_BUILDER_API_KEY ?? process.env.POLYMARKET_API_KEY,
        polymarketBuilderSecret:
            process.env.POLYMARKET_BUILDER_SECRET ?? process.env.POLYMARKET_API_SECRET,
        polymarketBuilderPassphrase:
            process.env.POLYMARKET_BUILDER_PASSPHRASE ?? process.env.POLYMARKET_API_PASSPHRASE,
        uniswapV3Factory: process.env.UNISWAP_V3_FACTORY
            ? getAddress(process.env.UNISWAP_V3_FACTORY)
            : undefined,
        uniswapV3Quoter: process.env.UNISWAP_V3_QUOTER
            ? getAddress(process.env.UNISWAP_V3_QUOTER)
            : undefined,
        uniswapV3FeeTiers: parseFeeTierList(process.env.UNISWAP_V3_FEE_TIERS),
        messageApiEnabled,
        messageApiKeys,
        ...messageApiConfig,
        ipfsEnabled,
        ...ipfsConfig,
    };
}

export { buildConfig };
