import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
    buildMomentumPlan,
    computeClosedEpochIndex,
    getDeterministicToolCalls,
    getPendingDeposit,
    getPendingPlan,
    getPollingOptions,
    getPriceTriggers,
    getSubmittedEpochs,
    getSystemPrompt,
    onToolOutput,
    resetStrategyState,
    validateToolCalls,
} from './agent.js';

const ADDRESSES = Object.freeze({
    agent: '0x9000000000000000000000000000000000000009',
    ogModule: '0x5000000000000000000000000000000000000005',
    safe: '0x6000000000000000000000000000000000000006',
    usdc: '0x1000000000000000000000000000000000000001',
    weth: '0x2000000000000000000000000000000000000002',
    cbbtc: '0x3000000000000000000000000000000000000003',
});

const ALCHEMY_API_KEY = 'test-alchemy-key';
const PRICE_SYMBOLS = Object.freeze({
    WETH: 'ETH',
    cbBTC: 'BTC',
    USDC: 'USDC',
});

function createConfig({ stateFile, startBlock = 0n, balances = {}, omitStartBlock = false } = {}) {
    const config = {
        chainId: 11155111,
        rpcUrl: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        commitmentSafe: ADDRESSES.safe,
        ogModule: ADDRESSES.ogModule,
        proposeEnabled: true,
        disputeEnabled: false,
        proposalHashResolveTimeoutMs: 1_000,
        proposalHashResolvePollIntervalMs: 100,
        firstProxy: {
            tradeAmountUsd: '25',
            epochSeconds: 21600,
            daySeconds: 86400,
            pendingEpochTtlMs: 60_000,
            stateFile,
            priceFeed: {
                provider: 'alchemy',
                apiBaseUrl: 'https://api.g.alchemy.com/prices/v1',
                quoteCurrency: 'USD',
                symbols: PRICE_SYMBOLS,
            },
            tieBreakAssetOrder: ['WETH', 'cbBTC'],
        },
        byChain: {
            '11155111': {
                rpcUrl: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
                watchAssets: [ADDRESSES.usdc, ADDRESSES.weth, ADDRESSES.cbbtc],
                firstProxy: {
                    tokens: {
                        USDC: ADDRESSES.usdc,
                        WETH: ADDRESSES.weth,
                        cbBTC: ADDRESSES.cbbtc,
                    },
                },
            },
        },
        __test: {
            balances,
        },
    };
    if (!omitStartBlock && startBlock !== undefined && startBlock !== null) {
        config.startBlock = String(startBlock);
    }
    return config;
}

function createPublicClient({
    latestBlock = 7n,
    balances = {},
    history = {},
    deploymentBlock = 0n,
    onGetCode = null,
    onGetLogs = null,
    transactionReceiptsByHash = {},
    transactionsByHash = {},
}) {
    const proposalLogs = history.proposalLogs ?? [];
    const executedLogs = history.executedLogs ?? [];
    const deletedLogs = history.deletedLogs ?? [];
    let currentLatestBlock = BigInt(latestBlock);

    return {
        async getChainId() {
            return 11155111;
        },
        async getBlockNumber() {
            return currentLatestBlock;
        },
        async getBlock({ blockNumber }) {
            return { timestamp: BigInt(blockNumber) * 3600n };
        },
        async getCode({ blockNumber }) {
            onGetCode?.(BigInt(blockNumber));
            return BigInt(blockNumber) >= BigInt(deploymentBlock) ? '0x1234' : '0x';
        },
        async getTransactionReceipt({ hash }) {
            const key = String(hash).toLowerCase();
            if (Object.hasOwn(transactionReceiptsByHash, key)) {
                const value = transactionReceiptsByHash[key];
                if (value instanceof Error) throw value;
                return value;
            }
            const error = new Error(`Transaction receipt not found for ${hash}`);
            error.name = 'TransactionReceiptNotFoundError';
            throw error;
        },
        async getTransaction({ hash }) {
            const key = String(hash).toLowerCase();
            if (Object.hasOwn(transactionsByHash, key)) {
                const value = transactionsByHash[key];
                if (value instanceof Error) throw value;
                return value;
            }
            const error = new Error(`Transaction not found for ${hash}`);
            error.name = 'TransactionNotFoundError';
            throw error;
        },
        async readContract({ address, functionName, args }) {
            const normalized = address.toLowerCase();
            if (functionName === 'decimals') {
                if (normalized === ADDRESSES.usdc.toLowerCase()) return 6;
                if (normalized === ADDRESSES.weth.toLowerCase()) return 18;
                if (normalized === ADDRESSES.cbbtc.toLowerCase()) return 8;
            }
            if (functionName === 'balanceOf') {
                assert.equal(args[0].toLowerCase(), ADDRESSES.safe.toLowerCase());
                const symbol =
                    normalized === ADDRESSES.usdc.toLowerCase()
                        ? 'USDC'
                        : normalized === ADDRESSES.weth.toLowerCase()
                          ? 'WETH'
                          : 'cbBTC';
                return BigInt(balances[symbol] ?? 0n);
            }
            throw new Error(`Unexpected readContract ${functionName} ${address}`);
        },
        async getLogs({ event, fromBlock, toBlock }) {
            onGetLogs?.({
                eventName: event?.name,
                fromBlock: BigInt(fromBlock),
                toBlock: BigInt(toBlock),
            });
            const source =
                event?.name === 'TransactionsProposed'
                    ? proposalLogs
                    : event?.name === 'ProposalExecuted'
                      ? executedLogs
                      : event?.name === 'ProposalDeleted'
                        ? deletedLogs
                        : [];
            return source.filter(
                (log) => BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock)
            );
        },
        __setLatestBlock(nextBlock) {
            currentLatestBlock = BigInt(nextBlock);
        },
    };
}

function createPriceDataset({ current, range }) {
    return { current, range };
}

function jsonResponse(payload) {
    return {
        ok: true,
        status: 200,
        async json() {
            return payload;
        },
    };
}

async function withFetchMock(dataset, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === `/prices/v1/${ALCHEMY_API_KEY}/tokens/by-symbol`) {
            const symbols = url.searchParams.getAll('symbols');
            return jsonResponse({
                data: symbols.map((symbol) => ({
                    symbol,
                    prices:
                        dataset.current[symbol] === undefined
                            ? []
                            : [
                                  {
                                      currency: 'USD',
                                      value: String(dataset.current[symbol]),
                                      lastUpdatedAt: '2026-04-06T00:00:00Z',
                                  },
                              ],
                    error: null,
                })),
            });
        }

        if (url.pathname === `/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`) {
            const request = JSON.parse(String(init.body ?? '{}'));
            const symbol = request.symbol;
            const startTimeMs = Date.parse(String(request.startTime));
            const endTimeMs = Date.parse(String(request.endTime));
            const points = (dataset.range[symbol] ?? []).filter(
                ([timestampMs]) => timestampMs >= startTimeMs && timestampMs <= endTimeMs
            );
            return jsonResponse({
                data: {
                    symbol,
                    prices: points.map(([timestampMs, value]) => ({
                        value: String(value),
                        timestamp: new Date(timestampMs).toISOString(),
                    })),
                },
            });
        }

        throw new Error(`Unexpected fetch URL ${url.toString()}`);
    };

    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function createStateFile() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'first-proxy-'));
    return path.join(dir, 'state.json');
}

function parseToolArgs(call) {
    return JSON.parse(call.arguments);
}

async function advanceToProposalPhase({
    commitmentSafe = ADDRESSES.safe,
    agentAddress = ADDRESSES.agent,
    publicClient,
    config,
    depositTxHash,
}) {
    const depositCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe,
        agentAddress,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.equal(depositCalls.length, 1);
    assert.equal(depositCalls[0].name, 'make_deposit');

    const validatedDeposit = await validateToolCalls({
        toolCalls: depositCalls.map((call) => ({
            ...call,
            parsedArguments: parseToolArgs(call),
        })),
        commitmentSafe,
        agentAddress,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.equal(validatedDeposit.length, 1);

    await onToolOutput({
        name: 'make_deposit',
        parsedOutput: {
            status: 'confirmed',
            transactionHash: depositTxHash,
        },
        config,
    });

    const proposalCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe,
        agentAddress,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    return {
        depositCalls,
        validatedDeposit,
        proposalCalls,
    };
}

async function testPromptAndPolling() {
    const stateFile = await createStateFile();
    const config = createConfig({ stateFile });
    resetStrategyState({ config });

    const prompt = getSystemPrompt({
        commitmentText: 'Test first-proxy commitment.',
    });
    assert.ok(prompt.includes('deterministic first-proxy momentum agent'));
    assert.deepEqual(getPriceTriggers({ config }), []);
    assert.equal(getPollingOptions().emitBalanceSnapshotsEveryPoll, true);
}

async function testClosedEpochComputation() {
    assert.equal(
        computeClosedEpochIndex({
            nowSeconds: 21_599n,
            deploymentTimestampSeconds: 0n,
            epochSeconds: 21_600,
        }),
        -1
    );
    assert.equal(
        computeClosedEpochIndex({
            nowSeconds: 21_600n,
            deploymentTimestampSeconds: 0n,
            epochSeconds: 21_600,
        }),
        0
    );
    assert.equal(
        computeClosedEpochIndex({
            nowSeconds: 50_000n,
            deploymentTimestampSeconds: 0n,
            epochSeconds: 21_600,
        }),
        1
    );
}

async function testNoProposalBeforeFirstEpochCloses() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        WETH: 0n,
        cbBTC: 0n,
    };
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 5n,
        balances,
    });
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2100,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [5 * 3600 * 1000, 2100]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [5 * 3600 * 1000, 90]],
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.deepEqual(toolCalls, []);
    });
}

async function testNoActionsWhenProposalsDisabled() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        WETH: 0n,
        cbBTC: 0n,
    };
    const config = createConfig({ stateFile, balances });
    config.proposeEnabled = false;
    config.disputeEnabled = true;
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
    });
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2100,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [6 * 3600 * 1000, 2100]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.deepEqual(toolCalls, []);
    });
}

async function testNoActionsWhenProposalsDisabledWithoutTokenConfig() {
    const stateFile = await createStateFile();
    const config = createConfig({ stateFile });
    config.proposeEnabled = false;
    config.disputeEnabled = true;
    config.byChain = {};
    const publicClient = createPublicClient({
        latestBlock: 7n,
    });
    resetStrategyState({ config });

    const toolCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.deepEqual(toolCalls, []);
}

async function testEmptyValidationShortCircuitsWithoutTokenConfig() {
    const stateFile = await createStateFile();
    const config = createConfig({ stateFile });
    config.byChain = {};
    const publicClient = createPublicClient({
        latestBlock: 7n,
    });
    resetStrategyState({ config });

    const validated = await validateToolCalls({
        toolCalls: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.deepEqual(validated, []);
}

async function testWinnerSelectionAndSplitReimbursement() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'a'.repeat(64)}`;
    const balances = {
        cbBTC: 22_222_223n,
        USDC: 5_000_000n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [6 * 3600 * 1000, 2200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { depositCalls, proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });

        assert.equal(parseToolArgs(depositCalls[0]).asset.toLowerCase(), ADDRESSES.weth.toLowerCase());
        assert.ok(getPendingDeposit());
        assert.equal(proposalCalls.length, 2);

        const buildArgs = parseToolArgs(proposalCalls[0]);
        assert.equal(buildArgs.actions.length, 2);
        assert.equal(buildArgs.actions[0].token.toLowerCase(), ADDRESSES.cbbtc.toLowerCase());
        assert.equal(buildArgs.actions[1].token.toLowerCase(), ADDRESSES.usdc.toLowerCase());
        assert.equal(buildArgs.actions[0].to.toLowerCase(), ADDRESSES.agent.toLowerCase());
        assert.equal(buildArgs.actions[1].to.toLowerCase(), ADDRESSES.agent.toLowerCase());

        const postArgs = parseToolArgs(proposalCalls[1]);
        assert.ok(postArgs.explanation.includes('strategy=first-proxy-momentum'));
        assert.ok(postArgs.explanation.includes('epoch=0'));
        assert.ok(postArgs.explanation.includes('winner=WETH'));
        assert.ok(postArgs.explanation.includes('funding=cbBTC,USDC'));

        const validated = await validateToolCalls({
            toolCalls: proposalCalls.map((call) => ({
                ...call,
                parsedArguments: parseToolArgs(call),
            })),
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.equal(validated.length, 2);
        assert.equal(validated[0].parsedArguments.actions.length, 2);
        assert.equal(validated[1].parsedArguments.transactions.length, 2);
    });
}

async function testUsdcPreferredWhenBothMomentumAssetsUp() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'b'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        WETH: 10_000_000_000_000_000n,
        cbBTC: 10_000_000n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2300,
            [PRICE_SYMBOLS.cbBTC]: 55,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [6 * 3600 * 1000, 2300]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 50], [6 * 3600 * 1000, 55]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });
        const buildArgs = parseToolArgs(proposalCalls[0]);
        assert.equal(buildArgs.actions.length, 1);
        assert.equal(buildArgs.actions[0].token.toLowerCase(), ADDRESSES.usdc.toLowerCase());
    });
}

async function testValidateUsesUsdcSnapshotPrice() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'c'.repeat(64)}`;
    const balances = {
        USDC: 30_000_000n,
        WETH: 10_000_000_000_000_000n,
        cbBTC: 10_000_000n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2300,
            [PRICE_SYMBOLS.cbBTC]: 55,
            [PRICE_SYMBOLS.USDC]: 0.999,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [6 * 3600 * 1000, 2300]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 50], [6 * 3600 * 1000, 55]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 0.999]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });

        const validated = await validateToolCalls({
            toolCalls: proposalCalls.map((call) => ({
                ...call,
                parsedArguments: parseToolArgs(call),
            })),
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });

        const explanation = validated[1].parsedArguments.explanation;
        assert.ok(explanation.includes('usdcPriceMicros=999000'));
        assert.equal(validated[0].parsedArguments.actions.length, 1);
        assert.equal(validated[0].parsedArguments.actions[0].token.toLowerCase(), ADDRESSES.usdc.toLowerCase());
    });
}

async function testDepositSnapshotDoesNotLookAhead() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'d'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        WETH: 0n,
        cbBTC: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2000,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [
                [0, 1000],
                [6 * 3600 * 1000, 1200],
                [7 * 3600 * 1000 - 60_000, 1500],
                [7 * 3600 * 1000 + 60_000, 9000],
            ],
            [PRICE_SYMBOLS.cbBTC]: [
                [0, 100],
                [6 * 3600 * 1000, 90],
                [7 * 3600 * 1000 - 60_000, 90],
                [7 * 3600 * 1000 + 60_000, 900],
            ],
            [PRICE_SYMBOLS.USDC]: [
                [0, 1],
                [6 * 3600 * 1000, 1],
                [7 * 3600 * 1000 - 60_000, 1],
                [7 * 3600 * 1000 + 60_000, 2],
            ],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });
        const postArgs = parseToolArgs(proposalCalls[1]);
        assert.ok(postArgs.explanation.includes('wethPriceMicros=1500000000'));
        assert.ok(!postArgs.explanation.includes('wethPriceMicros=9000000000'));
        assert.ok(postArgs.explanation.includes('usdcPriceMicros=1000000'));
        assert.ok(!postArgs.explanation.includes('usdcPriceMicros=2000000'));
    });
}

async function testNoProposalWhenInsufficientReimbursementInventory() {
    const stateFile = await createStateFile();
    const balances = {
        cbBTC: 500_000n,
        USDC: 1_000_000n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 2200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 2000], [6 * 3600 * 1000, 2200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const toolCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.deepEqual(toolCalls, []);
    });
}

async function testPendingPlanReplayAfterDeposit() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'2'.repeat(64)}`;
    const proposalTxHash = `0x${'6'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });
        assert.ok(getPendingDeposit());
        assert.equal(getPendingPlan(), null);

        const validated = await validateToolCalls({
            toolCalls: proposalCalls.map((call) => ({
                ...call,
                parsedArguments: parseToolArgs(call),
            })),
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: proposalTxHash,
            },
            config,
        });
        assert.ok(getPendingPlan());
        assert.equal(getPendingDeposit(), null);
        assert.equal(validated[1].parsedArguments.explanation, getPendingPlan().explanation);
    });
}

async function testDeletedProposalReplaysWithoutRedeposit() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'9'.repeat(64)}`;
    const proposalTxHash = `0x${'a'.repeat(64)}`;
    const ogProposalHash = `0x${'b'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const initialClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient: initialClient,
            config,
            depositTxHash,
        });
        await validateToolCalls({
            toolCalls: proposalCalls.map((call) => ({
                ...call,
                parsedArguments: parseToolArgs(call),
            })),
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient: initialClient,
            config,
            onchainPendingProposal: false,
        });
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: proposalTxHash,
                ogProposalHash,
            },
            config,
        });

        const explanation = getPendingPlan().explanation;
        const deletedClient = createPublicClient({
            latestBlock: 8n,
            balances,
            history: {
                proposalLogs: [
                    {
                        blockNumber: 7n,
                        args: {
                            proposalHash: ogProposalHash,
                            explanation,
                        },
                    },
                ],
                deletedLogs: [
                    {
                        blockNumber: 8n,
                        args: {
                            proposalHash: ogProposalHash,
                        },
                    },
                ],
            },
        });

        const replayCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient: deletedClient,
            config,
            onchainPendingProposal: false,
        });
        assert.equal(replayCalls.length, 2);
        assert.equal(replayCalls[0].name, 'build_og_transactions');
        assert.equal(replayCalls[1].name, 'post_bond_and_propose');
    });
}

async function testSuppressesPendingOrPriorEpoch() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'3'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        const { proposalCalls } = await advanceToProposalPhase({
            publicClient,
            config,
            depositTxHash,
        });
        const validated = await validateToolCalls({
            toolCalls: proposalCalls.map((call) => ({
                ...call,
                parsedArguments: parseToolArgs(call),
            })),
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: `0x${'1'.repeat(64)}`,
            },
            config,
        });
        assert.ok(getSubmittedEpochs().has(0));
        assert.ok(getPendingPlan());

        const suppressedByState = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.deepEqual(suppressedByState, []);

        const suppressedByPending = await validateToolCalls({
            toolCalls: validated,
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: true,
        }).then(
            () => false,
            (error) => /Pending proposal/.test(error.message)
        );
        assert.equal(suppressedByPending, true);
    });
}

async function testDeploymentLookupCachedAcrossPolls() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
        },
    });
    const config = createConfig({ stateFile, balances, omitStartBlock: true });
    let getCodeCallCount = 0;
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        deploymentBlock: 3n,
        onGetCode: () => {
            getCodeCallCount += 1;
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        await buildMomentumPlan({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        const afterFirstPlan = getCodeCallCount;
        assert.ok(afterFirstPlan > 0);

        publicClient.__setLatestBlock(8n);
        await buildMomentumPlan({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        assert.equal(getCodeCallCount, afterFirstPlan);
    });
}

async function testProposalHistoryScannedIncrementally() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
        },
    });
    const getLogsCalls = [];
    const config = createConfig({ stateFile, balances, omitStartBlock: true });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        deploymentBlock: 3n,
        onGetLogs: (entry) => {
            getLogsCalls.push(entry);
        },
    });
    resetStrategyState({ config });

    await withFetchMock(prices, async () => {
        await buildMomentumPlan({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        const firstPassCalls = getLogsCalls.slice(-3);
        assert.deepEqual(
            firstPassCalls.map((entry) => entry.fromBlock.toString()),
            ['3', '3', '3']
        );

        publicClient.__setLatestBlock(8n);
        await buildMomentumPlan({
            signals: [],
            commitmentSafe: ADDRESSES.safe,
            agentAddress: ADDRESSES.agent,
            publicClient,
            config,
            onchainPendingProposal: false,
        });
        const secondPassCalls = getLogsCalls.slice(-3);
        assert.deepEqual(
            secondPassCalls.map((entry) => entry.fromBlock.toString()),
            ['8', '8', '8']
        );
    });
}

async function testSubmittedEpochRetainedWhileProposalTxPending() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'4'.repeat(64)}`;
    const proposalTxHash = `0x${'7'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    config.firstProxy.pendingEpochTtlMs = 1;
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
        transactionsByHash: {
            [proposalTxHash.toLowerCase()]: { hash: proposalTxHash },
        },
    });
    resetStrategyState({ config });

    const originalDateNow = Date.now;
    try {
        await withFetchMock(prices, async () => {
            const { proposalCalls } = await advanceToProposalPhase({
                publicClient,
                config,
                depositTxHash,
            });
            await validateToolCalls({
                toolCalls: proposalCalls.map((call) => ({
                    ...call,
                    parsedArguments: parseToolArgs(call),
                })),
                commitmentSafe: ADDRESSES.safe,
                agentAddress: ADDRESSES.agent,
                publicClient,
                config,
                onchainPendingProposal: false,
            });

            await onToolOutput({
                name: 'post_bond_and_propose',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: proposalTxHash,
                },
                config,
            });

            Date.now = () => originalDateNow() + 5_000;
            const suppressed = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: ADDRESSES.safe,
                agentAddress: ADDRESSES.agent,
                publicClient,
                config,
                onchainPendingProposal: false,
            });
            assert.deepEqual(suppressed, []);
        });
    } finally {
        Date.now = originalDateNow;
    }
}

async function testSubmittedEpochRecoversAfterDroppedTxAndExpiredTtl() {
    const stateFile = await createStateFile();
    const depositTxHash = `0x${'5'.repeat(64)}`;
    const proposalTxHash = `0x${'8'.repeat(64)}`;
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const prices = createPriceDataset({
        current: {
            [PRICE_SYMBOLS.WETH]: 1200,
            [PRICE_SYMBOLS.cbBTC]: 90,
            [PRICE_SYMBOLS.USDC]: 1,
        },
        range: {
            [PRICE_SYMBOLS.WETH]: [[0, 1000], [6 * 3600 * 1000, 1200]],
            [PRICE_SYMBOLS.cbBTC]: [[0, 100], [6 * 3600 * 1000, 90]],
            [PRICE_SYMBOLS.USDC]: [[0, 1], [6 * 3600 * 1000, 1]],
        },
    });
    const config = createConfig({ stateFile, balances });
    config.firstProxy.pendingEpochTtlMs = 1;
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        transactionReceiptsByHash: {
            [depositTxHash.toLowerCase()]: {
                status: 'success',
                blockNumber: 7n,
            },
        },
    });
    resetStrategyState({ config });

    const originalDateNow = Date.now;
    try {
        await withFetchMock(prices, async () => {
            const { proposalCalls } = await advanceToProposalPhase({
                publicClient,
                config,
                depositTxHash,
            });
            await validateToolCalls({
                toolCalls: proposalCalls.map((call) => ({
                    ...call,
                    parsedArguments: parseToolArgs(call),
                })),
                commitmentSafe: ADDRESSES.safe,
                agentAddress: ADDRESSES.agent,
                publicClient,
                config,
                onchainPendingProposal: false,
            });

            await onToolOutput({
                name: 'post_bond_and_propose',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: proposalTxHash,
                },
                config,
            });

            Date.now = () => originalDateNow() + 5_000;
            const retried = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: ADDRESSES.safe,
                agentAddress: ADDRESSES.agent,
                publicClient,
                config,
                onchainPendingProposal: false,
            });
            assert.equal(retried.length, 2);
            assert.equal(retried[0].name, 'build_og_transactions');
            assert.equal(retried[1].name, 'post_bond_and_propose');
        });
    } finally {
        Date.now = originalDateNow;
    }
}

async function run() {
    await testPromptAndPolling();
    await testClosedEpochComputation();
    await testNoProposalBeforeFirstEpochCloses();
    await testNoActionsWhenProposalsDisabled();
    await testNoActionsWhenProposalsDisabledWithoutTokenConfig();
    await testEmptyValidationShortCircuitsWithoutTokenConfig();
    await testWinnerSelectionAndSplitReimbursement();
    await testUsdcPreferredWhenBothMomentumAssetsUp();
    await testValidateUsesUsdcSnapshotPrice();
    await testDepositSnapshotDoesNotLookAhead();
    await testNoProposalWhenInsufficientReimbursementInventory();
    await testPendingPlanReplayAfterDeposit();
    await testDeletedProposalReplaysWithoutRedeposit();
    await testSuppressesPendingOrPriorEpoch();
    await testDeploymentLookupCachedAcrossPolls();
    await testProposalHistoryScannedIncrementally();
    await testSubmittedEpochRetainedWhileProposalTxPending();
    await testSubmittedEpochRecoversAfterDroppedTxAndExpiredTtl();
    console.log('[test] first-proxy deterministic momentum agent OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
