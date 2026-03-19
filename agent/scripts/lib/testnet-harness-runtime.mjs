import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadAgentConfigStack, resolveAgentRuntimeConfig } from '../../src/lib/agent-config.js';
import { resolveHarnessProfile } from './testnet-harness-profiles.mjs';

function createHarnessBaseConfig({ env = process.env } = {}) {
    return {
        rpcUrl: env.RPC_URL ?? 'http://127.0.0.1:8545',
        commitmentSafe: undefined,
        ogModule: undefined,
        watchAssets: [],
        watchErc1155Assets: [],
        pollIntervalMs: 10_000,
        logChunkSize: undefined,
        startBlock: undefined,
        watchNativeBalance: true,
        defaultDepositAsset: undefined,
        defaultDepositAmountWei: undefined,
        bondSpender: 'og',
        openAiApiKey: undefined,
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
        agentModule: undefined,
        chainlinkPriceFeed: undefined,
        polymarketConditionalTokens: undefined,
        polymarketExchange: undefined,
        polymarketClobEnabled: false,
        polymarketClobHost: 'https://clob.polymarket.com',
        polymarketClobAddress: undefined,
        polymarketClobSignatureType: undefined,
        polymarketClobApiKey: undefined,
        polymarketClobApiSecret: undefined,
        polymarketClobApiPassphrase: undefined,
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
        polymarketApiKey: undefined,
        polymarketApiSecret: undefined,
        polymarketApiPassphrase: undefined,
        polymarketBuilderApiKey: undefined,
        polymarketBuilderSecret: undefined,
        polymarketBuilderPassphrase: undefined,
        uniswapV3Factory: undefined,
        uniswapV3Quoter: undefined,
        uniswapV3FeeTiers: [500, 3000, 10000],
        messageApiEnabled: false,
        messageApiHost: '127.0.0.1',
        messageApiPort: 8787,
        messageApiKeys: {},
        messageApiRequireSignerAllowlist: true,
        messageApiSignerAllowlist: [],
        messageApiSignatureMaxAgeSeconds: 300,
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
        ipfsEnabled: false,
        ipfsApiUrl: 'http://127.0.0.1:5001',
        ipfsHeaders: {},
        ipfsRequestTimeoutMs: 15_000,
        ipfsMaxRetries: 1,
        ipfsRetryDelayMs: 250,
    };
}

function resolveAgentModulePath(repoRootPath, agentRef) {
    const modulePath = agentRef.includes('/')
        ? agentRef
        : `agent-library/agents/${agentRef}/agent.js`;
    return path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(repoRootPath, modulePath);
}

async function readCommitmentText(commitmentPath) {
    try {
        return (await readFile(commitmentPath, 'utf8')).trim();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

async function resolveHarnessRuntimeContext({
    repoRootPath,
    agentRef,
    profileName,
    overlayPath,
    env = process.env,
}) {
    const profile = resolveHarnessProfile(profileName, { env });
    const modulePath = resolveAgentModulePath(repoRootPath, agentRef);
    const moduleDir = path.dirname(modulePath);
    const configPath = path.join(moduleDir, 'config.json');
    const commitmentPath = path.join(moduleDir, 'commitment.txt');
    const configStack = await loadAgentConfigStack(configPath, {
        overlayPaths: overlayPath ? [overlayPath] : [],
        env,
    });
    const runtimeConfig = resolveAgentRuntimeConfig({
        baseConfig: {
            ...createHarnessBaseConfig({ env }),
            rpcUrl: env.RPC_URL ?? profile.rpcUrl ?? 'http://127.0.0.1:8545',
        },
        agentConfigFile: configStack,
        chainId: profile.chainId,
    });

    return {
        profile,
        modulePath,
        moduleDir,
        configPath,
        commitmentPath,
        commitmentText: await readCommitmentText(commitmentPath),
        configStack,
        runtimeConfig,
    };
}

export {
    createHarnessBaseConfig,
    readCommitmentText,
    resolveAgentModulePath,
    resolveHarnessRuntimeContext,
};
