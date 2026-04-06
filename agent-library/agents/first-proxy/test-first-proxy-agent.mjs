import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
    buildMomentumPlan,
    computeClosedEpochIndex,
    getDeterministicToolCalls,
    getPendingPlan,
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
    wethUsdcPool: '0x4000000000000000000000000000000000000004',
    cbbtcUsdcPool: '0x7000000000000000000000000000000000000007',
});

function sqrtPriceX96ForQuotePerBase({ quotePerBase, baseDecimals, quoteDecimals }) {
    const raw = quotePerBase * 10 ** (quoteDecimals - baseDecimals);
    const sqrtPrice = Math.sqrt(raw);
    return BigInt(Math.floor(sqrtPrice * 2 ** 96));
}

function createConfig({ stateFile, startBlock = 0n, balances = {}, history = {}, nowBlock = 7n } = {}) {
    return {
        chainId: 11155111,
        commitmentSafe: ADDRESSES.safe,
        ogModule: ADDRESSES.ogModule,
        startBlock: String(startBlock),
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
            tieBreakAssetOrder: ['WETH', 'cbBTC'],
        },
        byChain: {
            '11155111': {
                watchAssets: [ADDRESSES.usdc, ADDRESSES.weth, ADDRESSES.cbbtc],
                firstProxy: {
                    tokens: {
                        USDC: ADDRESSES.usdc,
                        WETH: ADDRESSES.weth,
                        cbBTC: ADDRESSES.cbbtc,
                    },
                    valuationPools: {
                        WETH: {
                            pool: ADDRESSES.wethUsdcPool,
                            baseToken: ADDRESSES.weth,
                            quoteToken: ADDRESSES.usdc,
                        },
                        cbBTC: {
                            pool: ADDRESSES.cbbtcUsdcPool,
                            baseToken: ADDRESSES.cbbtc,
                            quoteToken: ADDRESSES.usdc,
                        },
                    },
                },
            },
        },
        __test: {
            balances,
            history,
            nowBlock,
        },
    };
}

function createPublicClient({
    latestBlock = 7n,
    balances = {},
    history = {},
}) {
    const poolPrices = {
        [ADDRESSES.wethUsdcPool.toLowerCase()]: {
            baseToken: ADDRESSES.weth,
            quoteToken: ADDRESSES.usdc,
            pricesByBlock: history.wethUsdcPrices ?? {},
        },
        [ADDRESSES.cbbtcUsdcPool.toLowerCase()]: {
            baseToken: ADDRESSES.cbbtc,
            quoteToken: ADDRESSES.usdc,
            pricesByBlock: history.cbbtcUsdcPrices ?? {},
        },
    };
    const proposalLogs = history.proposalLogs ?? [];
    const executedLogs = history.executedLogs ?? [];
    const deletedLogs = history.deletedLogs ?? [];

    function getPoolPrice(poolAddress, blockNumber) {
        const pool = poolPrices[poolAddress.toLowerCase()];
        if (!pool) {
            throw new Error(`Unknown pool ${poolAddress}`);
        }
        const key = Number(blockNumber);
        const exact = pool.pricesByBlock[key];
        if (exact !== undefined) {
            return exact;
        }
        const sortedKeys = Object.keys(pool.pricesByBlock)
            .map(Number)
            .sort((a, b) => a - b);
        let best = pool.pricesByBlock[sortedKeys[0]];
        for (const candidate of sortedKeys) {
            if (candidate <= key) {
                best = pool.pricesByBlock[candidate];
            }
        }
        return best;
    }

    return {
        async getChainId() {
            return 11155111;
        },
        async getBlockNumber() {
            return latestBlock;
        },
        async getBlock({ blockNumber }) {
            return { timestamp: BigInt(blockNumber) * 3600n };
        },
        async readContract({ address, functionName, args, blockNumber }) {
            const normalized = address.toLowerCase();
            if (functionName === 'decimals') {
                if (normalized === ADDRESSES.usdc.toLowerCase()) return 6;
                if (normalized === ADDRESSES.weth.toLowerCase()) return 18;
                if (normalized === ADDRESSES.cbbtc.toLowerCase()) return 8;
            }
            if (functionName === 'balanceOf') {
                const symbol =
                    normalized === ADDRESSES.usdc.toLowerCase()
                        ? 'USDC'
                        : normalized === ADDRESSES.weth.toLowerCase()
                          ? 'WETH'
                          : 'cbBTC';
                assert.equal(args[0].toLowerCase(), ADDRESSES.safe.toLowerCase());
                return BigInt(balances[symbol] ?? 0n);
            }
            if (functionName === 'token0') {
                return poolPrices[normalized]?.baseToken;
            }
            if (functionName === 'token1') {
                return poolPrices[normalized]?.quoteToken;
            }
            if (functionName === 'slot0') {
                const price = getPoolPrice(address, blockNumber ?? latestBlock);
                const baseDecimals =
                    normalized === ADDRESSES.cbbtcUsdcPool.toLowerCase() ? 8 : 18;
                return [
                    sqrtPriceX96ForQuotePerBase({
                        quotePerBase: price,
                        baseDecimals,
                        quoteDecimals: 6,
                    }),
                ];
            }
            throw new Error(`Unexpected readContract ${functionName} ${address}`);
        },
        async getLogs({ event, fromBlock, toBlock }) {
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
    };
}

async function createStateFile() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'first-proxy-'));
    return path.join(dir, 'state.json');
}

function parseToolArgs(call) {
    return JSON.parse(call.arguments);
}

async function testPromptAndHeartbeat() {
    const stateFile = await createStateFile();
    const config = createConfig({ stateFile });
    resetStrategyState({ config });

    const prompt = getSystemPrompt({
        commitmentText: 'Test first-proxy commitment.',
    });
    assert.ok(prompt.includes('deterministic first-proxy momentum agent'));

    const triggers = getPriceTriggers({ config });
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].comparator, 'gte');
    assert.equal(triggers[0].threshold, 0);
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
    const history = {
        wethUsdcPrices: { 0: 2000, 5: 2100 },
        cbbtcUsdcPrices: { 0: 100, 5: 90 },
    };
    const config = createConfig({ stateFile, balances, history, nowBlock: 5n });
    const publicClient = createPublicClient({
        latestBlock: 5n,
        balances,
        history,
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

async function testWinnerSelectionAndSplitReimbursement() {
    const stateFile = await createStateFile();
    const balances = {
        cbBTC: 22_222_223n,
        USDC: 5_000_000n,
        WETH: 0n,
    };
    const history = {
        wethUsdcPrices: {
            0: 2000,
            6: 2200,
            7: 2200,
        },
        cbbtcUsdcPrices: {
            0: 100,
            6: 90,
            7: 90,
        },
    };
    const config = createConfig({ stateFile, balances, history });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        history,
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

    assert.equal(toolCalls.length, 3);
    assert.equal(toolCalls[0].name, 'make_deposit');
    assert.equal(parseToolArgs(toolCalls[0]).asset.toLowerCase(), ADDRESSES.weth.toLowerCase());

    const buildArgs = parseToolArgs(toolCalls[1]);
    assert.equal(buildArgs.actions.length, 2);
    assert.equal(buildArgs.actions[0].token.toLowerCase(), ADDRESSES.cbbtc.toLowerCase());
    assert.equal(buildArgs.actions[1].token.toLowerCase(), ADDRESSES.usdc.toLowerCase());
    assert.equal(buildArgs.actions[0].to.toLowerCase(), ADDRESSES.agent.toLowerCase());
    assert.equal(buildArgs.actions[1].to.toLowerCase(), ADDRESSES.agent.toLowerCase());

    const postArgs = parseToolArgs(toolCalls[2]);
    assert.ok(postArgs.explanation.includes('strategy=first-proxy-momentum'));
    assert.ok(postArgs.explanation.includes('epoch=0'));
    assert.ok(postArgs.explanation.includes('winner=WETH'));
    assert.ok(postArgs.explanation.includes('funding=cbBTC,USDC'));

    const validated = await validateToolCalls({
        toolCalls: toolCalls.map((call) => ({
            ...call,
            parsedArguments: parseToolArgs(call),
        })),
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.equal(validated.length, 3);
    assert.equal(validated[1].parsedArguments.actions.length, 2);
    assert.equal(validated[2].parsedArguments.transactions.length, 2);
}

async function testUsdcPreferredWhenBothMomentumAssetsUp() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        WETH: 10_000_000_000_000_000n,
        cbBTC: 10_000_000n,
    };
    const history = {
        wethUsdcPrices: {
            0: 2000,
            6: 2300,
            7: 2300,
        },
        cbbtcUsdcPrices: {
            0: 50,
            6: 55,
            7: 55,
        },
    };
    const config = createConfig({ stateFile, balances, history });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        history,
    });
    resetStrategyState({ config });

    const plan = await buildMomentumPlan({
        signals: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });

    assert.equal(plan.winnerSymbol, 'WETH');
    assert.equal(plan.reimbursementLegs[0].tokenSymbol, 'USDC');
    assert.equal(plan.reimbursementLegs.length, 1);
}

async function testNoProposalWhenInsufficientReimbursementInventory() {
    const stateFile = await createStateFile();
    const balances = {
        cbBTC: 500_000n,
        USDC: 1_000_000n,
        WETH: 0n,
    };
    const history = {
        wethUsdcPrices: {
            0: 2000,
            6: 2200,
            7: 2200,
        },
        cbbtcUsdcPrices: {
            0: 100,
            6: 90,
            7: 90,
        },
    };
    const config = createConfig({ stateFile, balances, history });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        history,
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

async function testPendingPlanReplayAfterDeposit() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const history = {
        wethUsdcPrices: {
            0: 1000,
            6: 1200,
            7: 1200,
        },
        cbbtcUsdcPrices: {
            0: 100,
            6: 90,
            7: 90,
        },
    };
    const config = createConfig({ stateFile, balances, history });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        history,
    });
    resetStrategyState({ config });

    const baseCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    const validated = await validateToolCalls({
        toolCalls: baseCalls.map((call) => ({
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
        name: 'make_deposit',
        parsedOutput: {
            status: 'confirmed',
            transactionHash: `0x${'2'.repeat(64)}`,
        },
        config,
    });
    assert.ok(getPendingPlan());

    const replayCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.equal(replayCalls.length, 2);
    assert.equal(replayCalls[0].name, 'build_og_transactions');
    assert.equal(replayCalls[1].name, 'post_bond_and_propose');

    const replayValidated = await validateToolCalls({
        toolCalls: replayCalls.map((call) => ({
            ...call,
            parsedArguments: parseToolArgs(call),
        })),
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    assert.equal(replayValidated.length, 2);
    assert.equal(validated[2].parsedArguments.explanation, replayValidated[1].parsedArguments.explanation);
}

async function testSuppressesPendingOrPriorEpoch() {
    const stateFile = await createStateFile();
    const balances = {
        USDC: 25_000_000n,
        cbBTC: 0n,
        WETH: 0n,
    };
    const history = {
        wethUsdcPrices: {
            0: 1000,
            6: 1200,
            7: 1200,
        },
        cbbtcUsdcPrices: {
            0: 100,
            6: 90,
            7: 90,
        },
    };
    const config = createConfig({ stateFile, balances, history });
    const publicClient = createPublicClient({
        latestBlock: 7n,
        balances,
        history,
    });
    resetStrategyState({ config });

    const baseCalls = await getDeterministicToolCalls({
        signals: [],
        commitmentSafe: ADDRESSES.safe,
        agentAddress: ADDRESSES.agent,
        publicClient,
        config,
        onchainPendingProposal: false,
    });
    const validated = await validateToolCalls({
        toolCalls: baseCalls.map((call) => ({
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
        name: 'make_deposit',
        parsedOutput: {
            status: 'confirmed',
            transactionHash: `0x${'3'.repeat(64)}`,
        },
        config,
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
    assert.equal(getPendingPlan(), null);

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
}

async function run() {
    await testPromptAndHeartbeat();
    await testClosedEpochComputation();
    await testNoProposalBeforeFirstEpochCloses();
    await testWinnerSelectionAndSplitReimbursement();
    await testUsdcPreferredWhenBothMomentumAssetsUp();
    await testNoProposalWhenInsufficientReimbursementInventory();
    await testPendingPlanReplayAfterDeposit();
    await testSuppressesPendingOrPriorEpoch();
    console.log('[test] first-proxy deterministic momentum agent OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
