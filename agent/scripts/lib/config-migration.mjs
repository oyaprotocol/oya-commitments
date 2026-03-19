import { getAddress } from 'viem';
import { normalizeAgentName } from './cli-runtime.mjs';

function hasText(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function parseAddress(value, label) {
    if (!hasText(value)) return undefined;
    try {
        return getAddress(value.trim());
    } catch (error) {
        throw new Error(`${label} must be a valid address`);
    }
}

function parseAddressList(value, label) {
    if (!hasText(value)) return undefined;
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item, index) => parseAddress(item, `${label}[${index}]`));
}

function parseBoolean(value) {
    if (!hasText(value)) return undefined;
    return value.trim().toLowerCase() !== 'false';
}

function parseHost(value) {
    if (!hasText(value)) return undefined;
    return value.trim();
}

function parseInteger(value, label, { min = undefined } = {}) {
    if (!hasText(value)) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`${label} must be >= ${min}`);
    }
    return parsed;
}

function parseBigIntString(value, label, { min = undefined } = {}) {
    if (!hasText(value)) return undefined;
    let parsed;
    try {
        parsed = BigInt(value.trim());
    } catch (error) {
        throw new Error(`${label} must be an integer`);
    }
    if (min !== undefined && parsed < min) {
        throw new Error(`${label} must be >= ${min.toString()}`);
    }
    return parsed.toString();
}

function parseString(value) {
    if (!hasText(value)) return undefined;
    return value.trim();
}

function parseJsonArray(value, label) {
    if (!hasText(value)) return undefined;
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error(`${label} must be valid JSON`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array`);
    }
    return parsed;
}

function parseWatchErc1155Assets(value, label) {
    const parsed = parseJsonArray(value, label);
    if (!parsed) return undefined;
    return parsed.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}[${index}] must be an object`);
        }
        const token = parseAddress(item.token, `${label}[${index}].token`);
        const tokenId = parseBigIntString(item.tokenId, `${label}[${index}].tokenId`, {
            min: 0n,
        });
        if (!token || !tokenId) {
            throw new Error(`${label}[${index}] requires token and tokenId`);
        }
        const normalized = { token, tokenId };
        const symbol = parseString(item.symbol);
        if (symbol) normalized.symbol = symbol;
        return normalized;
    });
}

function parseFeeTierList(value, label) {
    if (!hasText(value)) return undefined;
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item, index) => parseInteger(item, `${label}[${index}]`, { min: 1 }));
}

function assignIfDefined(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}

function mergePlainObjects(base, override) {
    const output = { ...(base ?? {}) };
    for (const [key, value] of Object.entries(override ?? {})) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            output[key] &&
            typeof output[key] === 'object' &&
            !Array.isArray(output[key])
        ) {
            output[key] = mergePlainObjects(output[key], value);
        } else {
            output[key] = value;
        }
    }
    return output;
}

function buildMessageApiPatch(env) {
    const messageApi = {};
    assignIfDefined(messageApi, 'enabled', parseBoolean(env.MESSAGE_API_ENABLED));
    assignIfDefined(messageApi, 'host', parseHost(env.MESSAGE_API_HOST));
    assignIfDefined(messageApi, 'port', parseInteger(env.MESSAGE_API_PORT, 'MESSAGE_API_PORT', { min: 1 }));
    assignIfDefined(
        messageApi,
        'requireSignerAllowlist',
        parseBoolean(env.MESSAGE_API_REQUIRE_SIGNER_ALLOWLIST)
    );
    assignIfDefined(
        messageApi,
        'signerAllowlist',
        parseAddressList(env.MESSAGE_API_SIGNER_ALLOWLIST, 'MESSAGE_API_SIGNER_ALLOWLIST')
    );
    assignIfDefined(
        messageApi,
        'signatureMaxAgeSeconds',
        parseInteger(env.MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS, 'MESSAGE_API_SIGNATURE_MAX_AGE_SECONDS', {
            min: 1,
        })
    );
    assignIfDefined(
        messageApi,
        'maxBodyBytes',
        parseInteger(env.MESSAGE_API_MAX_BODY_BYTES, 'MESSAGE_API_MAX_BODY_BYTES', { min: 1 })
    );
    assignIfDefined(
        messageApi,
        'maxTextLength',
        parseInteger(env.MESSAGE_API_MAX_TEXT_LENGTH, 'MESSAGE_API_MAX_TEXT_LENGTH', { min: 1 })
    );
    assignIfDefined(
        messageApi,
        'queueLimit',
        parseInteger(env.MESSAGE_API_QUEUE_LIMIT, 'MESSAGE_API_QUEUE_LIMIT', { min: 1 })
    );
    assignIfDefined(
        messageApi,
        'batchSize',
        parseInteger(env.MESSAGE_API_BATCH_SIZE, 'MESSAGE_API_BATCH_SIZE', { min: 1 })
    );
    assignIfDefined(
        messageApi,
        'defaultTtlSeconds',
        parseInteger(env.MESSAGE_API_DEFAULT_TTL_SECONDS, 'MESSAGE_API_DEFAULT_TTL_SECONDS', {
            min: 1,
        })
    );
    assignIfDefined(
        messageApi,
        'minTtlSeconds',
        parseInteger(env.MESSAGE_API_MIN_TTL_SECONDS, 'MESSAGE_API_MIN_TTL_SECONDS', {
            min: 1,
        })
    );
    assignIfDefined(
        messageApi,
        'maxTtlSeconds',
        parseInteger(env.MESSAGE_API_MAX_TTL_SECONDS, 'MESSAGE_API_MAX_TTL_SECONDS', {
            min: 1,
        })
    );
    assignIfDefined(
        messageApi,
        'idempotencyTtlSeconds',
        parseInteger(
            env.MESSAGE_API_IDEMPOTENCY_TTL_SECONDS,
            'MESSAGE_API_IDEMPOTENCY_TTL_SECONDS',
            { min: 1 }
        )
    );
    assignIfDefined(
        messageApi,
        'rateLimitPerMinute',
        parseInteger(env.MESSAGE_API_RATE_LIMIT_PER_MINUTE, 'MESSAGE_API_RATE_LIMIT_PER_MINUTE', {
            min: 0,
        })
    );
    assignIfDefined(
        messageApi,
        'rateLimitBurst',
        parseInteger(env.MESSAGE_API_RATE_LIMIT_BURST, 'MESSAGE_API_RATE_LIMIT_BURST', {
            min: 0,
        })
    );
    return Object.keys(messageApi).length > 0 ? messageApi : undefined;
}

function buildCopyTradingPatch(env) {
    const copyTrading = {};
    assignIfDefined(copyTrading, 'sourceUser', parseAddress(env.COPY_TRADING_SOURCE_USER, 'COPY_TRADING_SOURCE_USER'));
    assignIfDefined(copyTrading, 'market', parseString(env.COPY_TRADING_MARKET));
    assignIfDefined(copyTrading, 'yesTokenId', parseBigIntString(env.COPY_TRADING_YES_TOKEN_ID, 'COPY_TRADING_YES_TOKEN_ID', { min: 0n }));
    assignIfDefined(copyTrading, 'noTokenId', parseBigIntString(env.COPY_TRADING_NO_TOKEN_ID, 'COPY_TRADING_NO_TOKEN_ID', { min: 0n }));
    assignIfDefined(copyTrading, 'collateralToken', parseAddress(env.COPY_TRADING_COLLATERAL_TOKEN, 'COPY_TRADING_COLLATERAL_TOKEN'));
    assignIfDefined(copyTrading, 'ctfContract', parseAddress(env.COPY_TRADING_CTF_CONTRACT, 'COPY_TRADING_CTF_CONTRACT'));
    return Object.keys(copyTrading).length > 0 ? copyTrading : undefined;
}

function buildDeterministicDcaPatch(env) {
    const patch = {};
    assignIfDefined(patch, 'deterministicDcaPolicyPreset', parseString(env.DETERMINISTIC_DCA_POLICY_PRESET));
    assignIfDefined(
        patch,
        'deterministicDcaLogChunkSize',
        parseBigIntString(env.DETERMINISTIC_DCA_LOG_CHUNK_SIZE, 'DETERMINISTIC_DCA_LOG_CHUNK_SIZE', {
            min: 1n,
        })
    );
    return patch;
}

function buildConfigMigrationPatch({ env = process.env, moduleName, chainId } = {}) {
    const normalizedModuleName = normalizeAgentName(moduleName);
    const patch = {};

    assignIfDefined(patch, 'commitmentSafe', parseAddress(env.COMMITMENT_SAFE, 'COMMITMENT_SAFE'));
    assignIfDefined(patch, 'ogModule', parseAddress(env.OG_MODULE, 'OG_MODULE'));
    assignIfDefined(patch, 'watchAssets', parseAddressList(env.WATCH_ASSETS, 'WATCH_ASSETS'));
    assignIfDefined(
        patch,
        'watchErc1155Assets',
        parseWatchErc1155Assets(env.WATCH_ERC1155_ASSETS_JSON, 'WATCH_ERC1155_ASSETS_JSON')
    );
    assignIfDefined(patch, 'pollIntervalMs', parseInteger(env.POLL_INTERVAL_MS, 'POLL_INTERVAL_MS', { min: 1 }));
    assignIfDefined(patch, 'logChunkSize', parseBigIntString(env.LOG_CHUNK_SIZE, 'LOG_CHUNK_SIZE', { min: 1n }));
    assignIfDefined(patch, 'startBlock', parseBigIntString(env.START_BLOCK, 'START_BLOCK', { min: 0n }));
    assignIfDefined(patch, 'watchNativeBalance', parseBoolean(env.WATCH_NATIVE_BALANCE));
    assignIfDefined(patch, 'defaultDepositAsset', parseAddress(env.DEFAULT_DEPOSIT_ASSET, 'DEFAULT_DEPOSIT_ASSET'));
    assignIfDefined(
        patch,
        'defaultDepositAmountWei',
        parseBigIntString(env.DEFAULT_DEPOSIT_AMOUNT_WEI, 'DEFAULT_DEPOSIT_AMOUNT_WEI', {
            min: 0n,
        })
    );
    assignIfDefined(patch, 'bondSpender', parseString(env.BOND_SPENDER)?.toLowerCase());
    assignIfDefined(patch, 'openAiModel', parseString(env.OPENAI_MODEL));
    assignIfDefined(patch, 'openAiBaseUrl', parseHost(env.OPENAI_BASE_URL));
    assignIfDefined(
        patch,
        'openAiRequestTimeoutMs',
        parseInteger(env.OPENAI_REQUEST_TIMEOUT_MS, 'OPENAI_REQUEST_TIMEOUT_MS', { min: 1 })
    );
    assignIfDefined(
        patch,
        'allowProposeOnSimulationFail',
        parseBoolean(env.ALLOW_PROPOSE_ON_SIMULATION_FAIL)
    );
    assignIfDefined(
        patch,
        'proposeGasLimit',
        parseBigIntString(env.PROPOSE_GAS_LIMIT, 'PROPOSE_GAS_LIMIT', { min: 1n })
    );
    assignIfDefined(patch, 'executeRetryMs', parseInteger(env.EXECUTE_RETRY_MS, 'EXECUTE_RETRY_MS', { min: 1 }));
    assignIfDefined(
        patch,
        'executePendingTxTimeoutMs',
        parseInteger(env.EXECUTE_PENDING_TX_TIMEOUT_MS, 'EXECUTE_PENDING_TX_TIMEOUT_MS', {
            min: 1,
        })
    );
    assignIfDefined(patch, 'proposeEnabled', parseBoolean(env.PROPOSE_ENABLED));
    assignIfDefined(patch, 'disputeEnabled', parseBoolean(env.DISPUTE_ENABLED));
    assignIfDefined(patch, 'disputeRetryMs', parseInteger(env.DISPUTE_RETRY_MS, 'DISPUTE_RETRY_MS', { min: 1 }));
    assignIfDefined(
        patch,
        'proposalHashResolveTimeoutMs',
        parseInteger(env.PROPOSAL_HASH_RESOLVE_TIMEOUT_MS, 'PROPOSAL_HASH_RESOLVE_TIMEOUT_MS', {
            min: 0,
        })
    );
    assignIfDefined(
        patch,
        'proposalHashResolvePollIntervalMs',
        parseInteger(
            env.PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS,
            'PROPOSAL_HASH_RESOLVE_POLL_INTERVAL_MS',
            { min: 1 }
        )
    );
    assignIfDefined(patch, 'chainlinkPriceFeed', parseAddress(env.CHAINLINK_PRICE_FEED, 'CHAINLINK_PRICE_FEED'));
    assignIfDefined(
        patch,
        'polymarketConditionalTokens',
        parseAddress(env.POLYMARKET_CONDITIONAL_TOKENS, 'POLYMARKET_CONDITIONAL_TOKENS')
    );
    assignIfDefined(patch, 'polymarketExchange', parseAddress(env.POLYMARKET_EXCHANGE, 'POLYMARKET_EXCHANGE'));
    assignIfDefined(patch, 'polymarketClobEnabled', parseBoolean(env.POLYMARKET_CLOB_ENABLED));
    assignIfDefined(patch, 'polymarketClobHost', parseHost(env.POLYMARKET_CLOB_HOST));
    assignIfDefined(patch, 'polymarketClobAddress', parseAddress(env.POLYMARKET_CLOB_ADDRESS, 'POLYMARKET_CLOB_ADDRESS'));
    assignIfDefined(patch, 'polymarketClobSignatureType', parseString(env.POLYMARKET_CLOB_SIGNATURE_TYPE));
    assignIfDefined(
        patch,
        'polymarketClobRequestTimeoutMs',
        parseInteger(env.POLYMARKET_CLOB_REQUEST_TIMEOUT_MS, 'POLYMARKET_CLOB_REQUEST_TIMEOUT_MS', {
            min: 0,
        })
    );
    assignIfDefined(
        patch,
        'polymarketClobMaxRetries',
        parseInteger(env.POLYMARKET_CLOB_MAX_RETRIES, 'POLYMARKET_CLOB_MAX_RETRIES', {
            min: 0,
        })
    );
    assignIfDefined(
        patch,
        'polymarketClobRetryDelayMs',
        parseInteger(env.POLYMARKET_CLOB_RETRY_DELAY_MS, 'POLYMARKET_CLOB_RETRY_DELAY_MS', {
            min: 0,
        })
    );
    assignIfDefined(patch, 'polymarketRelayerEnabled', parseBoolean(env.POLYMARKET_RELAYER_ENABLED));
    assignIfDefined(patch, 'polymarketRelayerHost', parseHost(env.POLYMARKET_RELAYER_HOST));
    assignIfDefined(patch, 'polymarketRelayerTxType', parseString(env.POLYMARKET_RELAYER_TX_TYPE));
    assignIfDefined(
        patch,
        'polymarketRelayerFromAddress',
        parseAddress(env.POLYMARKET_RELAYER_FROM_ADDRESS, 'POLYMARKET_RELAYER_FROM_ADDRESS')
    );
    assignIfDefined(
        patch,
        'polymarketRelayerSafeFactory',
        parseAddress(env.POLYMARKET_RELAYER_SAFE_FACTORY, 'POLYMARKET_RELAYER_SAFE_FACTORY')
    );
    assignIfDefined(
        patch,
        'polymarketRelayerProxyFactory',
        parseAddress(env.POLYMARKET_RELAYER_PROXY_FACTORY, 'POLYMARKET_RELAYER_PROXY_FACTORY')
    );
    assignIfDefined(
        patch,
        'polymarketRelayerResolveProxyAddress',
        parseBoolean(env.POLYMARKET_RELAYER_RESOLVE_PROXY_ADDRESS)
    );
    assignIfDefined(
        patch,
        'polymarketRelayerAutoDeployProxy',
        parseBoolean(env.POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY)
    );
    assignIfDefined(
        patch,
        'polymarketRelayerChainId',
        parseInteger(env.POLYMARKET_RELAYER_CHAIN_ID, 'POLYMARKET_RELAYER_CHAIN_ID', { min: 1 })
    );
    assignIfDefined(
        patch,
        'polymarketRelayerRequestTimeoutMs',
        parseInteger(
            env.POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS,
            'POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS',
            { min: 0 }
        )
    );
    assignIfDefined(
        patch,
        'polymarketRelayerPollIntervalMs',
        parseInteger(
            env.POLYMARKET_RELAYER_POLL_INTERVAL_MS,
            'POLYMARKET_RELAYER_POLL_INTERVAL_MS',
            { min: 1 }
        )
    );
    assignIfDefined(
        patch,
        'polymarketRelayerPollTimeoutMs',
        parseInteger(
            env.POLYMARKET_RELAYER_POLL_TIMEOUT_MS,
            'POLYMARKET_RELAYER_POLL_TIMEOUT_MS',
            { min: 0 }
        )
    );
    assignIfDefined(patch, 'uniswapV3Factory', parseAddress(env.UNISWAP_V3_FACTORY, 'UNISWAP_V3_FACTORY'));
    assignIfDefined(patch, 'uniswapV3Quoter', parseAddress(env.UNISWAP_V3_QUOTER, 'UNISWAP_V3_QUOTER'));
    assignIfDefined(patch, 'uniswapV3FeeTiers', parseFeeTierList(env.UNISWAP_V3_FEE_TIERS, 'UNISWAP_V3_FEE_TIERS'));
    assignIfDefined(patch, 'ipfsEnabled', parseBoolean(env.IPFS_ENABLED));
    assignIfDefined(patch, 'ipfsApiUrl', parseHost(env.IPFS_API_URL));
    assignIfDefined(
        patch,
        'ipfsRequestTimeoutMs',
        parseInteger(env.IPFS_REQUEST_TIMEOUT_MS, 'IPFS_REQUEST_TIMEOUT_MS', { min: 1 })
    );
    assignIfDefined(patch, 'ipfsMaxRetries', parseInteger(env.IPFS_MAX_RETRIES, 'IPFS_MAX_RETRIES', { min: 0 }));
    assignIfDefined(
        patch,
        'ipfsRetryDelayMs',
        parseInteger(env.IPFS_RETRY_DELAY_MS, 'IPFS_RETRY_DELAY_MS', { min: 0 })
    );

    const messageApi = buildMessageApiPatch(env);
    if (messageApi) {
        patch.messageApi = messageApi;
    }

    const copyTrading = buildCopyTradingPatch(env);
    if (copyTrading) {
        patch.copyTrading = copyTrading;
    }

    if (normalizedModuleName === 'deterministic-dca-agent') {
        Object.assign(patch, buildDeterministicDcaPatch(env));
    }

    if (chainId === undefined || chainId === null || String(chainId).trim() === '') {
        return patch;
    }

    return {
        byChain: {
            [String(chainId)]: patch,
        },
    };
}

export { buildConfigMigrationPatch, mergePlainObjects };
