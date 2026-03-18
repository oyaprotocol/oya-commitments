import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { buildConfig } from '../src/lib/config.js';
import {
    loadAgentConfigFile,
    loadAgentConfigStack,
    resolveAgentRuntimeConfig,
} from '../src/lib/agent-config.js';

const RPC_URL = 'http://127.0.0.1:8545';
const ENV_ERC20 = '0x1111111111111111111111111111111111111111';
const FILE_ERC20 = '0x2222222222222222222222222222222222222222';
const FILE_CHAIN_ERC20 = '0x3333333333333333333333333333333333333333';
const ENV_ERC1155 = '0x4444444444444444444444444444444444444444';
const FILE_ERC1155 = '0x5555555555555555555555555555555555555555';
const ENV_SAFE = '0x6666666666666666666666666666666666666666';
const FILE_SAFE = '0x7777777777777777777777777777777777777777';
const ENV_OG = '0x8888888888888888888888888888888888888888';
const FILE_OG = '0x9999999999999999999999999999999999999999';
const FILE_SIGNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAIN_SIGNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MANAGED_ENV_KEYS = ['RPC_URL', 'COMMITMENT_SAFE', 'OG_MODULE'];

function withManagedEnv(overrides, fn) {
    const previous = new Map();
    for (const key of MANAGED_ENV_KEYS) {
        previous.set(key, process.env[key]);
    }

    try {
        process.env.RPC_URL = RPC_URL;
        for (const key of MANAGED_ENV_KEYS) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                const nextValue = overrides[key];
                if (nextValue === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = String(nextValue);
                }
            }
        }
        return fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agent-config-file-'));
    const missingPath = path.join(tmpDir, 'missing-config.json');

    withManagedEnv(
        {
            COMMITMENT_SAFE: undefined,
            OG_MODULE: undefined,
        },
        () => {
            const config = buildConfig();
            assert.equal(config.commitmentSafe, undefined);
            assert.equal(config.ogModule, undefined);
        }
    );

    const baseConfig = {
        commitmentSafe: ENV_SAFE,
        ogModule: ENV_OG,
        watchAssets: [ENV_ERC20],
        watchErc1155Assets: [
            {
                token: ENV_ERC1155,
                tokenId: '9',
                symbol: 'ENV-1155',
            },
        ],
        pollIntervalMs: 10_000,
        logChunkSize: 5_000n,
        startBlock: 12_345n,
        watchNativeBalance: true,
        defaultDepositAsset: ENV_ERC20,
        defaultDepositAmountWei: 777n,
        bondSpender: 'og',
        openAiModel: 'gpt-4.1-mini',
        openAiBaseUrl: 'https://api.openai.example/v1',
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
        chainlinkPriceFeed: ENV_SAFE,
        polymarketConditionalTokens: ENV_ERC1155,
        polymarketExchange: ENV_OG,
        polymarketClobEnabled: false,
        polymarketClobHost: 'https://clob.base.example',
        polymarketClobAddress: ENV_SAFE,
        polymarketClobSignatureType: 'EOA',
        polymarketClobRequestTimeoutMs: 15_000,
        polymarketClobMaxRetries: 1,
        polymarketClobRetryDelayMs: 250,
        polymarketRelayerEnabled: false,
        polymarketRelayerHost: 'https://relayer.base.example',
        polymarketRelayerTxType: 'SAFE',
        polymarketRelayerFromAddress: ENV_SAFE,
        polymarketRelayerSafeFactory: ENV_OG,
        polymarketRelayerProxyFactory: ENV_ERC1155,
        polymarketRelayerResolveProxyAddress: true,
        polymarketRelayerAutoDeployProxy: false,
        polymarketRelayerChainId: 11155111,
        polymarketRelayerRequestTimeoutMs: 15_000,
        polymarketRelayerPollIntervalMs: 2_000,
        polymarketRelayerPollTimeoutMs: 120_000,
        uniswapV3Factory: ENV_SAFE,
        uniswapV3Quoter: ENV_OG,
        uniswapV3FeeTiers: [500, 3000, 10000],
        ipfsEnabled: false,
        ipfsApiUrl: 'http://127.0.0.1:5001',
        ipfsRequestTimeoutMs: 15_000,
        ipfsMaxRetries: 1,
        ipfsRetryDelayMs: 250,
        messageApiEnabled: false,
        messageApiHost: '127.0.0.1',
        messageApiPort: 8787,
        messageApiKeys: { env: 'env-token' },
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
    };

    const missingFile = await loadAgentConfigFile(missingPath);
    assert.equal(missingFile.exists, false);
    const fallbackResolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile: missingFile,
        chainId: 11155111,
    });
    assert.deepEqual(fallbackResolved.watchAssets, [ENV_ERC20]);
    assert.deepEqual(fallbackResolved.watchErc1155Assets, baseConfig.watchErc1155Assets);
    assert.deepEqual(fallbackResolved.agentConfig, {});
    assert.equal(fallbackResolved.commitmentSafe, ENV_SAFE);
    assert.equal(fallbackResolved.ogModule, ENV_OG);

    const configPath = path.join(tmpDir, 'config.json');
    await writeFile(
        configPath,
        JSON.stringify(
            {
                policyName: 'fast-withdraw',
                commitmentSafe: FILE_SAFE,
                watchAssets: [FILE_ERC20],
                pollIntervalMs: 15_000,
                logChunkSize: '9_000'.replace('_', ''),
                watchNativeBalance: false,
                defaultDepositAsset: FILE_ERC20,
                defaultDepositAmountWei: '1234567',
                bondSpender: 'both',
                openAiModel: 'gpt-5-mini',
                openAiBaseUrl: 'https://openai.config.example/v1',
                openAiRequestTimeoutMs: 45_000,
                allowProposeOnSimulationFail: true,
                proposeGasLimit: '3000000',
                executeRetryMs: 30_000,
                executePendingTxTimeoutMs: 600_000,
                proposeEnabled: false,
                disputeEnabled: true,
                disputeRetryMs: 45_000,
                proposalHashResolveTimeoutMs: 20_000,
                proposalHashResolvePollIntervalMs: 2_500,
                chainlinkPriceFeed: FILE_SAFE,
                polymarketConditionalTokens: FILE_ERC1155,
                polymarketExchange: FILE_OG,
                polymarketClobEnabled: true,
                polymarketClobHost: 'https://clob.config.example',
                polymarketClobAddress: FILE_SAFE,
                polymarketClobSignatureType: 'POLY_PROXY',
                polymarketClobRequestTimeoutMs: 12_000,
                polymarketClobMaxRetries: 2,
                polymarketClobRetryDelayMs: 300,
                polymarketRelayerEnabled: true,
                polymarketRelayerHost: 'https://relayer.config.example',
                polymarketRelayerTxType: 'PROXY',
                polymarketRelayerFromAddress: FILE_SAFE,
                polymarketRelayerSafeFactory: FILE_OG,
                polymarketRelayerProxyFactory: FILE_ERC1155,
                polymarketRelayerResolveProxyAddress: false,
                polymarketRelayerAutoDeployProxy: true,
                polymarketRelayerChainId: 137,
                polymarketRelayerRequestTimeoutMs: 18_000,
                polymarketRelayerPollIntervalMs: 3_000,
                polymarketRelayerPollTimeoutMs: 180_000,
                uniswapV3Factory: FILE_SAFE,
                uniswapV3Quoter: FILE_OG,
                uniswapV3FeeTiers: [100, 500],
                ipfsEnabled: true,
                ipfsApiUrl: 'http://ipfs.config.example:5001',
                ipfsRequestTimeoutMs: 20_000,
                ipfsMaxRetries: 4,
                ipfsRetryDelayMs: 500,
                copyTrading: {
                    sourceUser: FILE_SIGNER,
                    market: 'shared-market',
                    yesTokenId: '111',
                    noTokenId: '222',
                },
                messageApi: {
                    enabled: true,
                    host: '0.0.0.0',
                    port: 9999,
                    requireSignerAllowlist: true,
                    signerAllowlist: [FILE_SIGNER],
                    rateLimitPerMinute: 12,
                },
                byChain: {
                    '11155111': {
                        ogModule: FILE_OG,
                        watchAssets: [FILE_CHAIN_ERC20],
                        startBlock: '999999',
                        proposeEnabled: true,
                        polymarketRelayerPollTimeoutMs: 222_000,
                        ipfsRetryDelayMs: 750,
                        copyTrading: {
                            market: 'chain-market',
                        },
                        messageApi: {
                            port: 9898,
                            requireSignerAllowlist: false,
                            signerAllowlist: [CHAIN_SIGNER],
                            batchSize: 7,
                        },
                        watchErc1155Assets: [
                            {
                                token: FILE_ERC1155,
                                tokenId: '42',
                                symbol: 'FILE-1155',
                            },
                        ],
                        fillConfirmationThreshold: 5,
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const agentConfigFile = await loadAgentConfigFile(configPath);
    assert.equal(agentConfigFile.exists, true);
    const resolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile,
        chainId: 11155111,
    });
    assert.deepEqual(resolved.watchAssets, [FILE_CHAIN_ERC20]);
    assert.deepEqual(resolved.watchErc1155Assets, [
        {
            token: FILE_ERC1155,
            tokenId: '42',
            symbol: 'FILE-1155',
        },
    ]);
    assert.equal(resolved.agentConfig.policyName, 'fast-withdraw');
    assert.equal(resolved.agentConfig.fillConfirmationThreshold, 5);
    assert.equal(resolved.commitmentSafe, FILE_SAFE);
    assert.equal(resolved.ogModule, FILE_OG);
    assert.equal(resolved.agentConfig.commitmentSafe, FILE_SAFE);
    assert.equal(resolved.agentConfig.ogModule, FILE_OG);
    assert.equal(resolved.pollIntervalMs, 15_000);
    assert.equal(resolved.logChunkSize, 9000n);
    assert.equal(resolved.startBlock, 999999n);
    assert.equal(resolved.watchNativeBalance, false);
    assert.equal(resolved.defaultDepositAsset, getAddress(FILE_ERC20));
    assert.equal(resolved.defaultDepositAmountWei, 1234567n);
    assert.equal(resolved.bondSpender, 'both');
    assert.equal(resolved.openAiModel, 'gpt-5-mini');
    assert.equal(resolved.openAiBaseUrl, 'https://openai.config.example/v1');
    assert.equal(resolved.openAiRequestTimeoutMs, 45_000);
    assert.equal(resolved.allowProposeOnSimulationFail, true);
    assert.equal(resolved.proposeGasLimit, 3000000n);
    assert.equal(resolved.executeRetryMs, 30_000);
    assert.equal(resolved.executePendingTxTimeoutMs, 600_000);
    assert.equal(resolved.proposeEnabled, true);
    assert.equal(resolved.disputeEnabled, true);
    assert.equal(resolved.disputeRetryMs, 45_000);
    assert.equal(resolved.proposalHashResolveTimeoutMs, 20_000);
    assert.equal(resolved.proposalHashResolvePollIntervalMs, 2_500);
    assert.equal(resolved.chainlinkPriceFeed, getAddress(FILE_SAFE));
    assert.equal(resolved.polymarketConditionalTokens, getAddress(FILE_ERC1155));
    assert.equal(resolved.polymarketExchange, getAddress(FILE_OG));
    assert.equal(resolved.polymarketClobEnabled, true);
    assert.equal(resolved.polymarketClobHost, 'https://clob.config.example');
    assert.equal(resolved.polymarketClobAddress, getAddress(FILE_SAFE));
    assert.equal(resolved.polymarketClobSignatureType, 'POLY_PROXY');
    assert.equal(resolved.polymarketClobRequestTimeoutMs, 12_000);
    assert.equal(resolved.polymarketClobMaxRetries, 2);
    assert.equal(resolved.polymarketClobRetryDelayMs, 300);
    assert.equal(resolved.polymarketRelayerEnabled, true);
    assert.equal(resolved.polymarketRelayerHost, 'https://relayer.config.example');
    assert.equal(resolved.polymarketRelayerTxType, 'PROXY');
    assert.equal(resolved.polymarketRelayerFromAddress, getAddress(FILE_SAFE));
    assert.equal(resolved.polymarketRelayerSafeFactory, getAddress(FILE_OG));
    assert.equal(resolved.polymarketRelayerProxyFactory, getAddress(FILE_ERC1155));
    assert.equal(resolved.polymarketRelayerResolveProxyAddress, false);
    assert.equal(resolved.polymarketRelayerAutoDeployProxy, true);
    assert.equal(resolved.polymarketRelayerChainId, 137);
    assert.equal(resolved.polymarketRelayerRequestTimeoutMs, 18_000);
    assert.equal(resolved.polymarketRelayerPollIntervalMs, 3_000);
    assert.equal(resolved.polymarketRelayerPollTimeoutMs, 222_000);
    assert.equal(resolved.uniswapV3Factory, getAddress(FILE_SAFE));
    assert.equal(resolved.uniswapV3Quoter, getAddress(FILE_OG));
    assert.deepEqual(resolved.uniswapV3FeeTiers, [100, 500]);
    assert.equal(resolved.ipfsEnabled, true);
    assert.equal(resolved.ipfsApiUrl, 'http://ipfs.config.example:5001');
    assert.equal(resolved.ipfsRequestTimeoutMs, 20_000);
    assert.equal(resolved.ipfsMaxRetries, 4);
    assert.equal(resolved.ipfsRetryDelayMs, 750);
    assert.deepEqual(resolved.agentConfig.copyTrading, {
        sourceUser: FILE_SIGNER,
        market: 'chain-market',
        yesTokenId: '111',
        noTokenId: '222',
    });
    assert.equal(resolved.messageApiEnabled, true);
    assert.equal(resolved.messageApiHost, '0.0.0.0');
    assert.equal(resolved.messageApiPort, 9898);
    assert.deepEqual(resolved.messageApiKeys, { env: 'env-token' });
    assert.equal(resolved.messageApiRequireSignerAllowlist, false);
    assert.deepEqual(resolved.messageApiSignerAllowlist, [getAddress(CHAIN_SIGNER)]);
    assert.equal(resolved.messageApiBatchSize, 7);
    assert.equal(resolved.messageApiRateLimitPerMinute, 12);
    assert.deepEqual(resolved.agentConfig.messageApi.signerAllowlist, [getAddress(CHAIN_SIGNER)]);

    const configLocalPath = path.join(tmpDir, 'config.local.json');
    const overlayOnePath = path.join(tmpDir, 'overlay-one.json');
    const overlayTwoPath = path.join(tmpDir, 'overlay-two.json');
    await writeFile(
        configLocalPath,
        JSON.stringify(
            {
                pollIntervalMs: 21_000,
                byChain: {
                    '11155111': {
                        ipfsRetryDelayMs: 900,
                        copyTrading: {
                            yesTokenId: '333',
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );
    await writeFile(
        overlayOnePath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        proposeEnabled: false,
                        copyTrading: {
                            market: 'overlay-market-one',
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );
    await writeFile(
        overlayTwoPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        defaultDepositAmountWei: '7654321',
                        copyTrading: {
                            noTokenId: '444',
                        },
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const stackedAgentConfig = await loadAgentConfigStack(configPath, {
        env: {
            AGENT_CONFIG_OVERLAY_PATH: overlayOnePath,
            AGENT_CONFIG_OVERLAY_PATHS: overlayTwoPath,
        },
    });
    assert.equal(stackedAgentConfig.exists, true);
    assert.deepEqual(
        stackedAgentConfig.layers.map((layer) => ({
            kind: layer.kind,
            path: path.basename(layer.path),
            exists: layer.exists,
        })),
        [
            { kind: 'config', path: 'config.json', exists: true },
            { kind: 'local', path: 'config.local.json', exists: true },
            { kind: 'overlay', path: 'overlay-one.json', exists: true },
            { kind: 'overlay', path: 'overlay-two.json', exists: true },
        ]
    );

    const stackedResolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile: stackedAgentConfig,
        chainId: 11155111,
    });
    assert.equal(stackedResolved.pollIntervalMs, 21_000);
    assert.equal(stackedResolved.proposeEnabled, false);
    assert.equal(stackedResolved.defaultDepositAmountWei, 7654321n);
    assert.equal(stackedResolved.ipfsRetryDelayMs, 900);
    assert.deepEqual(stackedResolved.agentConfig.copyTrading, {
        sourceUser: FILE_SIGNER,
        market: 'overlay-market-one',
        yesTokenId: '333',
        noTokenId: '444',
    });

    await writeFile(
        configPath,
        JSON.stringify(
            {
                byChain: {
                    '11155111': {
                        commitmentSafe: null,
                        ogModule: null,
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const nullFallbackFile = await loadAgentConfigFile(configPath);
    const nullFallbackResolved = resolveAgentRuntimeConfig({
        baseConfig,
        agentConfigFile: nullFallbackFile,
        chainId: 11155111,
    });
    assert.equal(nullFallbackResolved.commitmentSafe, ENV_SAFE);
    assert.equal(nullFallbackResolved.ogModule, ENV_OG);
    assert.equal(nullFallbackResolved.agentConfig.commitmentSafe, ENV_SAFE);
    assert.equal(nullFallbackResolved.agentConfig.ogModule, ENV_OG);
    assert.equal(nullFallbackResolved.messageApiEnabled, false);
    assert.equal(nullFallbackResolved.messageApiPort, 8787);

    await writeFile(
        configPath,
        JSON.stringify(
            {
                messageApi: {
                    keys: {
                        ops: 'secret-token',
                    },
                },
            },
            null,
            2
        ),
        'utf8'
    );

    const invalidMessageApiFile = await loadAgentConfigFile(configPath);
    assert.throws(
        () =>
            resolveAgentRuntimeConfig({
                baseConfig,
                agentConfigFile: invalidMessageApiFile,
                chainId: 11155111,
            }),
        /field "messageApi"\.keys is not supported in config\.json/
    );

    await writeFile(
        configPath,
        JSON.stringify(
            {
                byChain: [],
            },
            null,
            2
        ),
        'utf8'
    );

    const invalidByChainFile = await loadAgentConfigFile(configPath);
    assert.throws(
        () =>
            resolveAgentRuntimeConfig({
                baseConfig,
                agentConfigFile: invalidByChainFile,
                chainId: 11155111,
            }),
        /field "byChain" must be a JSON object/
    );

    console.log('[test] agent config file OK');
}

run().catch((error) => {
    console.error('[test] agent config file failed:', error?.message ?? error);
    process.exit(1);
});
