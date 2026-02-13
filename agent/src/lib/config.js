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

function buildConfig() {
    return {
        rpcUrl: mustGetEnv('RPC_URL'),
        commitmentSafe: getAddress(mustGetEnv('COMMITMENT_SAFE')),
        ogModule: getAddress(mustGetEnv('OG_MODULE')),
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 10_000),
        startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : undefined,
        watchAssets: parseAddressList(process.env.WATCH_ASSETS),
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
        allowProposeOnSimulationFail:
            process.env.ALLOW_PROPOSE_ON_SIMULATION_FAIL === undefined
                ? false
                : process.env.ALLOW_PROPOSE_ON_SIMULATION_FAIL.toLowerCase() === 'true',
        proposeGasLimit: process.env.PROPOSE_GAS_LIMIT
            ? BigInt(process.env.PROPOSE_GAS_LIMIT)
            : 2_000_000n,
        executeRetryMs: Number(process.env.EXECUTE_RETRY_MS ?? 60_000),
        proposeEnabled:
            process.env.PROPOSE_ENABLED === undefined
                ? true
                : process.env.PROPOSE_ENABLED.toLowerCase() !== 'false',
        disputeEnabled:
            process.env.DISPUTE_ENABLED === undefined
                ? true
                : process.env.DISPUTE_ENABLED.toLowerCase() !== 'false',
        disputeRetryMs: Number(process.env.DISPUTE_RETRY_MS ?? 60_000),
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
        polymarketClobRequestTimeoutMs: Number(
            process.env.POLYMARKET_CLOB_REQUEST_TIMEOUT_MS ?? 15_000
        ),
        polymarketClobMaxRetries: Number(process.env.POLYMARKET_CLOB_MAX_RETRIES ?? 1),
        polymarketClobRetryDelayMs: Number(process.env.POLYMARKET_CLOB_RETRY_DELAY_MS ?? 250),
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
        polymarketRelayerChainId: process.env.POLYMARKET_RELAYER_CHAIN_ID
            ? Number(process.env.POLYMARKET_RELAYER_CHAIN_ID)
            : undefined,
        polymarketRelayerRequestTimeoutMs: Number(
            process.env.POLYMARKET_RELAYER_REQUEST_TIMEOUT_MS ?? 15_000
        ),
        polymarketRelayerPollIntervalMs: Number(
            process.env.POLYMARKET_RELAYER_POLL_INTERVAL_MS ?? 2_000
        ),
        polymarketRelayerPollTimeoutMs: Number(
            process.env.POLYMARKET_RELAYER_POLL_TIMEOUT_MS ?? 120_000
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
    };
}

export { buildConfig };
