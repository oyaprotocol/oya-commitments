import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi } from 'viem';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    buildSignedTradeIntentArchiveArtifact,
    computeBuyOrderAmounts,
    enrichSignals,
    getDeterministicToolCalls,
    getPollingOptions,
    getSystemPrompt,
    getTradeIntentState,
    interpretSignedTradeIntentSignal,
    onProposalEvents,
    onToolOutput,
    resetTradeIntentState,
    setTradeIntentStatePathForTest,
} from './agent.js';

const TEST_SIGNER = '0x1111111111111111111111111111111111111111';
const TEST_AGENT = '0x2222222222222222222222222222222222222222';
const TEST_SAFE = '0x3333333333333333333333333333333333333333';
const TEST_OTHER_SIGNER = '0x5555555555555555555555555555555555555555';
const TEST_OTHER_AGENT = '0x6666666666666666666666666666666666666666';
const TEST_OTHER_SAFE = '0x7777777777777777777777777777777777777777';
const TEST_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const TEST_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const TEST_OG_MODULE = '0x4444444444444444444444444444444444444444';
const YES_TOKEN_ID = '101';
const NO_TOKEN_ID = '202';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;
const TEST_PROPOSAL_HASH = `0x${'a'.repeat(64)}`;
const TEST_ORDER_ID = 'order-1';
const TEST_TIMEOUT_ORDER_ID = 'order-timeout';
const TEST_REJECTED_ORDER_ID = 'order-rejected';
const TEST_DEPOSIT_TX_HASH = `0x${'b'.repeat(64)}`;
const TEST_REIMBURSE_TX_HASH = `0x${'c'.repeat(64)}`;

function buildModuleConfig(overrides = {}) {
    const baseAgentConfig = {
        polymarketIntentTrader: {
            authorizedAgent: TEST_AGENT,
            marketId: 'market-123',
            minimumTickSize: '0.01',
            yesTokenId: YES_TOKEN_ID,
            noTokenId: NO_TOKEN_ID,
            collateralToken: TEST_USDC,
            ctfContract: TEST_CTF,
        },
    };
    const overrideAgentConfig = overrides.agentConfig ?? {};
    return {
        commitmentSafe: TEST_SAFE,
        chainId: 137,
        ogModule: TEST_OG_MODULE,
        startBlock: 0,
        ipfsEnabled: true,
        proposeEnabled: true,
        polymarketClobEnabled: true,
        polymarketClobApiKey: 'k_test',
        polymarketClobApiSecret: 's_test',
        polymarketClobApiPassphrase: 'p_test',
        polymarketClobAddress: TEST_AGENT,
        watchAssets: [TEST_USDC],
        watchErc1155Assets: [
            {
                token: TEST_CTF,
                tokenId: YES_TOKEN_ID,
                symbol: 'YES',
            },
            {
                token: TEST_CTF,
                tokenId: NO_TOKEN_ID,
                symbol: 'NO',
            },
        ],
        polymarketConditionalTokens: TEST_CTF,
        ...overrides,
        agentConfig: {
            ...baseAgentConfig,
            ...overrideAgentConfig,
            polymarketIntentTrader: {
                ...baseAgentConfig.polymarketIntentTrader,
                ...(overrideAgentConfig.polymarketIntentTrader ?? {}),
            },
        },
    };
}

function buildErc20TransferCalldata(to, amountWei) {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, BigInt(amountWei)],
    });
}

function formatUtcDeadlineForDefaultText(deadlineMs) {
    const deadlineDate = new Date(deadlineMs);
    const year = deadlineDate.getUTCFullYear();
    const month = String(deadlineDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(deadlineDate.getUTCDate()).padStart(2, '0');
    const hour = String(deadlineDate.getUTCHours()).padStart(2, '0');
    const minute = String(deadlineDate.getUTCMinutes()).padStart(2, '0');
    const second = String(deadlineDate.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

async function writeTradeIntentStateFixture(stateFilePath, partialState) {
    const baseState = {
        version: 4,
        nextSequence: 3,
        intents: {},
        deposits: {},
        reimbursementCommitments: {},
        pendingExecutedProposalHashes: [],
        pendingDeletedProposalHashes: [],
        backfilledDepositsThroughBlock: '0',
        backfilledReimbursementCommitmentsThroughBlock: '0',
    };
    await writeFile(
        stateFilePath,
        JSON.stringify(
            {
                ...baseState,
                ...partialState,
            },
            null,
            2
        ),
        'utf8'
    );
}

function buildSignedMessageSignal(overrides = {}) {
    const requestId = overrides.requestId ?? 'pm-intent-001';
    const receivedAtMs = overrides.receivedAtMs ?? 1_800_000_000_000;
    const defaultDeadline = (() => {
        const receivedDate = new Date(receivedAtMs);
        return Date.UTC(
            receivedDate.getUTCFullYear(),
            receivedDate.getUTCMonth(),
            receivedDate.getUTCDate(),
            18,
            0,
            0,
            0
        );
    })();
    const deadline = overrides.deadline ?? defaultDeadline;

    return {
        kind: 'userMessage',
        messageId: overrides.messageId ?? `msg_${requestId}`,
        requestId,
        text:
            overrides.text ??
            `Buy NO for up to 25 USDC if the price is 0.42 or better before ${formatUtcDeadlineForDefaultText(deadline)}.`,
        command: overrides.command ?? 'buy',
        args: overrides.args ?? {
            ignored: true,
        },
        metadata: overrides.metadata ?? {
            source: 'test-suite',
        },
        chainId: overrides.chainId ?? 137,
        receivedAtMs,
        expiresAtMs: overrides.expiresAtMs ?? deadline,
        deadline,
        sender: {
            authType: 'eip191',
            address: overrides.signer ?? TEST_SIGNER,
            signature: overrides.signature ?? TEST_SIGNATURE,
            signedAtMs: overrides.signedAtMs ?? receivedAtMs,
        },
    };
}

function buildFetchResponse(json, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'ERROR',
        async json() {
            return json;
        },
        async text() {
            return JSON.stringify(json);
        },
    };
}

function buildPublicClient(runtime) {
    return {
        async getChainId() {
            if (runtime.chainIdError) {
                throw new Error(runtime.chainIdError);
            }
            return 137;
        },
        async getBlockNumber() {
            if (runtime.blockNumberError) {
                throw new Error(runtime.blockNumberError);
            }
            return runtime.latestBlock;
        },
        async getCode({ address }) {
            return String(address).toLowerCase() === TEST_SAFE.toLowerCase() ? '0x1' : '0x';
        },
        async getLogs({ address, args, fromBlock, toBlock, event }) {
            const normalizedAddress = String(address).toLowerCase();
            const normalizedFromBlock = BigInt(fromBlock ?? 0n);
            const normalizedToBlock = BigInt(toBlock ?? runtime.latestBlock);
            const normalizedRange = normalizedToBlock - normalizedFromBlock + 1n;
            if (
                runtime.maxGetLogsRange !== null &&
                runtime.maxGetLogsRange !== undefined &&
                normalizedRange > BigInt(runtime.maxGetLogsRange)
            ) {
                throw new Error(
                    `Requested log range ${normalizedRange.toString()} exceeds test RPC limit ${String(runtime.maxGetLogsRange)}`
                );
            }
            if (normalizedAddress === TEST_USDC.toLowerCase()) {
                if (String(args?.to ?? '').toLowerCase() !== TEST_SAFE.toLowerCase()) {
                    return [];
                }
                return runtime.depositLogs.filter((log) => {
                    const blockNumber = BigInt(log.blockNumber ?? 0n);
                    return blockNumber >= normalizedFromBlock && blockNumber <= normalizedToBlock;
                });
            }
            if (normalizedAddress === TEST_CTF.toLowerCase()) {
                const eventName = String(event?.name ?? '');
                const sourceLogs =
                    eventName === 'TransferSingle'
                        ? runtime.ctfTransferSingleLogs
                        : eventName === 'TransferBatch'
                            ? runtime.ctfTransferBatchLogs
                            : [];
                return sourceLogs.filter((log) => {
                    const blockNumber = BigInt(log.blockNumber ?? 0n);
                    if (blockNumber < normalizedFromBlock || blockNumber > normalizedToBlock) {
                        return false;
                    }
                    if (args?.to && String(log.args?.to ?? '').toLowerCase() !== String(args.to).toLowerCase()) {
                        return false;
                    }
                    if (
                        args?.from &&
                        String(log.args?.from ?? '').toLowerCase() !== String(args.from).toLowerCase()
                    ) {
                        return false;
                    }
                    return true;
                });
            }
            if (normalizedAddress === TEST_OG_MODULE.toLowerCase()) {
                const eventName = String(event?.name ?? '');
                const sourceLogs =
                    eventName === 'TransactionsProposed'
                        ? runtime.proposedProposalLogs
                        : eventName === 'ProposalExecuted'
                            ? runtime.executedProposalLogs
                            : eventName === 'ProposalDeleted'
                                ? runtime.deletedProposalLogs
                                : [];
                return sourceLogs.filter((log) => {
                    const blockNumber = BigInt(log.blockNumber ?? 0n);
                    return blockNumber >= normalizedFromBlock && blockNumber <= normalizedToBlock;
                });
            }
            return [];
        },
        async readContract({ address, functionName, args }) {
            if (
                String(address).toLowerCase() === TEST_USDC.toLowerCase() &&
                functionName === 'balanceOf'
            ) {
                const owner = String(args?.[0] ?? '').toLowerCase();
                if (owner === TEST_SAFE.toLowerCase() && runtime.collateralBalanceReadError) {
                    throw new Error(runtime.collateralBalanceReadError);
                }
                const balanceKey = `${String(address).toLowerCase()}:${owner}`;
                if (runtime.collateralBalances && Object.hasOwn(runtime.collateralBalances, balanceKey)) {
                    return BigInt(runtime.collateralBalances[balanceKey]);
                }
                if (
                    runtime.safeCollateralBalance !== undefined &&
                    runtime.safeCollateralBalance !== null &&
                    owner === TEST_SAFE.toLowerCase()
                ) {
                    return BigInt(runtime.safeCollateralBalance);
                }
                if (owner === TEST_SAFE.toLowerCase()) {
                    return runtime.depositLogs.reduce(
                        (total, log) => total + BigInt(log?.args?.value ?? 0n),
                        0n
                    );
                }
                return 0n;
            }
            if (
                String(address).toLowerCase() === TEST_CTF.toLowerCase() &&
                functionName === 'balanceOf'
            ) {
                if (runtime.ctfBalanceReadError) {
                    throw new Error(runtime.ctfBalanceReadError);
                }
                const owner = String(args?.[0] ?? '').toLowerCase();
                const tokenId = BigInt(args?.[1] ?? 0n).toString();
                return BigInt(runtime.ctfBalances[`${owner}:${tokenId}`] ?? 0n);
            }
            throw new Error(
                `Unexpected readContract call: address=${address} functionName=${functionName}`
            );
        },
        async getTransactionReceipt({ hash }) {
            const receiptError = runtime.receiptErrors[String(hash).toLowerCase()];
            if (receiptError) {
                throw new Error(receiptError);
            }
            const receipt = runtime.receipts[String(hash).toLowerCase()];
            if (receipt) {
                return receipt;
            }
            const error = new Error(`Transaction receipt not found for ${hash}`);
            error.name = 'TransactionReceiptNotFoundError';
            throw error;
        },
    };
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'polymarket-intent-trader-'));
    const stateFilePath = path.join(tmpDir, '.trade-intent-state.json');
    setTradeIntentStatePathForTest(stateFilePath);

    const runtime = {
        latestBlock: 100n,
        depositLogs: [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ],
        orderPayload: {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
                taker_amount_filled: '62500000',
                fee: '100000',
            },
        },
        tradesPayload: [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
                fee: '0.1',
            },
        ],
        bookPayload: {
            minimum_tick_size: '0.01',
        },
        safeCollateralBalance: null,
        collateralBalanceReadError: null,
        chainIdError: null,
        collateralBalances: {},
        ctfBalances: {},
        ctfBalanceReadError: null,
        ctfTransferSingleLogs: [],
        ctfTransferBatchLogs: [],
        maxGetLogsRange: null,
        receipts: {},
        receiptErrors: {},
        feeRateFetchError: null,
        orderFetchError: null,
        tradesFetchError: null,
        proposedProposalLogs: [],
        executedProposalLogs: [],
        deletedProposalLogs: [],
    };

    const publicClient = buildPublicClient(runtime);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/book') {
            return buildFetchResponse(runtime.bookPayload);
        }
        if (url.pathname === '/fee-rate') {
            if (runtime.feeRateFetchError) {
                throw new Error(runtime.feeRateFetchError);
            }
            return buildFetchResponse({ base_fee: 30 });
        }
        if (url.pathname.startsWith('/data/order/')) {
            if (runtime.orderFetchError) {
                throw new Error(runtime.orderFetchError);
            }
            return buildFetchResponse(runtime.orderPayload);
        }
        if (url.pathname === '/data/trades') {
            if (runtime.tradesFetchError) {
                throw new Error(runtime.tradesFetchError);
            }
            return buildFetchResponse(runtime.tradesPayload);
        }
        throw new Error(`Unexpected fetch URL: ${url.toString()}`);
    };

    try {
        await resetTradeIntentState();

        const prompt = getSystemPrompt({
            commitmentText: 'Signed Polymarket trade intents may be written in plain English.',
        });
        assert.ok(prompt.includes('kind is "userMessage"'));
        assert.ok(prompt.includes('sender.authType is "eip191"'));
        assert.ok(
            prompt.includes('signed human-readable message text as the primary source of trading intent')
        );
        assert.ok(prompt.includes('Archive accepted signed trade intents'));
        assert.ok(prompt.includes('Return strict JSON'));

        const pollingOptions = getPollingOptions();
        assert.equal(pollingOptions.emitBalanceSnapshotsEveryPoll, true);

        const initialBackfillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(initialBackfillCalls, []);
        let state = getTradeIntentState();
        assert.equal(Object.keys(state.deposits).length, 1);
        runtime.depositLogs = [];
        setTradeIntentStatePathForTest(stateFilePath);
        const persistedBackfillRestartCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(persistedBackfillRestartCalls, []);
        state = getTradeIntentState();
        assert.equal(Object.keys(state.deposits).length, 1);
        assert.equal(state.backfilledDepositsThroughBlock, '100');

        await resetTradeIntentState();
        runtime.latestBlock = 42n;
        runtime.depositLogs = [];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        const emptyBackfillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(emptyBackfillCalls, []);
        state = getTradeIntentState();
        assert.equal(state.backfilledDepositsThroughBlock, '42');
        assert.equal(state.backfilledReimbursementCommitmentsThroughBlock, '42');
        const persistedEmptyBackfillState = JSON.parse(await readFile(stateFilePath, 'utf8'));
        assert.equal(persistedEmptyBackfillState.backfilledDepositsThroughBlock, '42');
        assert.equal(
            persistedEmptyBackfillState.backfilledReimbursementCommitmentsThroughBlock,
            '42'
        );
        setTradeIntentStatePathForTest(stateFilePath);
        const emptyBackfillRestartCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(emptyBackfillRestartCalls, []);
        state = getTradeIntentState();
        assert.equal(state.backfilledDepositsThroughBlock, '42');
        assert.equal(state.backfilledReimbursementCommitmentsThroughBlock, '42');

        await resetTradeIntentState();
        runtime.latestBlock = 43n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.safeCollateralBalance = 10_000_000n;
        const insufficientSafeCollateralSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-safe-balance-blocked',
        });
        const insufficientSafeCollateralCalls = await getDeterministicToolCalls({
            signals: [insufficientSafeCollateralSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(insufficientSafeCollateralCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-safe-balance-blocked`],
            undefined
        );
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 44n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.collateralBalanceReadError = 'safe balance RPC unavailable';
        const collateralReadFailureSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-safe-balance-read-retry',
        });
        const collateralReadFailureArchiveCalls = await getDeterministicToolCalls({
            signals: [collateralReadFailureSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(collateralReadFailureArchiveCalls.length, 1);
        assert.equal(collateralReadFailureArchiveCalls[0].name, 'ipfs_publish');
        state = getTradeIntentState();
        assert.ok(state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-safe-balance-read-retry`]);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafy-safe-balance-read-retry',
                uri: 'ipfs://bafy-safe-balance-read-retry',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const collateralReadFailureBlockedCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(collateralReadFailureBlockedCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-safe-balance-read-retry`]
                .lastOrderSubmissionStatus,
            'unavailable'
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-safe-balance-read-retry`]
                .lastOrderSubmissionError.includes('Unable to confirm actual Safe collateral headroom'),
            true
        );
        state.intents[
            `${TEST_SIGNER.toLowerCase()}:pm-intent-safe-balance-read-retry`
        ].nextOrderAttemptAtMs = 0;
        await writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.collateralBalanceReadError = null;
        runtime.safeCollateralBalance = 100_000_000n;
        const collateralReadFailureRecoveredCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(collateralReadFailureRecoveredCalls.length, 1);
        assert.equal(
            collateralReadFailureRecoveredCalls[0].name,
            'polymarket_clob_build_sign_and_place_order'
        );
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 45n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.safeCollateralBalance = 100_000_000n;
        runtime.feeRateFetchError = 'fee rate endpoint unavailable';
        const feeRateRetrySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-fee-rate-retry',
        });
        const feeRateRetryArchiveCalls = await getDeterministicToolCalls({
            signals: [feeRateRetrySignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(feeRateRetryArchiveCalls.length, 1);
        assert.equal(feeRateRetryArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafy-fee-rate-retry',
                uri: 'ipfs://bafy-fee-rate-retry',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const feeRateRetryBlockedCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(feeRateRetryBlockedCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-fee-rate-retry`]
                .lastOrderSubmissionError.includes('Failed to fetch Polymarket fee rate'),
            true
        );
        state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-fee-rate-retry`].nextOrderAttemptAtMs =
            0;
        await writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.feeRateFetchError = null;
        const feeRateRetryRecoveredCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(feeRateRetryRecoveredCalls.length, 1);
        assert.equal(
            feeRateRetryRecoveredCalls[0].name,
            'polymarket_clob_build_sign_and_place_order'
        );
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 46n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.safeCollateralBalance = 100_000_000n;
        runtime.chainIdError = 'chain id rpc unavailable';
        const chainIdFallbackSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-chainid-config-fallback',
        });
        const chainIdFallbackArchiveCalls = await getDeterministicToolCalls({
            signals: [chainIdFallbackSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(chainIdFallbackArchiveCalls.length, 1);
        assert.equal(chainIdFallbackArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafy-chainid-config-fallback',
                uri: 'ipfs://bafy-chainid-config-fallback',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const chainIdFallbackOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(chainIdFallbackOrderCalls.length, 1);
        assert.equal(
            chainIdFallbackOrderCalls[0].name,
            'polymarket_clob_build_sign_and_place_order'
        );
        assert.equal(
            JSON.parse(chainIdFallbackOrderCalls[0].arguments).chainId,
            '137'
        );
        runtime.chainIdError = null;
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 46n;
        runtime.ctfBalanceReadError = 'ctf balance RPC unavailable';
        runtime.ctfBalances = {};
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-balance-read-retry`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-balance-read-retry`,
                    requestId: 'pm-intent-deposit-balance-read-retry',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    artifactCid: 'bafy-deposit-balance-read-retry',
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_000_000,
                },
            },
            deposits: {
                'tx:0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:0': {
                    depositKey:
                        'tx:0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:0',
                    depositId: null,
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    transactionHash: `0x${'d'.repeat(64)}`,
                    logIndex: '0',
                    blockNumber: '10',
                    createdAtMs: 1_900_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '46',
            backfilledReimbursementCommitmentsThroughBlock: '46',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const depositBalanceRetryBlockedCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(depositBalanceRetryBlockedCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-balance-read-retry`]
                .lastDepositError.includes('Failed to read outcome-token balance before deposit'),
            true
        );
        state.intents[
            `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-balance-read-retry`
        ].nextDepositAttemptAtMs = 0;
        await writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.ctfBalanceReadError = null;
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 62_500_000n,
        };
        const depositBalanceRetryRecoveredCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositBalanceRetryRecoveredCalls.length, 1);
        assert.equal(depositBalanceRetryRecoveredCalls[0].name, 'make_erc1155_deposit');
        runtime.ctfBalances = {};

        await resetTradeIntentState();
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 1,
            backfilledDepositsThroughBlock: '42',
            backfilledReimbursementCommitmentsThroughBlock: '42',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 101n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
            {
                args: {
                    from: TEST_OTHER_SIGNER,
                    value: 30_000_000n,
                },
                blockNumber: 101n,
                transactionHash: `0x${'e'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const incrementalBackfillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(incrementalBackfillCalls, []);
        state = getTradeIntentState();
        assert.equal(Object.keys(state.deposits).length, 1);
        assert.equal(state.backfilledDepositsThroughBlock, '101');

        await resetTradeIntentState();
        runtime.latestBlock = 120n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: TEST_PROPOSAL_HASH,
                    explanation:
                        'polymarket-intent-trader reimbursement | intent=legacy-intent-1 | signer=0x1111111111111111111111111111111111111111 | spentWei=20000000',
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 100n,
                logIndex: 0,
            },
            {
                args: {
                    proposer: TEST_OTHER_AGENT,
                    proposalHash: `0x${'f'.repeat(64)}`,
                    explanation:
                        'polymarket-intent-trader reimbursement | intent=legacy-intent-ignored | signer=0x1111111111111111111111111111111111111111 | spentWei=20000000',
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 101n,
                logIndex: 0,
            },
        ];
        runtime.executedProposalLogs = [
            {
                args: {
                    proposalHash: TEST_PROPOSAL_HASH,
                },
                blockNumber: 110n,
                logIndex: 0,
            },
        ];
        runtime.deletedProposalLogs = [];
        const overcommittedRestartSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-overcommitted-restart',
            text: 'Buy NO for up to 35 USDC if the price is 0.42 or better before 6pm UTC.',
        });
        const overcommittedRestartCalls = await getDeterministicToolCalls({
            signals: [overcommittedRestartSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(overcommittedRestartCalls, []);
        state = getTradeIntentState();
        assert.equal(Object.keys(state.intents).length, 0);
        assert.equal(Object.keys(state.reimbursementCommitments).length, 1);
        assert.equal(
            state.reimbursementCommitments[`proposal:${TEST_PROPOSAL_HASH.toLowerCase()}`].status,
            'executed'
        );
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];

        await resetTradeIntentState();
        runtime.latestBlock = 121n;
        runtime.depositLogs = [];
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'4'.repeat(64)}`,
                    explanation:
                        'polymarket-intent-trader reimbursement | intent=bad-intent | signer=not-an-address | spentWei=25000000',
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: buildErc20TransferCalldata(TEST_AGENT, '25000000'),
                            },
                        ],
                    },
                },
                blockNumber: 120n,
                logIndex: 0,
            },
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'5'.repeat(64)}`,
                    explanation:
                        `polymarket-intent-trader reimbursement | intent=good-intent | signer=${TEST_SIGNER} | spentWei=15000000`,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: buildErc20TransferCalldata(TEST_AGENT, '15000000'),
                            },
                        ],
                    },
                },
                blockNumber: 121n,
                logIndex: 0,
            },
        ];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 1,
            backfilledDepositsThroughBlock: '121',
            backfilledReimbursementCommitmentsThroughBlock: '0',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const malformedBackfillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(malformedBackfillCalls, []);
        state = getTradeIntentState();
        assert.deepEqual(Object.keys(state.reimbursementCommitments), [
            `proposal:${`0x${'5'.repeat(64)}`.toLowerCase()}`,
        ]);
        runtime.proposedProposalLogs = [];

        await resetTradeIntentState();
        runtime.latestBlock = 122n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:released-intent`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:released-intent`,
                    requestId: 'released-intent',
                    signer: TEST_SIGNER.toLowerCase(),
                    reservedCreditAmountWei: '25000000',
                    creditReleasedAtMs: 1_900_000_000_000,
                    closedAtMs: 1_900_000_000_000,
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_000_000,
                },
            },
            reimbursementCommitments: {
                [`proposal:${`0x${'6'.repeat(64)}`.toLowerCase()}`]: {
                    commitmentKey: `proposal:${`0x${'6'.repeat(64)}`.toLowerCase()}`,
                    proposalHash: `0x${'6'.repeat(64)}`,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:released-intent`,
                    signer: TEST_SIGNER.toLowerCase(),
                    recipientAddress: TEST_AGENT.toLowerCase(),
                    amountWei: '25000000',
                    status: 'proposed',
                    createdAtMs: 1_900_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '122',
            backfilledReimbursementCommitmentsThroughBlock: '122',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const releasedIntentCommitmentCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-released-intent-commitment-counts',
                    text: 'Buy NO for up to 30 USDC if the price is 0.42 or better before 6pm UTC.',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(releasedIntentCommitmentCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-released-intent-commitment-counts`],
            undefined
        );

        const validSignal = buildSignedMessageSignal();
        const inactiveCalls = await getDeterministicToolCalls({
            signals: [validSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        authorizedAgent: null,
                    },
                },
            }),
        });
        assert.deepEqual(inactiveCalls, []);
        assert.deepEqual(getTradeIntentState().intents, {});

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const clobDisabledSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-clob-disabled',
        });
        const clobDisabledArchiveCalls = await getDeterministicToolCalls({
            signals: [clobDisabledSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                polymarketClobEnabled: false,
            }),
        });
        assert.equal(clobDisabledArchiveCalls.length, 1);
        assert.equal(clobDisabledArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-clob-disabled',
                uri: 'ipfs://bafyintent-clob-disabled',
                pinned: true,
            },
            config: buildModuleConfig({
                polymarketClobEnabled: false,
            }),
        });
        const clobDisabledOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                polymarketClobEnabled: false,
            }),
        });
        assert.deepEqual(clobDisabledOrderCalls, []);
        state = getTradeIntentState();
        let storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-clob-disabled`];
        assert.equal(storedIntent.orderSubmittedAtMs, undefined);
        assert.equal(storedIntent.orderId, undefined);
        assert.equal(storedIntent.lastOrderSubmissionStatus, 'unavailable');
        assert.match(
            storedIntent.lastOrderSubmissionError,
            /polymarketClobEnabled=true is required/
        );
        assert.equal(typeof storedIntent.nextOrderAttemptAtMs, 'number');

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const proposalsDisabledSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-proposals-disabled',
        });
        const proposalsDisabledArchiveCalls = await getDeterministicToolCalls({
            signals: [proposalsDisabledSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                proposeEnabled: false,
                disputeEnabled: true,
            }),
        });
        assert.equal(proposalsDisabledArchiveCalls.length, 1);
        assert.equal(proposalsDisabledArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-proposals-disabled',
                uri: 'ipfs://bafyintent-proposals-disabled',
                pinned: true,
            },
            config: buildModuleConfig({
                proposeEnabled: false,
                disputeEnabled: true,
            }),
        });
        const proposalsDisabledOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                proposeEnabled: false,
                disputeEnabled: true,
            }),
        });
        assert.deepEqual(proposalsDisabledOrderCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposals-disabled`];
        assert.equal(storedIntent.orderSubmittedAtMs, undefined);
        assert.equal(storedIntent.orderId, undefined);
        assert.equal(storedIntent.lastOrderSubmissionStatus, 'unavailable');
        assert.match(storedIntent.lastOrderSubmissionError, /proposeEnabled=true is required/);
        assert.equal(typeof storedIntent.nextOrderAttemptAtMs, 'number');

        await assert.rejects(
            getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    polymarketClobAddress: TEST_OTHER_AGENT,
                }),
            }),
            /POLYMARKET_CLOB_ADDRESS .* must match runtime signer address .* when POLYMARKET_RELAYER_ENABLED=false/
        );

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const relayerSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-relayer-signature',
        });
        const relayerConfig = buildModuleConfig({
            polymarketRelayerEnabled: true,
            polymarketRelayerFromAddress: TEST_AGENT,
            polymarketClobAddress: TEST_AGENT,
        });
        const relayerArchiveCalls = await getDeterministicToolCalls({
            signals: [relayerSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: relayerConfig,
        });
        assert.equal(relayerArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-relayer-signature',
                uri: 'ipfs://bafyintent-relayer-signature',
                pinned: true,
            },
            config: relayerConfig,
        });
        const relayerOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: relayerConfig,
        });
        assert.equal(relayerOrderCalls.length, 1);
        assert.equal(
            JSON.parse(relayerOrderCalls[0].arguments).signatureType,
            'POLY_GNOSIS_SAFE'
        );

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const orderDispatchSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-order-dispatch-restart',
        });
        const orderDispatchArchiveCalls = await getDeterministicToolCalls({
            signals: [orderDispatchSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(orderDispatchArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-order-dispatch-restart',
                uri: 'ipfs://bafyintent-order-dispatch-restart',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const orderDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(orderDispatchCalls.length, 1);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-order-dispatch-restart`];
        assert.equal(typeof storedIntent.orderDispatchAtMs, 'number');
        state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-order-dispatch-restart`].expiryMs =
            Number(storedIntent.orderDispatchAtMs) - 1;
        await writeTradeIntentStateFixture(stateFilePath, state);
        setTradeIntentStatePathForTest(stateFilePath);
        const expiredDispatchWindowCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(expiredDispatchWindowCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-order-dispatch-restart`];
        assert.equal(storedIntent.closedAtMs, undefined);
        assert.equal(storedIntent.creditReleasedAtMs, undefined);
        setTradeIntentStatePathForTest(stateFilePath);
        const restartOrderDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(restartOrderDispatchCalls, []);
        const originalOrderDispatchDateNow = Date.now;
        try {
            Date.now = () => Number(storedIntent.orderDispatchAtMs) + 31_000;
            setTradeIntentStatePathForTest(stateFilePath);
            const orderDispatchTimeoutCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig(),
            });
            assert.deepEqual(orderDispatchTimeoutCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-order-dispatch-restart`];
            assert.equal(storedIntent.orderDispatchAtMs, undefined);
            assert.equal(typeof storedIntent.orderSubmittedAtMs, 'number');
            assert.equal(storedIntent.lastOrderSubmissionStatus, 'dispatch_pending');
        } finally {
            Date.now = originalOrderDispatchDateNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const depositDispatchSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-deposit-dispatch-restart',
        });
        const depositDispatchArchiveCalls = await getDeterministicToolCalls({
            signals: [depositDispatchSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositDispatchArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-deposit-dispatch-restart',
                uri: 'ipfs://bafyintent-deposit-dispatch-restart',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const depositDispatchOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositDispatchOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: 'order-deposit-dispatch-restart',
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        runtime.ctfBalances[`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`] = 100_000_000n;
        const depositDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositDispatchCalls.length, 1);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-dispatch-restart`];
        assert.equal(typeof storedIntent.depositDispatchAtMs, 'number');
        setTradeIntentStatePathForTest(stateFilePath);
        const restartDepositDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(restartDepositDispatchCalls, []);
        const originalDepositDispatchDateNow = Date.now;
        try {
            Date.now = () => Number(storedIntent.depositDispatchAtMs) + 31_000;
            setTradeIntentStatePathForTest(stateFilePath);
            const depositDispatchTimeoutCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig(),
            });
            assert.deepEqual(depositDispatchTimeoutCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-dispatch-restart`];
            assert.equal(storedIntent.depositDispatchAtMs, undefined);
            assert.equal(typeof storedIntent.depositSubmittedAtMs, 'number');
            assert.equal(storedIntent.depositSubmissionAmbiguous, true);
        } finally {
            Date.now = originalDepositDispatchDateNow;
        }
        runtime.latestBlock = 151n;
        runtime.ctfTransferSingleLogs = [
            {
                args: {
                    operator: TEST_AGENT,
                    from: TEST_AGENT,
                    to: TEST_SAFE,
                    id: BigInt(NO_TOKEN_ID),
                    value: BigInt(storedIntent.filledShareAmount),
                },
                blockNumber: 151n,
                transactionHash: `0x${'e'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        setTradeIntentStatePathForTest(stateFilePath);
        const recoveredDepositCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
            onchainPendingProposal: true,
        });
        assert.deepEqual(recoveredDepositCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-dispatch-restart`];
        assert.equal(storedIntent.tokenDeposited, true);
        assert.equal(storedIntent.depositTxHash, `0x${'e'.repeat(64)}`);
        assert.equal(storedIntent.depositBlockNumber, '151');
        runtime.ctfTransferSingleLogs = [];

        await resetTradeIntentState();
        runtime.latestBlock = 160n;
        runtime.maxGetLogsRange = null;
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 3,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-a`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-a`,
                    requestId: 'pm-intent-duplicate-recovery-a',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_000_000,
                    depositSubmittedAtMs: 1_900_000_010_000,
                    depositDispatchBlockNumber: '140',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-duplicate-a',
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_010_000,
                },
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-b`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 2,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-b`,
                    requestId: 'pm-intent-duplicate-recovery-b',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_020_000,
                    depositSubmittedAtMs: 1_900_000_030_000,
                    depositDispatchBlockNumber: '145',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-duplicate-b',
                    createdAtMs: 1_900_000_020_000,
                    updatedAtMs: 1_900_000_030_000,
                },
            },
            backfilledDepositsThroughBlock: '160',
            backfilledReimbursementCommitmentsThroughBlock: '160',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const duplicateRecoveredDepositCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'erc1155Deposit',
                    asset: TEST_CTF,
                    token: TEST_CTF,
                    tokenId: NO_TOKEN_ID,
                    from: TEST_AGENT,
                    amount: '62500000',
                    blockNumber: 160n,
                    transactionHash: `0x${'f'.repeat(64)}`,
                    logIndex: 0,
                    id: `0x${'f'.repeat(64)}:0:${NO_TOKEN_ID}`,
                },
                {
                    kind: 'erc1155Deposit',
                    asset: TEST_CTF,
                    token: TEST_CTF,
                    tokenId: NO_TOKEN_ID,
                    from: TEST_AGENT,
                    amount: '62500000',
                    blockNumber: 161n,
                    transactionHash: `0x${'1'.repeat(64)}`,
                    logIndex: 0,
                    id: `0x${'1'.repeat(64)}:0:${NO_TOKEN_ID}`,
                },
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
            onchainPendingProposal: true,
        });
        assert.deepEqual(duplicateRecoveredDepositCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-a`]
                .tokenDeposited,
            true
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-b`]
                .tokenDeposited,
            true
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-a`]
                .depositTxHash,
            `0x${'f'.repeat(64)}`
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-duplicate-recovery-b`]
                .depositTxHash,
            `0x${'1'.repeat(64)}`
        );

        await resetTradeIntentState();
        runtime.latestBlock = 161n;
        runtime.ctfTransferSingleLogs = [
            {
                args: {
                    operator: TEST_AGENT,
                    from: TEST_AGENT,
                    to: TEST_SAFE,
                    id: BigInt(NO_TOKEN_ID),
                    value: 62_500_000n,
                },
                blockNumber: 161n,
                transactionHash: `0x${'3'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 3,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-a`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-a`,
                    requestId: 'pm-intent-weak-signal-duplicate-a',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_040_000,
                    depositSubmittedAtMs: 1_900_000_050_000,
                    depositDispatchBlockNumber: '150',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-weak-signal-a',
                    createdAtMs: 1_900_000_040_000,
                    updatedAtMs: 1_900_000_050_000,
                },
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-b`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 2,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-b`,
                    requestId: 'pm-intent-weak-signal-duplicate-b',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_060_000,
                    depositSubmittedAtMs: 1_900_000_070_000,
                    depositDispatchBlockNumber: '155',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-weak-signal-b',
                    createdAtMs: 1_900_000_060_000,
                    updatedAtMs: 1_900_000_070_000,
                },
            },
            backfilledDepositsThroughBlock: '161',
            backfilledReimbursementCommitmentsThroughBlock: '161',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const weakSignalDuplicateRecoveryCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'erc1155Deposit',
                    asset: TEST_CTF,
                    token: TEST_CTF,
                    tokenId: NO_TOKEN_ID,
                    from: TEST_AGENT,
                    amount: '62500000',
                    blockNumber: 161n,
                    id: 'weak-signal-duplicate-recovery',
                },
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
            onchainPendingProposal: true,
        });
        assert.deepEqual(weakSignalDuplicateRecoveryCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-a`]
                .tokenDeposited,
            undefined
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-weak-signal-duplicate-b`]
                .tokenDeposited,
            undefined
        );
        runtime.ctfTransferSingleLogs = [];

        await resetTradeIntentState();
        runtime.latestBlock = 162n;
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 3,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-a`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-a`,
                    requestId: 'pm-intent-partial-recovery-a',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_060_000,
                    depositSubmittedAtMs: 1_900_000_070_000,
                    depositDispatchBlockNumber: '140',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-partial-a',
                    createdAtMs: 1_900_000_060_000,
                    updatedAtMs: 1_900_000_070_000,
                },
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-b`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 2,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-b`,
                    requestId: 'pm-intent-partial-recovery-b',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '25000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_080_000,
                    depositSubmittedAtMs: 1_900_000_090_000,
                    depositDispatchBlockNumber: '145',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-partial-b',
                    createdAtMs: 1_900_000_080_000,
                    updatedAtMs: 1_900_000_090_000,
                },
            },
            backfilledDepositsThroughBlock: '162',
            backfilledReimbursementCommitmentsThroughBlock: '162',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const partialRecoveredDepositCalls = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'erc1155Deposit',
                    asset: TEST_CTF,
                    token: TEST_CTF,
                    tokenId: NO_TOKEN_ID,
                    from: TEST_AGENT,
                    amount: '62500000',
                    blockNumber: 162n,
                    transactionHash: `0x${'2'.repeat(64)}`,
                    logIndex: 0,
                    id: `0x${'2'.repeat(64)}:0:${NO_TOKEN_ID}`,
                },
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
            onchainPendingProposal: true,
        });
        assert.deepEqual(partialRecoveredDepositCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-a`]
                .tokenDeposited,
            undefined
        );
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-partial-recovery-b`]
                .tokenDeposited,
            undefined
        );

        await resetTradeIntentState();
        runtime.latestBlock = 260n;
        runtime.maxGetLogsRange = 50n;
        runtime.ctfTransferSingleLogs = [
            {
                args: {
                    operator: TEST_AGENT,
                    from: TEST_AGENT,
                    to: TEST_SAFE,
                    id: BigInt(NO_TOKEN_ID),
                    value: 62_500_000n,
                },
                blockNumber: 260n,
                transactionHash: `0x${'f'.repeat(64)}`,
                logIndex: 3,
            },
        ];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-recovery-chunked-logs`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-recovery-chunked-logs`,
                    requestId: 'pm-intent-recovery-chunked-logs',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_040_000,
                    depositSubmittedAtMs: 1_900_000_050_000,
                    depositDispatchBlockNumber: '100',
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '62500000',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-chunked-recovery',
                    createdAtMs: 1_900_000_040_000,
                    updatedAtMs: 1_900_000_050_000,
                },
            },
            backfilledDepositsThroughBlock: '260',
            backfilledReimbursementCommitmentsThroughBlock: '260',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const chunkedRecoveryCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                logChunkSize: 50,
            }),
            onchainPendingProposal: true,
        });
        assert.deepEqual(chunkedRecoveryCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-recovery-chunked-logs`];
        assert.equal(storedIntent.tokenDeposited, true);
        assert.equal(storedIntent.depositTxHash, `0x${'f'.repeat(64)}`);
        assert.equal(storedIntent.depositBlockNumber, '260');
        runtime.ctfTransferSingleLogs = [];
        runtime.maxGetLogsRange = null;

        await resetTradeIntentState();
        runtime.latestBlock = 310n;
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 0n,
        };
        runtime.ctfTransferSingleLogs = [
            {
                args: {
                    operator: TEST_AGENT,
                    from: TEST_AGENT,
                    to: TEST_SAFE,
                    id: BigInt(NO_TOKEN_ID),
                    value: 62_500_000n,
                },
                blockNumber: 305n,
                transactionHash: `0x${'4'.repeat(64)}`,
                logIndex: 2,
            },
        ];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-recover-lost-deposit-state`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-recover-lost-deposit-state`,
                    requestId: 'pm-intent-recover-lost-deposit-state',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '20000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderId: TEST_ORDER_ID,
                    orderFilled: true,
                    orderFilledAtMs: 1_900_000_040_000,
                    orderDispatchBlockNumber: '300',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    reimbursementRecipientAddress: TEST_AGENT.toLowerCase(),
                    artifactCid: 'bafy-recover-lost-deposit-state',
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_040_000,
                },
            },
            backfilledDepositsThroughBlock: '310',
            backfilledReimbursementCommitmentsThroughBlock: '310',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const recoveredLostDepositStateCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                logChunkSize: 50,
            }),
            onchainPendingProposal: true,
        });
        assert.deepEqual(recoveredLostDepositStateCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-recover-lost-deposit-state`];
        assert.equal(storedIntent.tokenDeposited, true);
        assert.equal(storedIntent.depositTxHash, `0x${'4'.repeat(64)}`);
        assert.equal(storedIntent.depositBlockNumber, '305');
        runtime.ctfTransferSingleLogs = [];

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
                taker_amount_filled: '62500000',
                fee: '100000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
                fee: '0.1',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const reimbursementDispatchSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-proposal-dispatch-restart',
        });
        const reimbursementDispatchArchiveCalls = await getDeterministicToolCalls({
            signals: [reimbursementDispatchSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementDispatchArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-proposal-dispatch-restart',
                uri: 'ipfs://bafyintent-proposal-dispatch-restart',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const reimbursementDispatchOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementDispatchOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const reimbursementDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementDispatchCalls.length, 1);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-dispatch-restart`];
        assert.equal(typeof storedIntent.reimbursementDispatchAtMs, 'number');
        assert.equal(storedIntent.reimbursementSubmittedAtMs, undefined);
        setTradeIntentStatePathForTest(stateFilePath);
        const restartReimbursementDispatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(restartReimbursementDispatchCalls, []);
        const originalReimbursementDispatchDateNow = Date.now;
        try {
            Date.now = () => Number(storedIntent.reimbursementDispatchAtMs) + 31_000;
            setTradeIntentStatePathForTest(stateFilePath);
            const reimbursementDispatchTimeoutCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig(),
            });
            assert.deepEqual(reimbursementDispatchTimeoutCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-dispatch-restart`];
            assert.equal(storedIntent.reimbursementDispatchAtMs, undefined);
            assert.equal(typeof storedIntent.reimbursementSubmittedAtMs, 'number');
            assert.equal(storedIntent.reimbursementSubmissionAmbiguous, true);
            assert.equal(storedIntent.lastReimbursementSubmissionStatus, 'dispatch_pending');
        } finally {
            Date.now = originalReimbursementDispatchDateNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 150n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];

        const interpreted = interpretSignedTradeIntentSignal(validSignal, {
            policy: {
                ready: true,
                authorizedAgent: TEST_AGENT.toLowerCase(),
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                archiveRetryDelayMs: 30_000,
                pendingTxTimeoutMs: 900_000,
                logChunkSize: 5_000n,
                signedCommands: new Set(['buy']),
            },
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            nowMs: validSignal.receivedAtMs,
        });
        assert.equal(interpreted.ok, true);
        assert.equal(interpreted.intent.intentKey, `${TEST_SIGNER.toLowerCase()}:pm-intent-001`);
        assert.equal(interpreted.intent.outcome, 'NO');
        assert.equal(interpreted.intent.tokenId, NO_TOKEN_ID);
        assert.equal(interpreted.intent.maxSpendWei, '25000000');
        assert.equal(interpreted.intent.maxPriceScaled, '420000');

        const leadingDecimalSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-leading-decimal',
            text: 'Buy NO for up to .5 USDC if the price is .42 or better before 6pm UTC.',
        });
        const leadingDecimalInterpreted = interpretSignedTradeIntentSignal(leadingDecimalSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: leadingDecimalSignal.receivedAtMs,
        });
        assert.equal(leadingDecimalInterpreted.ok, true);
        assert.equal(
            leadingDecimalInterpreted.intent.intentKey,
            `${TEST_SIGNER.toLowerCase()}:pm-intent-leading-decimal`
        );
        assert.equal(leadingDecimalInterpreted.intent.maxSpendWei, '500000');
        assert.equal(leadingDecimalInterpreted.intent.maxPriceScaled, '420000');

        const wrongChainSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-wrong-chain',
            chainId: 1,
        });
        const wrongChainInterpreted = interpretSignedTradeIntentSignal(wrongChainSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                minimumTickSizeScaled: '10000',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            runtimeChainId: 137,
            nowMs: wrongChainSignal.receivedAtMs,
        });
        assert.equal(wrongChainInterpreted.ok, false);
        assert.equal(wrongChainInterpreted.reason, 'wrong_chain_id');
        const wrongChainCalls = await getDeterministicToolCalls({
            signals: [wrongChainSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(wrongChainCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-wrong-chain`],
            undefined
        );

        const unknownRuntimeChainStateDir = await mkdtemp(
            path.join(tmpDir, 'unknown-runtime-chain-')
        );
        setTradeIntentStatePathForTest(
            path.join(unknownRuntimeChainStateDir, '.trade-intent-state.json')
        );
        await resetTradeIntentState();
        runtime.chainIdError = 'chain id rpc unavailable';
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [
                        buildSignedMessageSignal({
                            requestId: 'pm-intent-unknown-runtime-chain',
                        }),
                    ],
                    commitmentSafe: TEST_SAFE,
                    agentAddress: TEST_AGENT,
                    publicClient,
                    config: buildModuleConfig({
                        chainId: undefined,
                    }),
                }),
            /runtime chain id/i
        );
        runtime.chainIdError = null;
        setTradeIntentStatePathForTest(stateFilePath);
        await resetTradeIntentState();
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-unknown-runtime-chain`],
            undefined
        );
        await writeTradeIntentStateFixture(stateFilePath, {
            scope: {
                chainId: 'unknown',
                commitmentSafe: TEST_SAFE,
                policyName: null,
                authorizedAgent: TEST_AGENT,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC,
                ogModule: TEST_OG_MODULE,
                ctfContract: TEST_CTF,
            },
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-open-runtime-chain-check`]: {
                    sourceKind: 'signed_trade_intent',
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-open-runtime-chain-check`,
                    requestId: 'pm-intent-open-runtime-chain-check',
                    messageId: 'msg_pm-intent-open-runtime-chain-check',
                    signer: TEST_SIGNER.toLowerCase(),
                    signature: TEST_SIGNATURE,
                    signedAtMs: 1_800_000_000_000,
                    marketId: 'market-123',
                    side: 'BUY',
                    outcome: 'NO',
                    tokenId: NO_TOKEN_ID,
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    maxPrice: '0.42',
                    maxPriceScaled: '420000',
                    orderMakerAmount: '25000000',
                    orderTakerAmount: '59523810',
                    archiveFilename: 'signed-intent-open-runtime-chain-check.json',
                    artifactCid: 'bafy-open-runtime-chain-check',
                    artifactUri: 'ipfs://bafy-open-runtime-chain-check',
                    canonicalMessage: buildSignedMessagePayload({
                        address: TEST_SIGNER,
                        chainId: 137,
                        timestampMs: 1_800_000_000_000,
                        text: 'Buy NO for up to 25 USDC if the price is 0.42 or better before 6pm UTC.',
                        command: 'buy',
                        requestId: 'pm-intent-open-runtime-chain-check',
                        deadline: 1_800_000_060_000,
                    }),
                    sequence: 1,
                    creditReservedAtMs: 1_800_000_000_000,
                    expiryMs: 1_800_000_060_000,
                    createdAtMs: 1_800_000_000_000,
                    updatedAtMs: 1_800_000_000_000,
                },
            },
            deposits: {
                'tx:0xdeposit:0': {
                    depositKey: 'tx:0xdeposit:0',
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '25000000',
                    transactionHash: '0xdeposit',
                    logIndex: '0',
                    blockNumber: '1',
                    createdAtMs: 1_800_000_000_000,
                },
            },
        });
        runtime.chainIdError = 'chain id rpc unavailable';
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [],
                    commitmentSafe: TEST_SAFE,
                    agentAddress: TEST_AGENT,
                    publicClient,
                    config: buildModuleConfig({
                        chainId: undefined,
                    }),
                }),
            /runtime chain id/i
        );
        runtime.chainIdError = null;
        await resetTradeIntentState();

        const dollarSignSpendSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-dollar-sign-spend',
            text: 'Buy NO for up to $25 if the price is 42 cents or better before 6pm UTC.',
        });
        const dollarSignSpendInterpreted = interpretSignedTradeIntentSignal(dollarSignSpendSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                minimumTickSizeScaled: '10000',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: dollarSignSpendSignal.receivedAtMs,
        });
        assert.equal(dollarSignSpendInterpreted.ok, true);
        assert.equal(dollarSignSpendInterpreted.intent.maxSpendWei, '25000000');

        const textExpiryOnlySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-text-expiry-only',
        });
        delete textExpiryOnlySignal.deadline;
        delete textExpiryOnlySignal.expiresAtMs;
        const textExpiryOnlyInterpreted = interpretSignedTradeIntentSignal(textExpiryOnlySignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                minimumTickSizeScaled: '10000',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: textExpiryOnlySignal.receivedAtMs,
        });
        assert.equal(textExpiryOnlyInterpreted.ok, true);
        assert.equal(
            textExpiryOnlyInterpreted.intent.expiryMs,
            Date.parse('2027-01-15T18:00:00.000Z')
        );

        const conflictingExpirySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-conflicting-expiry',
            deadline: Date.parse('2027-01-15T19:00:00.000Z'),
            text: 'Buy NO for up to 25 USDC if the price is 0.42 or better before 2027-01-15 18:00 UTC.',
        });
        const conflictingExpiryInterpreted = interpretSignedTradeIntentSignal(
            conflictingExpirySignal,
            {
                policy: {
                    ready: true,
                    marketId: 'market-123',
                    minimumTickSizeScaled: '10000',
                    yesTokenId: YES_TOKEN_ID,
                    noTokenId: NO_TOKEN_ID,
                    collateralToken: TEST_USDC.toLowerCase(),
                    ctfContract: TEST_CTF.toLowerCase(),
                    signedCommands: new Set(['buy']),
                },
                nowMs: conflictingExpirySignal.receivedAtMs,
            }
        );
        assert.equal(conflictingExpiryInterpreted.ok, false);
        assert.equal(conflictingExpiryInterpreted.reason, 'ambiguous_expiry');

        const ttlOnlySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-ttl-only',
            text: 'Buy NO for up to 25 USDC if the price is 0.42 or better.',
        });
        delete ttlOnlySignal.deadline;
        ttlOnlySignal.expiresAtMs = ttlOnlySignal.receivedAtMs + 60_000;
        const ttlOnlyInterpreted = interpretSignedTradeIntentSignal(ttlOnlySignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: ttlOnlySignal.receivedAtMs,
        });
        assert.equal(ttlOnlyInterpreted.ok, false);
        assert.equal(ttlOnlyInterpreted.reason, 'missing_expiry');

        const negatedBuySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-negated-buy',
            text: "Don't buy YES for 25 USDC at 42 cents before 6pm UTC.",
        });
        const negatedBuyInterpreted = interpretSignedTradeIntentSignal(negatedBuySignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: negatedBuySignal.receivedAtMs,
        });
        assert.equal(negatedBuyInterpreted.ok, false);
        assert.equal(negatedBuyInterpreted.reason, 'missing_or_ambiguous_outcome');

        const invalidSignerSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-invalid-signer',
            signer: 'not-an-address',
        });
        const invalidSignerInterpreted = interpretSignedTradeIntentSignal(invalidSignerSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: invalidSignerSignal.receivedAtMs,
        });
        assert.equal(invalidSignerInterpreted.ok, false);
        assert.equal(invalidSignerInterpreted.reason, 'invalid_signer');
        const invalidSignerCalls = await getDeterministicToolCalls({
            signals: [invalidSignerSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(invalidSignerCalls, []);

        const sized = computeBuyOrderAmounts({
            collateralAmountWei: 25_000_000n,
            price: 0.42,
        });
        assert.equal(sized.makerAmount, '25000000');
        assert.equal(sized.takerAmount, '59523810');

        const archiveArtifact = buildSignedTradeIntentArchiveArtifact({
            record: interpreted.intent,
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
        });
        assert.equal(archiveArtifact.requestId, validSignal.requestId);
        assert.equal(archiveArtifact.interpretedIntent.outcome, 'NO');
        assert.equal(
            archiveArtifact.signedRequest.canonicalMessage,
            buildSignedMessagePayload({
                address: TEST_SIGNER.toLowerCase(),
                chainId: validSignal.chainId,
                timestampMs: validSignal.sender.signedAtMs,
                text: validSignal.text,
                command: validSignal.command,
                args: validSignal.args,
                metadata: validSignal.metadata,
                requestId: validSignal.requestId,
                deadline: validSignal.deadline,
            })
        );

        const invalidSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-invalid',
            text: 'Sell YES at 0.40 for 10 USDC.',
        });
        const invalidInterpreted = interpretSignedTradeIntentSignal(invalidSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: invalidSignal.receivedAtMs,
        });
        assert.equal(invalidInterpreted.ok, false);

        const boundaryPriceSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-boundary-price',
            text: 'Buy NO for up to 25 USDC if the price is 100 cents or better before 6pm UTC.',
        });
        const boundaryPriceInterpreted = interpretSignedTradeIntentSignal(boundaryPriceSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: boundaryPriceSignal.receivedAtMs,
        });
        assert.equal(boundaryPriceInterpreted.ok, false);
        assert.equal(boundaryPriceInterpreted.reason, 'invalid_order_price');
        const boundaryPriceCalls = await getDeterministicToolCalls({
            signals: [boundaryPriceSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(boundaryPriceCalls, []);
        state = getTradeIntentState();
        assert.equal(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-boundary-price`],
            undefined
        );

        const offTickSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-off-tick',
            text: 'Buy NO for up to 25 USDC if the price is 0.421 or better before 6pm UTC.',
        });
        const offTickInterpreted = interpretSignedTradeIntentSignal(offTickSignal, {
            policy: {
                ready: true,
                marketId: 'market-123',
                minimumTickSizeScaled: '10000',
                yesTokenId: YES_TOKEN_ID,
                noTokenId: NO_TOKEN_ID,
                collateralToken: TEST_USDC.toLowerCase(),
                ctfContract: TEST_CTF.toLowerCase(),
                signedCommands: new Set(['buy']),
            },
            nowMs: offTickSignal.receivedAtMs,
        });
        assert.equal(offTickInterpreted.ok, false);
        assert.equal(offTickInterpreted.reason, 'invalid_price_tick');
        const offTickCalls = await getDeterministicToolCalls({
            signals: [offTickSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(offTickCalls, []);
        state = getTradeIntentState();
        assert.equal(state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-off-tick`], undefined);

        await resetTradeIntentState();
        runtime.latestBlock = 100n;
        runtime.bookPayload = {
            minimum_tick_size: '0.001',
        };
        const liveTickSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-live-tick-size',
            text: 'Buy NO for up to 25 USDC if the price is 0.421 or better before 6pm UTC.',
        });
        const liveTickCalls = await getDeterministicToolCalls({
            signals: [liveTickSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                polymarketClobHost: 'https://clob-live-tick.example',
                agentConfig: {
                    polymarketIntentTrader: {
                        minimumTickSize: '0.01',
                    },
                },
            }),
        });
        assert.equal(liveTickCalls.length, 1);
        assert.equal(liveTickCalls[0].name, 'ipfs_publish');
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-live-tick-size`];
        assert.ok(storedIntent);
        assert.equal(storedIntent.maxPriceScaled, '421000');
        await resetTradeIntentState();
        runtime.bookPayload = {
            minimum_tick_size: '0.01',
        };

        const enrichedSignals = await enrichSignals([validSignal], {
            config: buildModuleConfig(),
            account: {
                address: TEST_AGENT,
            },
            nowMs: validSignal.receivedAtMs,
        });
        assert.ok(
            enrichedSignals.some((entry) => entry.kind === 'polymarketTradeIntent')
        );
        assert.ok(
            enrichedSignals.some((entry) => entry.kind === 'polymarketSignedIntentArchive')
        );
        assert.ok(
            enrichedSignals.some((entry) => entry.kind === 'polymarketTradeIntentState')
        );

        const archiveCalls = await getDeterministicToolCalls({
            signals: [validSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(archiveCalls.length, 1);
        assert.equal(archiveCalls[0].name, 'ipfs_publish');
        const archiveArgs = JSON.parse(archiveCalls[0].arguments);
        assert.equal(archiveArgs.filename, interpreted.intent.archiveFilename);
        assert.equal(archiveArgs.pin, true);
        assert.equal(archiveArgs.json.interpretedIntent.maxSpendWei, '25000000');

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.ok(storedIntent);
        assert.equal(storedIntent.reservedCreditAmountWei, '25000000');
        assert.equal(typeof storedIntent.lastArchiveAttemptAtMs, 'number');
        assert.equal(
            Object.values(state.deposits).filter((deposit) => deposit.depositor === TEST_SIGNER.toLowerCase()).length,
            1
        );

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent',
                uri: 'ipfs://bafyintent',
                pinned: true,
            },
            config: buildModuleConfig(),
        });

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(storedIntent.artifactCid, 'bafyintent');
        assert.equal(storedIntent.artifactUri, 'ipfs://bafyintent');

        const orderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(orderCalls.length, 1);
        assert.equal(orderCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
        const orderArgs = JSON.parse(orderCalls[0].arguments);
        assert.equal(orderArgs.side, 'BUY');
        assert.equal(orderArgs.tokenId, NO_TOKEN_ID);
        assert.equal(orderArgs.orderType, 'FOK');
        assert.equal(orderArgs.makerAmount, '25000000');
        assert.equal(orderArgs.takerAmount, '59523810');
        assert.equal(orderArgs.feeRateBps, '30');
        assert.equal(orderArgs.chainId, '137');
        const duplicateOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(duplicateOrderCalls, []);

        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });

        runtime.ctfBalances[`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`] = 100_000_000n;

        const depositCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositCalls.length, 1);
        assert.equal(depositCalls[0].name, 'make_erc1155_deposit');
        const depositArgs = JSON.parse(depositCalls[0].arguments);
        assert.equal(depositArgs.token, TEST_CTF.toLowerCase());
        assert.equal(depositArgs.tokenId, NO_TOKEN_ID);
        assert.equal(depositArgs.amount, '62400000');
        const duplicateDepositCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(duplicateDepositCalls, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(storedIntent.depositSubmittedAtMs, undefined);

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(storedIntent.reimbursementAmountWei, '20000000');
        assert.equal(storedIntent.reservedCreditAmountWei, '20000000');
        assert.equal(storedIntent.filledShareAmount, '62400000');
        assert.equal(storedIntent.feeRateBps, '30');
        const creditStateSignal = (
            await enrichSignals([], {
                config: buildModuleConfig(),
                account: {
                    address: TEST_AGENT,
                },
                nowMs: validSignal.receivedAtMs,
            })
        ).find((entry) => entry.kind === 'polymarketTradeIntentState');
        assert.equal(
            creditStateSignal.credits[TEST_SIGNER.toLowerCase()].availableWei,
            '30000000'
        );

        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });

        const reimbursementCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementCalls.length, 1);
        assert.equal(reimbursementCalls[0].name, 'post_bond_and_propose');
        const reimbursementArgs = JSON.parse(reimbursementCalls[0].arguments);
        assert.equal(reimbursementArgs.transactions.length, 1);
        assert.equal(
            reimbursementArgs.transactions[0].to.toLowerCase(),
            TEST_USDC.toLowerCase()
        );
        assert.ok(reimbursementArgs.explanation.includes('spentWei=20000000'));
        assert.ok(reimbursementArgs.explanation.includes('signedRequestCid=ipfs%3A%2F%2Fbafyintent'));
        assert.ok(reimbursementArgs.explanation.includes(`orderId=${encodeURIComponent(TEST_ORDER_ID)}`));
        assert.ok(
            reimbursementArgs.explanation.includes(
                `depositTx=${encodeURIComponent(TEST_DEPOSIT_TX_HASH.toLowerCase())}`
            )
        );
        const duplicateReimbursementCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(duplicateReimbursementCalls, []);

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_REIMBURSE_TX_HASH,
                ogProposalHash: TEST_PROPOSAL_HASH,
            },
            config: buildModuleConfig(),
        });

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(storedIntent.orderId, TEST_ORDER_ID);
        assert.equal(storedIntent.orderFilled, true);
        assert.equal(storedIntent.tokenDeposited, true);
        assert.equal(storedIntent.reimbursementProposalHash, TEST_PROPOSAL_HASH.toLowerCase());
        assert.equal(
            storedIntent.reimbursementRecipientAddress,
            TEST_AGENT.toLowerCase()
        );

        onProposalEvents({
            executedProposals: [TEST_PROPOSAL_HASH],
        });

        const noFurtherCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noFurtherCalls, []);

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(typeof storedIntent.reimbursedAtMs, 'number');

        await resetTradeIntentState();
        runtime.latestBlock = 200n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];

        const ambiguousSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-ambiguous',
        });
        const ambiguousArchiveCalls = await getDeterministicToolCalls({
            signals: [ambiguousSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(ambiguousArchiveCalls.length, 1);
        assert.equal(ambiguousArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-ambiguous',
                uri: 'ipfs://bafyintent-ambiguous',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const ambiguousOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(ambiguousOrderCalls.length, 1);
        assert.equal(ambiguousOrderCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'error',
                message: 'socket hang up',
            },
            config: buildModuleConfig(),
        });
        const noDuplicateAfterAmbiguousOrderError = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noDuplicateAfterAmbiguousOrderError, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-ambiguous`];
        assert.equal(storedIntent.lastOrderSubmissionStatus, 'error');
        assert.equal(storedIntent.lastOrderSubmissionError, 'socket hang up');
        assert.equal(storedIntent.orderSubmittedAtMs, undefined);
        assert.equal(typeof storedIntent.nextOrderAttemptAtMs, 'number');

        await resetTradeIntentState();
        runtime.latestBlock = 225n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const ambiguousCommittedSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-ambiguous-committed',
        });
        const ambiguousCommittedArchiveCalls = await getDeterministicToolCalls({
            signals: [ambiguousCommittedSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(ambiguousCommittedArchiveCalls.length, 1);
        assert.equal(ambiguousCommittedArchiveCalls[0].name, 'ipfs_publish');
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-ambiguous-committed',
                uri: 'ipfs://bafyintent-ambiguous-committed',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const ambiguousCommittedOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(ambiguousCommittedOrderCalls.length, 1);
        assert.equal(
            ambiguousCommittedOrderCalls[0].name,
            'polymarket_clob_build_sign_and_place_order'
        );
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'error',
                message: 'socket hang up after POST',
                sideEffectsLikelyCommitted: true,
            },
            config: buildModuleConfig(),
        });
        const noDuplicateAfterCommittedOrderError = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noDuplicateAfterCommittedOrderError, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-ambiguous-committed`];
        assert.equal(storedIntent.lastOrderSubmissionStatus, 'error');
        assert.equal(storedIntent.lastOrderSubmissionError, 'socket hang up after POST');
        assert.equal(typeof storedIntent.orderSubmittedAtMs, 'number');
        assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');
        assert.equal(storedIntent.nextOrderAttemptAtMs, undefined);
        const laterIntentAfterCommittedAmbiguity = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-after-ambiguous-committed',
                    receivedAtMs: Number(storedIntent.orderSubmittedAtMs) + 1,
                    signedAtMs: Number(storedIntent.orderSubmittedAtMs) + 1,
                    deadline: Number(storedIntent.orderSubmittedAtMs) + 60_001,
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(laterIntentAfterCommittedAmbiguity.length, 1);
        assert.equal(laterIntentAfterCommittedAmbiguity[0].name, 'ipfs_publish');

        await resetTradeIntentState();
        runtime.latestBlock = 250n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const missingOrderIdSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-missing-order-id',
        });
        const missingOrderIdArchiveCalls = await getDeterministicToolCalls({
            signals: [missingOrderIdSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        assert.equal(missingOrderIdArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-missing-order-id',
                uri: 'ipfs://bafyintent-missing-order-id',
                pinned: true,
            },
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        const missingOrderIdOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        assert.equal(missingOrderIdOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        let missingOrderIdFollowupCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        assert.deepEqual(missingOrderIdFollowupCalls, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-missing-order-id`];
        assert.equal(storedIntent.closedAtMs, undefined);
        assert.equal(storedIntent.orderId ?? null, null);
        assert.equal(typeof storedIntent.orderSubmittedAtMs, 'number');
        assert.equal(storedIntent.lastOrderSubmissionStatus, 'missing_order_id');
        assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');
        const secondIntentBeforeTimeoutArchiveCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-after-missing-order-id-immediate',
                    receivedAtMs: Number(storedIntent.orderSubmittedAtMs) + 1,
                    signedAtMs: Number(storedIntent.orderSubmittedAtMs) + 1,
                    deadline: Number(storedIntent.orderSubmittedAtMs) + 60_001,
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            }),
        });
        assert.equal(secondIntentBeforeTimeoutArchiveCalls.length, 1);
        assert.equal(secondIntentBeforeTimeoutArchiveCalls[0].name, 'ipfs_publish');
        const missingOrderIdDateNow = Date.now;
        try {
            Date.now = () => Number(storedIntent.orderSubmittedAtMs) + 2_000;
            missingOrderIdFollowupCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.deepEqual(missingOrderIdFollowupCalls, []);
            state = getTradeIntentState();
            storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-missing-order-id`];
            assert.equal(storedIntent.closedAtMs, undefined);
            assert.equal(storedIntent.creditReleasedAtMs, undefined);
            assert.equal(storedIntent.lastOrderSubmissionStatus, 'missing_order_id');
            assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');

            const postTimeoutStateStat = await stat(stateFilePath);
            await new Promise((resolve) => setTimeout(resolve, 20));
            missingOrderIdFollowupCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.deepEqual(missingOrderIdFollowupCalls, []);
            const repeatedPostTimeoutStateStat = await stat(stateFilePath);
            assert.equal(repeatedPostTimeoutStateStat.mtimeMs, postTimeoutStateStat.mtimeMs);

            Date.now = () => Number(storedIntent.expiryMs) + 2_000;
            missingOrderIdFollowupCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.deepEqual(missingOrderIdFollowupCalls, []);
            state = getTradeIntentState();
            storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-missing-order-id`];
            assert.equal(storedIntent.closedAtMs, undefined);
            assert.equal(storedIntent.creditReleasedAtMs, undefined);
            assert.equal(typeof storedIntent.orderSubmittedAtMs, 'number');
            assert.equal(storedIntent.lastOrderSubmissionStatus, 'missing_order_id');
        } finally {
            Date.now = missingOrderIdDateNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 300n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderFetchError = null;
        runtime.tradesFetchError = null;
        const originalDateNow = Date.now;
        try {
            const baseNowMs = 1_900_000_000_000;
            Date.now = () => baseNowMs;
            const timeoutSignal = buildSignedMessageSignal({
                requestId: 'pm-intent-timeout',
                receivedAtMs: baseNowMs,
                signedAtMs: baseNowMs,
                deadline: baseNowMs + 60_000,
            });
            const timeoutArchiveCalls = await getDeterministicToolCalls({
                signals: [timeoutSignal],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.equal(timeoutArchiveCalls.length, 1);
            assert.equal(timeoutArchiveCalls[0].name, 'ipfs_publish');
            await onToolOutput({
                name: 'ipfs_publish',
                parsedOutput: {
                    status: 'published',
                    cid: 'bafyintent-timeout',
                    uri: 'ipfs://bafyintent-timeout',
                    pinned: true,
                },
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            const timeoutOrderCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.equal(timeoutOrderCalls.length, 1);
            assert.equal(timeoutOrderCalls[0].name, 'polymarket_clob_build_sign_and_place_order');
            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: TEST_TIMEOUT_ORDER_ID,
                            status: 'LIVE',
                        },
                    },
                },
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });

            runtime.orderFetchError = 'CLOB unavailable';
            Date.now = () => baseNowMs + 2_000;

            const timeoutFollowupCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: buildModuleConfig({
                    agentConfig: {
                        polymarketIntentTrader: {
                            pendingTxTimeoutMs: 1_000,
                        },
                    },
                }),
            });
            assert.deepEqual(timeoutFollowupCalls, []);

            state = getTradeIntentState();
            storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-timeout`];
            assert.equal(storedIntent.closedAtMs, undefined);
            assert.equal(storedIntent.creditReleasedAtMs, undefined);
            assert.equal(storedIntent.orderId, TEST_TIMEOUT_ORDER_ID);
            assert.equal(storedIntent.reservedCreditAmountWei, '25000000');
            assert.equal(storedIntent.lastOrderStatusRefreshError, 'CLOB unavailable');
            assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');
        } finally {
            Date.now = originalDateNow;
            runtime.orderFetchError = null;
            runtime.tradesFetchError = null;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 390n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 25_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const reimbursementCreditBlockedSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-reimbursement-credit-blocked',
        });
        const reimbursementCreditBlockedArchiveCalls = await getDeterministicToolCalls({
            signals: [reimbursementCreditBlockedSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementCreditBlockedArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-reimbursement-credit-blocked',
                uri: 'ipfs://bafyintent-reimbursement-credit-blocked',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const reimbursementCreditBlockedOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementCreditBlockedOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        runtime.latestBlock = 391n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'9'.repeat(64)}`,
                    explanation:
                        'polymarket-intent-trader reimbursement | intent=external-intent | signer=0x1111111111111111111111111111111111111111 | spentWei=25000000',
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000017d7840',
                            },
                        ],
                    },
                },
                blockNumber: 391n,
                logIndex: 0,
            },
        ];
        const reimbursementCreditBlockedCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(reimbursementCreditBlockedCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-credit-blocked`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(storedIntent.reimbursementDispatchAtMs, undefined);
        assert.equal(storedIntent.lastReimbursementCreditError.includes('headroomWei=0'), true);
        assert.equal(Object.keys(state.reimbursementCommitments).length, 1);

        await resetTradeIntentState();
        runtime.latestBlock = 395n;
        runtime.safeCollateralBalance = 0n;
        runtime.depositLogs = [];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-safe-balance-blocked`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-safe-balance-blocked`,
                    requestId: 'pm-intent-reimbursement-safe-balance-blocked',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    tokenDeposited: true,
                    tokenDepositedAtMs: 1_900_000_000_000,
                    artifactCid: 'bafy-reimbursement-safe-balance-blocked',
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_000_000,
                },
            },
            deposits: {
                'tx:0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:0': {
                    depositKey:
                        'tx:0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:0',
                    depositId: null,
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    transactionHash: `0x${'d'.repeat(64)}`,
                    logIndex: '0',
                    blockNumber: '10',
                    createdAtMs: 1_900_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '395',
            backfilledReimbursementCommitmentsThroughBlock: '395',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const reimbursementSafeBalanceCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(reimbursementSafeBalanceCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-safe-balance-blocked`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(storedIntent.reimbursementDispatchAtMs, undefined);
        assert.equal(storedIntent.lastReimbursementCreditError.includes('headroomWei=0'), true);
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 395n;
        runtime.safeCollateralBalance = null;
        runtime.collateralBalanceReadError = 'safe reimbursement balance unavailable';
        runtime.depositLogs = [];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-balance-read-blocked`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-balance-read-blocked`,
                    requestId: 'pm-intent-reimbursement-balance-read-blocked',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    tokenDeposited: true,
                    tokenDepositedAtMs: 1_900_000_000_000,
                    artifactCid: 'bafy-reimbursement-balance-read-blocked',
                    createdAtMs: 1_900_000_000_000,
                    updatedAtMs: 1_900_000_000_000,
                },
            },
            deposits: {
                'tx:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:0': {
                    depositKey:
                        'tx:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:0',
                    depositId: null,
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    transactionHash: `0x${'e'.repeat(64)}`,
                    logIndex: '0',
                    blockNumber: '10',
                    createdAtMs: 1_900_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '395',
            backfilledReimbursementCommitmentsThroughBlock: '395',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const reimbursementBalanceReadBlockedCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(reimbursementBalanceReadBlockedCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-balance-read-blocked`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(storedIntent.reimbursementDispatchAtMs, undefined);
        assert.equal(
            storedIntent.lastReimbursementCreditError.includes(
                'Unable to confirm actual Safe collateral headroom'
            ),
            true
        );
        runtime.collateralBalanceReadError = null;

        await resetTradeIntentState();
        runtime.latestBlock = 396n;
        runtime.safeCollateralBalance = 100_000_000n;
        runtime.depositLogs = [];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-deposited-does-not-block-next-order`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-deposited-does-not-block-next-order`,
                    requestId: 'pm-intent-deposited-does-not-block-next-order',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderId: 'order-deposited-does-not-block-next-order',
                    orderFilled: true,
                    tokenDeposited: true,
                    tokenDepositedAtMs: 1_900_000_100_000,
                    artifactCid: 'bafy-deposited-does-not-block-next-order',
                    createdAtMs: 1_900_000_100_000,
                    updatedAtMs: 1_900_000_100_000,
                },
            },
            deposits: {
                'tx:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0': {
                    depositKey:
                        'tx:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
                    depositId: null,
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '100000000',
                    transactionHash: `0x${'a'.repeat(64)}`,
                    logIndex: '0',
                    blockNumber: '10',
                    createdAtMs: 1_900_000_100_000,
                },
            },
            backfilledDepositsThroughBlock: '396',
            backfilledReimbursementCommitmentsThroughBlock: '396',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const nextIntentWhileDepositedCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-after-deposited-order',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
            onchainPendingProposal: true,
        });
        assert.equal(nextIntentWhileDepositedCalls.length, 1);
        assert.equal(nextIntentWhileDepositedCalls[0].name, 'ipfs_publish');
        state = getTradeIntentState();
        assert.ok(
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-after-deposited-order`]
        );
        runtime.safeCollateralBalance = null;

        await resetTradeIntentState();
        runtime.latestBlock = 400n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.orderFetchError = null;
        runtime.tradesFetchError = null;
        const proposalPendingDateNow = Date.now;
        try {
            const baseNowMs = 1_910_000_000_000;
            Date.now = () => baseNowMs;
            const proposalPendingConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            });
            const proposalPendingSignal = buildSignedMessageSignal({
                requestId: 'pm-intent-proposal-pending',
                receivedAtMs: baseNowMs,
                signedAtMs: baseNowMs,
                deadline: baseNowMs + 60_000,
            });
            const proposalPendingArchiveCalls = await getDeterministicToolCalls({
                signals: [proposalPendingSignal],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalPendingConfig,
            });
            assert.equal(proposalPendingArchiveCalls.length, 1);
            await onToolOutput({
                name: 'ipfs_publish',
                parsedOutput: {
                    status: 'published',
                    cid: 'bafyintent-proposal-pending',
                    uri: 'ipfs://bafyintent-proposal-pending',
                    pinned: true,
                },
                config: proposalPendingConfig,
            });
            const proposalPendingOrderCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalPendingConfig,
            });
            assert.equal(proposalPendingOrderCalls.length, 1);
            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: TEST_ORDER_ID,
                            status: 'LIVE',
                        },
                    },
                },
                config: proposalPendingConfig,
            });
            await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalPendingConfig,
            });
            await onToolOutput({
                name: 'make_erc1155_deposit',
                parsedOutput: {
                    status: 'confirmed',
                    transactionHash: TEST_DEPOSIT_TX_HASH,
                },
                config: proposalPendingConfig,
            });
            const proposalPendingCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalPendingConfig,
            });
            assert.equal(proposalPendingCalls.length, 1);
            assert.equal(proposalPendingCalls[0].name, 'post_bond_and_propose');
            await onToolOutput({
                name: 'post_bond_and_propose',
                parsedOutput: {
                    status: 'pending',
                    message: 'receipt wait timed out',
                    sideEffectsLikelyCommitted: true,
                },
                config: proposalPendingConfig,
            });

            Date.now = () => baseNowMs + 2_000;
            const noDuplicateAfterPendingProposal = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalPendingConfig,
            });
            assert.deepEqual(noDuplicateAfterPendingProposal, []);

            state = getTradeIntentState();
            storedIntent =
                state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-pending`];
            assert.equal(typeof storedIntent.reimbursementSubmittedAtMs, 'number');
            assert.equal(storedIntent.reimbursementSubmissionAmbiguous, true);
            assert.equal(storedIntent.lastReimbursementSubmissionStatus, 'pending');
            assert.equal(
                storedIntent.lastReimbursementSubmissionError,
                'receipt wait timed out'
            );
            assert.equal(typeof storedIntent.reimbursementSubmissionAmbiguousAtMs, 'number');
        } finally {
            Date.now = proposalPendingDateNow;
            runtime.orderFetchError = null;
            runtime.tradesFetchError = null;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 425n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        const reimbursementFailureSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-reimbursement-terminal-failure',
        });
        const reimbursementFailureArchiveCalls = await getDeterministicToolCalls({
            signals: [reimbursementFailureSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementFailureArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-reimbursement-terminal-failure',
                uri: 'ipfs://bafyintent-reimbursement-terminal-failure',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const reimbursementFailureOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementFailureOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const reimbursementFailureCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(reimbursementFailureCalls.length, 1);
        assert.equal(reimbursementFailureCalls[0].name, 'post_bond_and_propose');
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'skipped',
                message: 'proposal already exists',
                retryable: false,
            },
            config: buildModuleConfig(),
        });
        const noRetryAfterTerminalReimbursementFailure = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRetryAfterTerminalReimbursementFailure, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-terminal-failure`];
        assert.equal(typeof storedIntent.closedAtMs, 'number');
        assert.equal(storedIntent.terminalFailureStage, 'reimbursement_submission');
        assert.equal(storedIntent.terminalFailureStatus, 'skipped');
        assert.equal(storedIntent.creditReleasedAtMs, undefined);

        await resetTradeIntentState();
        runtime.latestBlock = 450n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const proposalTxTimeoutNow = Date.now;
        try {
            const baseNowMs = 1_915_000_000_000;
            Date.now = () => baseNowMs;
            const proposalTxTimeoutConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            });
            const proposalTxTimeoutSignal = buildSignedMessageSignal({
                requestId: 'pm-intent-proposal-tx-timeout',
                receivedAtMs: baseNowMs,
                signedAtMs: baseNowMs,
                deadline: baseNowMs + 60_000,
            });
            const proposalTxTimeoutArchiveCalls = await getDeterministicToolCalls({
                signals: [proposalTxTimeoutSignal],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            assert.equal(proposalTxTimeoutArchiveCalls.length, 1);
            await onToolOutput({
                name: 'ipfs_publish',
                parsedOutput: {
                    status: 'published',
                    cid: 'bafyintent-proposal-tx-timeout',
                    uri: 'ipfs://bafyintent-proposal-tx-timeout',
                    pinned: true,
                },
                config: proposalTxTimeoutConfig,
            });
            const proposalTxTimeoutOrderCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            assert.equal(proposalTxTimeoutOrderCalls.length, 1);
            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: TEST_ORDER_ID,
                            status: 'LIVE',
                        },
                    },
                },
                config: proposalTxTimeoutConfig,
            });
            await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            await onToolOutput({
                name: 'make_erc1155_deposit',
                parsedOutput: {
                    status: 'confirmed',
                    transactionHash: TEST_DEPOSIT_TX_HASH,
                },
                config: proposalTxTimeoutConfig,
            });
            const proposalTxTimeoutCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            assert.equal(proposalTxTimeoutCalls.length, 1);
            assert.equal(proposalTxTimeoutCalls[0].name, 'post_bond_and_propose');
            await onToolOutput({
                name: 'post_bond_and_propose',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: TEST_REIMBURSE_TX_HASH,
                },
                config: proposalTxTimeoutConfig,
            });

            Date.now = () => baseNowMs + 2_000;
            const noDuplicateAfterProposalTxTimeout = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            assert.deepEqual(noDuplicateAfterProposalTxTimeout, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-tx-timeout`];
            assert.equal(
                storedIntent.reimbursementSubmissionTxHash,
                TEST_REIMBURSE_TX_HASH.toLowerCase()
            );
            assert.equal(typeof storedIntent.reimbursementSubmittedAtMs, 'number');
            assert.equal(storedIntent.reimbursementSubmissionAmbiguous, true);
            assert.equal(typeof storedIntent.reimbursementSubmissionAmbiguousAtMs, 'number');

            const postProposalAmbiguityArchiveCalls = await getDeterministicToolCalls({
                signals: [
                    buildSignedMessageSignal({
                        requestId: 'pm-intent-after-proposal-ambiguity',
                        receivedAtMs: baseNowMs + 2_000,
                        signedAtMs: baseNowMs + 2_000,
                        deadline: baseNowMs + 62_000,
                    }),
                ],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: proposalTxTimeoutConfig,
            });
            assert.equal(postProposalAmbiguityArchiveCalls.length, 1);
            assert.equal(postProposalAmbiguityArchiveCalls[0].name, 'ipfs_publish');
        } finally {
            Date.now = proposalTxTimeoutNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 475n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const proposalReceiptRecoverySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-proposal-receipt-recovery',
        });
        const proposalReceiptRecoveryArchiveCalls = await getDeterministicToolCalls({
            signals: [proposalReceiptRecoverySignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalReceiptRecoveryArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-proposal-receipt-recovery',
                uri: 'ipfs://bafyintent-proposal-receipt-recovery',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const proposalReceiptRecoveryOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalReceiptRecoveryOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const proposalReceiptRecoveryCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalReceiptRecoveryCalls.length, 1);
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_REIMBURSE_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        runtime.receipts[TEST_REIMBURSE_TX_HASH.toLowerCase()] = {
            status: 1n,
            logs: [
                {
                    address: buildModuleConfig().ogModule,
                    args: {
                        proposalHash: TEST_PROPOSAL_HASH,
                    },
                },
            ],
        };
        const noDuplicateAfterProposalReceiptRecovery = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noDuplicateAfterProposalReceiptRecovery, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-receipt-recovery`];
        assert.equal(storedIntent.reimbursementProposalHash, TEST_PROPOSAL_HASH.toLowerCase());
        assert.equal(storedIntent.reimbursementSubmissionAmbiguous, undefined);
        assert.equal(storedIntent.reimbursementSubmittedAtMs, undefined);

        await resetTradeIntentState();
        runtime.latestBlock = 489n;
        runtime.receipts = {
            [TEST_DEPOSIT_TX_HASH.toLowerCase()]: {
                status: 0n,
                logs: [],
            },
        };
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 62_500_000n,
        };
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-reverted-receipt`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-reverted-receipt`,
                    requestId: 'pm-intent-deposit-reverted-receipt',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    artifactCid: 'bafy-deposit-reverted-receipt',
                    depositTxHash: TEST_DEPOSIT_TX_HASH.toLowerCase(),
                    depositSubmittedAtMs: 1_920_000_000_000,
                    depositSourceAddress: TEST_AGENT.toLowerCase(),
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    createdAtMs: 1_920_000_000_000,
                    updatedAtMs: 1_920_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '489',
            backfilledReimbursementCommitmentsThroughBlock: '489',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const depositRevertedNow = Date.now;
        try {
            Date.now = () => 1_920_000_002_000;
            const revertedDepositConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                        archiveRetryDelayMs: 5_000,
                    },
                },
            });
            const revertedDepositCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedDepositConfig,
            });
            assert.deepEqual(revertedDepositCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[
                    `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-reverted-receipt`
                ];
            assert.equal(storedIntent.depositTxHash, undefined);
            assert.equal(storedIntent.depositSubmittedAtMs, undefined);
            assert.equal(storedIntent.lastDepositStatus, 'reverted');
            assert.equal(
                storedIntent.lastDepositError,
                'ERC1155 deposit transaction reverted onchain.'
            );
            assert.equal(storedIntent.nextDepositAttemptAtMs, 1_920_000_007_000);

            const noImmediateDepositRetryAfterRevert = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedDepositConfig,
            });
            assert.deepEqual(noImmediateDepositRetryAfterRevert, []);

            Date.now = () => 1_920_000_008_000;
            const depositRetryAfterBackoff = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedDepositConfig,
            });
            assert.equal(depositRetryAfterBackoff.length, 1);
            assert.equal(depositRetryAfterBackoff[0].name, 'make_erc1155_deposit');
        } finally {
            Date.now = depositRevertedNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 489n;
        runtime.receipts = {
            [TEST_REIMBURSE_TX_HASH.toLowerCase()]: {
                status: 0n,
                logs: [],
            },
        };
        runtime.safeCollateralBalance = 50_000_000n;
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-reverted-receipt`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-reverted-receipt`,
                    requestId: 'pm-intent-reimbursement-reverted-receipt',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '20000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    tokenDeposited: true,
                    artifactCid: 'bafy-reimbursement-reverted-receipt',
                    reimbursementSubmissionTxHash: TEST_REIMBURSE_TX_HASH.toLowerCase(),
                    reimbursementSubmittedAtMs: 1_920_000_100_000,
                    reimbursementRecipientAddress: TEST_AGENT.toLowerCase(),
                    reimbursementExplanation:
                        'polymarket-intent-trader reimbursement|intent=pm-intent-reimbursement-reverted-receipt|signer=0x1111111111111111111111111111111111111111|spentWei=20000000|recipient=0x2222222222222222222222222222222222222222',
                    createdAtMs: 1_920_000_100_000,
                    updatedAtMs: 1_920_000_100_000,
                },
            },
            deposits: {
                'signal:valid-deposit': {
                    depositKey: 'signal:valid-deposit',
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    createdAtMs: 1_920_000_100_000,
                },
            },
            backfilledDepositsThroughBlock: '489',
            backfilledReimbursementCommitmentsThroughBlock: '489',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const reimbursementRevertedNow = Date.now;
        try {
            Date.now = () => 1_920_000_102_000;
            const revertedReimbursementConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                        archiveRetryDelayMs: 5_000,
                    },
                },
            });
            const revertedReimbursementCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedReimbursementConfig,
            });
            assert.deepEqual(revertedReimbursementCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[
                    `${TEST_SIGNER.toLowerCase()}:pm-intent-reimbursement-reverted-receipt`
                ];
            assert.equal(storedIntent.reimbursementSubmissionTxHash, undefined);
            assert.equal(storedIntent.reimbursementSubmittedAtMs, undefined);
            assert.equal(storedIntent.lastReimbursementSubmissionStatus, 'reverted');
            assert.equal(
                storedIntent.lastReimbursementSubmissionError,
                'Reimbursement proposal transaction reverted onchain.'
            );
            assert.equal(storedIntent.nextReimbursementAttemptAtMs, 1_920_000_107_000);

            const noImmediateReimbursementRetryAfterRevert = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedReimbursementConfig,
            });
            assert.deepEqual(noImmediateReimbursementRetryAfterRevert, []);

            Date.now = () => 1_920_000_108_000;
            const reimbursementRetryAfterBackoff = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: revertedReimbursementConfig,
            });
            assert.equal(reimbursementRetryAfterBackoff.length, 1);
            assert.equal(reimbursementRetryAfterBackoff[0].name, 'post_bond_and_propose');
        } finally {
            Date.now = reimbursementRevertedNow;
        }

        await resetTradeIntentState();
        runtime.latestBlock = 490n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const proposalEventRecoverySignal = buildSignedMessageSignal({
            requestId: 'pm-intent-proposal-event-recovery',
        });
        const proposalEventRecoveryArchiveCalls = await getDeterministicToolCalls({
            signals: [proposalEventRecoverySignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalEventRecoveryArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-proposal-event-recovery',
                uri: 'ipfs://bafyintent-proposal-event-recovery',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const proposalEventRecoveryOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalEventRecoveryOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const proposalEventRecoveryCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(proposalEventRecoveryCalls.length, 1);
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_REIMBURSE_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        onProposalEvents({
            executedProposals: [TEST_PROPOSAL_HASH],
        });
        let noDuplicateAfterProposalEventRecovery = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noDuplicateAfterProposalEventRecovery, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-event-recovery`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(storedIntent.reimbursedAtMs, undefined);
        assert.deepEqual(state.pendingExecutedProposalHashes, [TEST_PROPOSAL_HASH.toLowerCase()]);

        const deletedProposalHash = `0x${'8'.repeat(64)}`;
        runtime.latestBlock = 493n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: deletedProposalHash,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 491n,
                logIndex: 0,
            },
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: TEST_PROPOSAL_HASH,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 492n,
                logIndex: 0,
            },
        ];
        runtime.deletedProposalLogs = [
            {
                args: {
                    proposalHash: deletedProposalHash,
                },
                blockNumber: 493n,
                logIndex: 0,
            },
        ];
        noDuplicateAfterProposalEventRecovery = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noDuplicateAfterProposalEventRecovery, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-proposal-event-recovery`];
        assert.equal(storedIntent.reimbursementProposalHash, TEST_PROPOSAL_HASH.toLowerCase());
        assert.equal(typeof storedIntent.reimbursedAtMs, 'number');
        assert.deepEqual(state.pendingExecutedProposalHashes, []);

        await resetTradeIntentState();
        runtime.latestBlock = 520n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        const deletedBackfillProposalHash = `0x${'9'.repeat(64)}`;
        const deletedBackfillSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-backfilled-deleted-proposal',
        });
        const deletedBackfillArchiveCalls = await getDeterministicToolCalls({
            signals: [deletedBackfillSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(deletedBackfillArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-backfilled-deleted-proposal',
                uri: 'ipfs://bafyintent-backfilled-deleted-proposal',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const deletedBackfillOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(deletedBackfillOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const deletedBackfillProposalCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(deletedBackfillProposalCalls.length, 1);
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                ogProposalHash: deletedBackfillProposalHash,
                transactionHash: TEST_REIMBURSE_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-deleted-proposal`];
        runtime.latestBlock = 522n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: deletedBackfillProposalHash,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 521n,
                logIndex: 0,
            },
        ];
        runtime.deletedProposalLogs = [
            {
                args: {
                    proposalHash: deletedBackfillProposalHash,
                },
                blockNumber: 522n,
                logIndex: 0,
            },
        ];
        setTradeIntentStatePathForTest(stateFilePath);
        const replacementProposalCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(replacementProposalCalls.length, 1);
        assert.equal(replacementProposalCalls[0].name, 'post_bond_and_propose');
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-deleted-proposal`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(typeof storedIntent.reimbursementDispatchAtMs, 'number');

        await resetTradeIntentState();
        runtime.latestBlock = 530n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        const executedBackfillProposalHash = `0x${'7'.repeat(64)}`;
        const executedBackfillSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-backfilled-executed-proposal',
        });
        const executedBackfillArchiveCalls = await getDeterministicToolCalls({
            signals: [executedBackfillSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(executedBackfillArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-backfilled-executed-proposal',
                uri: 'ipfs://bafyintent-backfilled-executed-proposal',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const executedBackfillOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(executedBackfillOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const executedBackfillProposalCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(executedBackfillProposalCalls.length, 1);
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                ogProposalHash: executedBackfillProposalHash,
                transactionHash: TEST_REIMBURSE_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-executed-proposal`];
        runtime.latestBlock = 532n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: executedBackfillProposalHash,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 531n,
                logIndex: 0,
            },
        ];
        runtime.executedProposalLogs = [
            {
                args: {
                    proposalHash: executedBackfillProposalHash,
                },
                blockNumber: 532n,
                logIndex: 0,
            },
        ];
        runtime.deletedProposalLogs = [];
        setTradeIntentStatePathForTest(stateFilePath);
        const noReplacementAfterExecutedBackfill = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noReplacementAfterExecutedBackfill, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-executed-proposal`];
        assert.equal(storedIntent.reimbursementProposalHash, executedBackfillProposalHash.toLowerCase());
        assert.equal(typeof storedIntent.reimbursedAtMs, 'number');
        assert.equal(storedIntent.reimbursementSubmittedAtMs, undefined);

        await resetTradeIntentState();
        runtime.latestBlock = 533n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        const executedBackfillProposalHashA = `0x${'7'.repeat(64)}`;
        const executedBackfillProposalHashB = `0x${'8'.repeat(64)}`;
        const duplicateExecutedBackfillSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-backfilled-duplicate-executed',
        });
        const duplicateExecutedBackfillArchiveCalls = await getDeterministicToolCalls({
            signals: [duplicateExecutedBackfillSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(duplicateExecutedBackfillArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-backfilled-duplicate-executed',
                uri: 'ipfs://bafyintent-backfilled-duplicate-executed',
            },
            config: buildModuleConfig(),
        });
        const duplicateExecutedBackfillOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(duplicateExecutedBackfillOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                    },
                },
            },
            config: buildModuleConfig(),
        });
        const duplicateExecutedBackfillDepositCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(duplicateExecutedBackfillDepositCalls.length, 1);
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const duplicateExecutedBackfillProposalCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(duplicateExecutedBackfillProposalCalls.length, 1);
        assert.equal(duplicateExecutedBackfillProposalCalls[0].name, 'post_bond_and_propose');
        state = getTradeIntentState();
        storedIntent =
            state.intents[
                `${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-duplicate-executed`
            ];
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: executedBackfillProposalHashA,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 534n,
                logIndex: 0,
            },
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: executedBackfillProposalHashB,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000001312d00',
                            },
                        ],
                    },
                },
                blockNumber: 534n,
                logIndex: 1,
            },
        ];
        runtime.executedProposalLogs = [
            {
                args: {
                    proposalHash: executedBackfillProposalHashA,
                },
                blockNumber: 535n,
                logIndex: 0,
            },
            {
                args: {
                    proposalHash: executedBackfillProposalHashB,
                },
                blockNumber: 535n,
                logIndex: 1,
            },
        ];
        runtime.deletedProposalLogs = [];
        runtime.latestBlock = 535n;
        const noReplacementAfterDuplicateExecutedBackfill = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noReplacementAfterDuplicateExecutedBackfill, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[
                `${TEST_SIGNER.toLowerCase()}:pm-intent-backfilled-duplicate-executed`
            ];
        assert.equal(typeof storedIntent.reimbursedAtMs, 'number');
        assert.equal(
            [executedBackfillProposalHashA.toLowerCase(), executedBackfillProposalHashB.toLowerCase()].includes(
                storedIntent.reimbursementProposalHash
            ),
            true
        );

        await resetTradeIntentState();
        runtime.latestBlock = 500n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        runtime.orderPayload = {
            order: {
                id: TEST_REJECTED_ORDER_ID,
                status: 'REJECTED',
                original_size: '25',
                size_matched: '0',
                maker_amount_filled: '0',
            },
        };
        runtime.tradesPayload = [];
        runtime.ctfBalances = {};
        runtime.orderFetchError = null;
        runtime.tradesFetchError = null;
        const rejectedSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-rejected',
        });
        const rejectedArchiveCalls = await getDeterministicToolCalls({
            signals: [rejectedSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(rejectedArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-rejected',
                uri: 'ipfs://bafyintent-rejected',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const rejectedOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(rejectedOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_REJECTED_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        runtime.tradesFetchError = 'trade api unavailable';
        const rejectedFollowupCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(rejectedFollowupCalls, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-rejected`];
        assert.equal(typeof storedIntent.closedAtMs, 'number');
        assert.equal(typeof storedIntent.creditReleasedAtMs, 'number');
        assert.equal(storedIntent.terminalFailureStatus, 'REJECTED');
        runtime.tradesFetchError = null;

        await resetTradeIntentState();
        runtime.latestBlock = 600n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: 'order-filled-no-trades',
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
                taker_amount_filled: '62500000',
            },
        };
        runtime.tradesPayload = [];
        runtime.ctfBalances = {};
        runtime.orderFetchError = null;
        runtime.tradesFetchError = null;
        const noTradesSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-filled-no-trades',
        });
        const noTradesArchiveCalls = await getDeterministicToolCalls({
            signals: [noTradesSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(noTradesArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-no-trades',
                uri: 'ipfs://bafyintent-no-trades',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const noTradesOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(noTradesOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: 'order-filled-no-trades',
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        runtime.ctfBalances[`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`] = 100_000_000n;
        const noTradesFollowupCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(noTradesFollowupCalls.length, 1);
        assert.equal(noTradesFollowupCalls[0].name, 'make_erc1155_deposit');
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-filled-no-trades`];
        assert.equal(storedIntent.orderFilled, true);
        assert.equal(storedIntent.reimbursementAmountWei, '20000000');
        assert.equal(storedIntent.filledShareAmount, '62500000');
        assert.equal(storedIntent.orderSettlementEvidence, 'token_balance');

        await resetTradeIntentState();
        runtime.latestBlock = 700n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: 'order-deposit-failure',
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-deposit-failure',
                status: 'CONFIRMED',
                taker_order_id: 'order-deposit-failure',
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.orderFetchError = null;
        runtime.tradesFetchError = null;
        const depositFailureSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-deposit-failure',
        });
        const depositFailureArchiveCalls = await getDeterministicToolCalls({
            signals: [depositFailureSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositFailureArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-deposit-failure',
                uri: 'ipfs://bafyintent-deposit-failure',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const depositFailureOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositFailureOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: 'order-deposit-failure',
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        const depositFailureCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(depositFailureCalls.length, 1);
        assert.equal(depositFailureCalls[0].name, 'make_erc1155_deposit');
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'error',
                message: 'erc1155 receiver rejected transfer',
                retryable: false,
            },
            config: buildModuleConfig(),
        });
        const noRetryAfterDeterministicDepositFailure = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRetryAfterDeterministicDepositFailure, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-failure`];
        assert.equal(typeof storedIntent.closedAtMs, 'number');
        assert.equal(storedIntent.terminalFailureStage, 'deposit');
        assert.equal(storedIntent.terminalFailureStatus, 'error');

        await resetTradeIntentState();
        runtime.latestBlock = 800n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: 'order-deposit-timeout',
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-deposit-timeout',
                status: 'CONFIRMED',
                taker_order_id: 'order-deposit-timeout',
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.receipts = {};
        const depositTimeoutNow = Date.now;
        try {
            const baseNowMs = 1_920_000_000_000;
            Date.now = () => baseNowMs;
            const depositTimeoutConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            });
            const depositTimeoutSignal = buildSignedMessageSignal({
                requestId: 'pm-intent-deposit-timeout',
                receivedAtMs: baseNowMs,
                signedAtMs: baseNowMs,
                deadline: baseNowMs + 60_000,
            });
            const depositTimeoutArchiveCalls = await getDeterministicToolCalls({
                signals: [depositTimeoutSignal],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: depositTimeoutConfig,
            });
            assert.equal(depositTimeoutArchiveCalls.length, 1);
            await onToolOutput({
                name: 'ipfs_publish',
                parsedOutput: {
                    status: 'published',
                    cid: 'bafyintent-deposit-timeout',
                    uri: 'ipfs://bafyintent-deposit-timeout',
                    pinned: true,
                },
                config: depositTimeoutConfig,
            });
            const depositTimeoutOrderCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: depositTimeoutConfig,
            });
            assert.equal(depositTimeoutOrderCalls.length, 1);
            await onToolOutput({
                name: 'polymarket_clob_build_sign_and_place_order',
                parsedOutput: {
                    status: 'submitted',
                    result: {
                        order: {
                            id: 'order-deposit-timeout',
                            status: 'LIVE',
                        },
                    },
                },
                config: depositTimeoutConfig,
            });
            const depositTimeoutCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: depositTimeoutConfig,
            });
            assert.equal(depositTimeoutCalls.length, 1);
            assert.equal(depositTimeoutCalls[0].name, 'make_erc1155_deposit');
            await onToolOutput({
                name: 'make_erc1155_deposit',
                parsedOutput: {
                    status: 'submitted',
                    transactionHash: TEST_DEPOSIT_TX_HASH,
                    pendingConfirmation: true,
                },
                config: depositTimeoutConfig,
            });

            Date.now = () => baseNowMs + 2_000;
            const noRetryAfterDepositReceiptTimeout = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: depositTimeoutConfig,
            });
            assert.deepEqual(noRetryAfterDepositReceiptTimeout, []);
            state = getTradeIntentState();
            storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-timeout`];
            assert.equal(storedIntent.depositTxHash, TEST_DEPOSIT_TX_HASH.toLowerCase());
            assert.equal(typeof storedIntent.depositSubmittedAtMs, 'number');
            assert.equal(storedIntent.depositSubmissionAmbiguous, true);
            assert.equal(typeof storedIntent.depositSubmissionAmbiguousAtMs, 'number');
            assert.equal(storedIntent.tokenDeposited, undefined);

            const postDepositAmbiguityArchiveCalls = await getDeterministicToolCalls({
                signals: [
                    buildSignedMessageSignal({
                        requestId: 'pm-intent-after-deposit-ambiguity',
                        receivedAtMs: baseNowMs + 2_000,
                        signedAtMs: baseNowMs + 2_000,
                        deadline: baseNowMs + 62_000,
                    }),
                ],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: depositTimeoutConfig,
            });
            assert.equal(postDepositAmbiguityArchiveCalls.length, 1);
            assert.equal(postDepositAmbiguityArchiveCalls[0].name, 'ipfs_publish');
        } finally {
            Date.now = depositTimeoutNow;
        }

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 540n;
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 1_000_000n,
        };
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-missing-hash`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-missing-hash`,
                    requestId: 'pm-intent-deposit-missing-hash',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    side: 'BUY',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '20000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '1000000',
                    artifactCid: 'bafy-deposit-missing-hash',
                    artifactUri: 'ipfs://bafy-deposit-missing-hash',
                    orderId: 'order-deposit-missing-hash',
                    orderFilled: true,
                    orderFilledAtMs: 1_920_000_000_000,
                    orderDispatchBlockNumber: '500',
                    tradingWalletAddress: TEST_AGENT.toLowerCase(),
                    preOrderTokenHolderAddress: TEST_AGENT.toLowerCase(),
                    depositExpectedAmount: '1000000',
                    createdAtMs: 1_920_000_000_000,
                    updatedAtMs: 1_920_000_000_000,
                },
            },
        });
        const depositMissingHashConfig = buildModuleConfig({
            statePath: stateFilePath,
        });
        const depositMissingHashCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: depositMissingHashConfig,
        });
        assert.equal(depositMissingHashCalls.length, 1);
        assert.equal(depositMissingHashCalls[0].name, 'make_erc1155_deposit');
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'submitted',
            },
            config: depositMissingHashConfig,
        });
        const noRetryAfterMissingDepositHash = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: depositMissingHashConfig,
        });
        assert.deepEqual(noRetryAfterMissingDepositHash, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-missing-hash`];
        assert.equal(storedIntent.depositTxHash, undefined);
        assert.equal(typeof storedIntent.depositSubmittedAtMs, 'number');
        assert.equal(storedIntent.depositSubmissionAmbiguous, true);
        assert.equal(storedIntent.lastDepositStatus, 'missing_tx_hash');
        assert.match(storedIntent.lastDepositError, /without a transaction hash/i);

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 541n;
        runtime.depositLogs = [];
        runtime.receipts = {};
        runtime.receiptErrors = {
            [TEST_DEPOSIT_TX_HASH.toLowerCase()]: 'deposit receipt RPC unavailable',
        };
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-generic-receipt-error`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-generic-receipt-error`,
                    requestId: 'pm-intent-deposit-generic-receipt-error',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: '20000000',
                    filledShareAmount: '62500000',
                    orderFilled: true,
                    artifactCid: 'bafy-deposit-generic-receipt-error',
                    depositTxHash: TEST_DEPOSIT_TX_HASH.toLowerCase(),
                    depositSubmittedAtMs: 1_920_000_000_000,
                    createdAtMs: 1_920_000_000_000,
                    updatedAtMs: 1_920_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '541',
            backfilledReimbursementCommitmentsThroughBlock: '541',
        });
        const genericDepositReceiptTimeoutNow = Date.now;
        try {
            Date.now = () => 1_920_000_002_000;
            const genericDepositReceiptConfig = buildModuleConfig({
                agentConfig: {
                    polymarketIntentTrader: {
                        pendingTxTimeoutMs: 1_000,
                    },
                },
            });
            const genericDepositReceiptCalls = await getDeterministicToolCalls({
                signals: [],
                commitmentSafe: TEST_SAFE,
                agentAddress: TEST_AGENT,
                publicClient,
                config: genericDepositReceiptConfig,
            });
            assert.deepEqual(genericDepositReceiptCalls, []);
            state = getTradeIntentState();
            storedIntent =
                state.intents[
                    `${TEST_SIGNER.toLowerCase()}:pm-intent-deposit-generic-receipt-error`
                ];
            assert.equal(storedIntent.depositSubmissionAmbiguous, true);
            assert.equal(
                storedIntent.lastDepositReceiptError.includes('deposit receipt RPC unavailable'),
                true
            );
        } finally {
            Date.now = genericDepositReceiptTimeoutNow;
            runtime.receiptErrors = {};
        }

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 540n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: TEST_ORDER_ID,
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
                maker_amount_filled: '20000000',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-recipient-recovery',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ];
        runtime.ctfBalances = {
            [`${TEST_AGENT.toLowerCase()}:${NO_TOKEN_ID}`]: 100_000_000n,
        };
        runtime.proposedProposalLogs = [];
        runtime.executedProposalLogs = [];
        runtime.deletedProposalLogs = [];
        runtime.receipts = {};
        const wrongRecipientRequestId = 'pm-intent-recipient-recovery';
        const wrongRecipientSignal = buildSignedMessageSignal({
            requestId: wrongRecipientRequestId,
        });
        const wrongRecipientArchiveCalls = await getDeterministicToolCalls({
            signals: [wrongRecipientSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(wrongRecipientArchiveCalls.length, 1);
        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent-recipient-recovery',
                uri: 'ipfs://bafyintent-recipient-recovery',
                pinned: true,
            },
            config: buildModuleConfig(),
        });
        const wrongRecipientOrderCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(wrongRecipientOrderCalls.length, 1);
        await onToolOutput({
            name: 'polymarket_clob_build_sign_and_place_order',
            parsedOutput: {
                status: 'submitted',
                result: {
                    order: {
                        id: TEST_ORDER_ID,
                        status: 'LIVE',
                    },
                },
            },
            config: buildModuleConfig(),
        });
        await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        await onToolOutput({
            name: 'make_erc1155_deposit',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_DEPOSIT_TX_HASH,
            },
            config: buildModuleConfig(),
        });
        const wrongRecipientProposalCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(wrongRecipientProposalCalls.length, 1);
        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_REIMBURSE_TX_HASH,
            },
            config: buildModuleConfig(),
        });

        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];

        const wrongRecipientProposalSignal = {
            kind: 'proposal',
            proposalHash: `0x${'e'.repeat(64)}`,
            proposer: TEST_AGENT,
            explanation: storedIntent.reimbursementExplanation,
            transactions: [
                {
                    to: TEST_USDC,
                    operation: 0,
                    value: 0n,
                    data: buildErc20TransferCalldata(
                        TEST_OTHER_AGENT,
                        storedIntent.reimbursementAmountWei
                    ),
                },
            ],
        };
        const noRecoveryFromWrongRecipientSignal = await getDeterministicToolCalls({
            signals: [wrongRecipientProposalSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromWrongRecipientSignal, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);

        const invalidOperationProposalSignal = {
            ...wrongRecipientProposalSignal,
            proposalHash: `0x${'1'.repeat(64)}`,
            transactions: [
                {
                    to: TEST_USDC,
                    operation: 1,
                    value: 0n,
                    data: buildErc20TransferCalldata(
                        TEST_AGENT,
                        storedIntent.reimbursementAmountWei
                    ),
                },
            ],
        };
        const noRecoveryFromInvalidOperationSignal = await getDeterministicToolCalls({
            signals: [invalidOperationProposalSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromInvalidOperationSignal, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);

        const malformedProposerSignal = {
            ...wrongRecipientProposalSignal,
            proposer: 'not-an-address',
            proposalHash: `0x${'2'.repeat(64)}`,
            transactions: [
                {
                    to: TEST_USDC,
                    operation: 0,
                    value: 0n,
                    data: buildErc20TransferCalldata(
                        TEST_AGENT,
                        storedIntent.reimbursementAmountWei
                    ),
                },
            ],
        };
        const noRecoveryFromMalformedProposerSignal = await getDeterministicToolCalls({
            signals: [malformedProposerSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromMalformedProposerSignal, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);

        const missingProposerSignal = {
            kind: 'proposal',
            proposalHash: `0x${'3'.repeat(64)}`,
            explanation: storedIntent.reimbursementExplanation,
            transactions: [
                {
                    to: TEST_USDC,
                    operation: 0,
                    value: 0n,
                    data: buildErc20TransferCalldata(
                        TEST_AGENT,
                        storedIntent.reimbursementAmountWei
                    ),
                },
            ],
        };
        const noRecoveryFromMissingProposerSignal = await getDeterministicToolCalls({
            signals: [missingProposerSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromMissingProposerSignal, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);

        runtime.latestBlock = 542n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: TEST_PROPOSAL_HASH,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 1,
                                value: 0n,
                                data: buildErc20TransferCalldata(
                                    TEST_AGENT,
                                    storedIntent.reimbursementAmountWei
                                ),
                            },
                        ],
                    },
                },
                blockNumber: 541n,
                logIndex: 0,
            },
        ];
        const noRecoveryFromInvalidOperationBackfill = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromInvalidOperationBackfill, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);

        runtime.latestBlock = 543n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'4'.repeat(64)}`,
                    explanation: storedIntent.reimbursementExplanation.replace(
                        `signer=${encodeURIComponent(TEST_SIGNER.toLowerCase())}`,
                        `signer=${encodeURIComponent(TEST_OTHER_SIGNER.toLowerCase())}`
                    ),
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: buildErc20TransferCalldata(
                                    TEST_AGENT,
                                    storedIntent.reimbursementAmountWei
                                ),
                            },
                        ],
                    },
                },
                blockNumber: 543n,
                logIndex: 0,
            },
        ];
        const noRecoveryFromWrongSignerBackfill = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromWrongSignerBackfill, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        const wrongSignerCommitment = Object.values(state.reimbursementCommitments).find(
            (commitment) => commitment?.signer === TEST_OTHER_SIGNER.toLowerCase()
        );
        assert.ok(wrongSignerCommitment);
        const wrongSignerBackfillSignals = await enrichSignals([], {
            publicClient,
            config: buildModuleConfig(),
            account: { address: TEST_AGENT },
            nowMs: 1_930_000_000_000,
        });
        const wrongSignerBackfillState = wrongSignerBackfillSignals.find(
            (signal) => signal?.kind === 'polymarketTradeIntentState'
        );
        assert.ok(wrongSignerBackfillState);
        assert.ok(wrongSignerBackfillState.credits[TEST_OTHER_SIGNER.toLowerCase()]);
        assert.equal(
            wrongSignerBackfillState.credits[TEST_OTHER_SIGNER.toLowerCase()].reservedWei,
            storedIntent.reimbursementAmountWei
        );

        const noRecoveryFromDuplicateLiveProposalSignals = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'proposal',
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'5'.repeat(64)}`,
                    explanation: storedIntent.reimbursementExplanation,
                    transactions: [
                        {
                            to: TEST_USDC,
                            operation: 0,
                            value: 0n,
                            data: buildErc20TransferCalldata(
                                TEST_AGENT,
                                storedIntent.reimbursementAmountWei
                            ),
                        },
                    ],
                },
                {
                    kind: 'proposal',
                    proposer: TEST_AGENT,
                    proposalHash: `0x${'6'.repeat(64)}`,
                    explanation: storedIntent.reimbursementExplanation,
                    transactions: [
                        {
                            to: TEST_USDC,
                            operation: 0,
                            value: 0n,
                            data: buildErc20TransferCalldata(
                                TEST_AGENT,
                                storedIntent.reimbursementAmountWei
                            ),
                        },
                    ],
                },
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(noRecoveryFromDuplicateLiveProposalSignals, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, undefined);
        assert.equal(storedIntent.reimbursementSubmissionAmbiguous, true);
        assert.equal(
            storedIntent.lastReimbursementSubmissionError,
            'Multiple live reimbursement proposals matched this intent; refusing automatic proposal-hash recovery until manual reconciliation.'
        );

        const recoveredFromHashlessThenValidSignal = await getDeterministicToolCalls({
            signals: [
                {
                    kind: 'proposal',
                    proposer: TEST_AGENT,
                    explanation: storedIntent.reimbursementExplanation,
                    transactions: [
                        {
                            to: TEST_USDC,
                            operation: 0,
                            value: 0n,
                            data: buildErc20TransferCalldata(
                                TEST_AGENT,
                                storedIntent.reimbursementAmountWei
                            ),
                        },
                    ],
                },
                {
                    kind: 'proposal',
                    proposer: TEST_AGENT,
                    proposalHash: TEST_PROPOSAL_HASH,
                    explanation: storedIntent.reimbursementExplanation,
                    transactions: [
                        {
                            to: TEST_USDC,
                            operation: 0,
                            value: 0n,
                            data: buildErc20TransferCalldata(
                                TEST_AGENT,
                                storedIntent.reimbursementAmountWei
                            ),
                        },
                    ],
                },
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(recoveredFromHashlessThenValidSignal, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, TEST_PROPOSAL_HASH);

        runtime.latestBlock = 543n;
        runtime.proposedProposalLogs = [
            {
                args: {
                    proposer: TEST_AGENT,
                    proposalHash: TEST_PROPOSAL_HASH,
                    explanation: storedIntent.reimbursementExplanation,
                    proposal: {
                        transactions: [
                            {
                                to: TEST_USDC,
                                operation: 0,
                                value: 0n,
                                data: buildErc20TransferCalldata(
                                    TEST_AGENT,
                                    storedIntent.reimbursementAmountWei
                                ),
                            },
                        ],
                    },
                },
                blockNumber: 543n,
                logIndex: 0,
            },
        ];
        const recoveredFromMatchingBackfill = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(recoveredFromMatchingBackfill, []);
        state = getTradeIntentState();
        storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:${wrongRecipientRequestId}`];
        assert.equal(storedIntent.reimbursementProposalHash, TEST_PROPOSAL_HASH.toLowerCase());

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(null);
        const contextStateDir = await mkdtemp(path.join(tmpDir, 'state-context-'));
        const contextConfig = buildModuleConfig({
            agentConfig: {
                stateDir: contextStateDir,
            },
        });
        const otherContextConfig = buildModuleConfig({
            commitmentSafe: TEST_OTHER_SAFE,
            agentConfig: {
                stateDir: contextStateDir,
            },
        });
        const contextArchiveCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-state-context',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: contextConfig,
        });
        assert.equal(contextArchiveCalls.length, 1);
        const isolatedSignals = await enrichSignals([], {
            publicClient,
            config: otherContextConfig,
            account: { address: TEST_AGENT },
            nowMs: 1_930_000_000_000,
        });
        assert.equal(
            isolatedSignals.some(
                (signal) =>
                    signal?.kind === 'polymarketTradeIntent' &&
                    signal?.requestId === 'pm-intent-state-context'
            ),
            false
        );

        await resetTradeIntentState();
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-legacy-archive-signal`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-legacy-archive-signal`,
                    requestId: 'pm-intent-legacy-archive-signal',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    createdAtMs: 1_930_000_000_000,
                    updatedAtMs: 1_930_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '0',
            backfilledReimbursementCommitmentsThroughBlock: '0',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const legacyArchiveSignals = await enrichSignals([], {
            publicClient,
            config: buildModuleConfig(),
            account: { address: TEST_AGENT },
            nowMs: 1_930_000_000_000,
        });
        const legacyArchiveSignal = legacyArchiveSignals.find(
            (signal) =>
                signal?.kind === 'polymarketSignedIntentArchive' &&
                signal?.requestId === 'pm-intent-legacy-archive-signal'
        );
        assert.ok(legacyArchiveSignal);
        assert.equal(legacyArchiveSignal.archiveArtifact, null);
        assert.equal(
            legacyArchiveSignal.archiveArtifactError.includes(
                'buildSignedTradeIntentArchiveArtifact requires a parsed signed intent record'
            ),
            true
        );

        await resetTradeIntentState();
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                'bad-signer-intent': {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: 'bad-signer-intent',
                    requestId: 'bad-signer-intent',
                    signer: 'not-an-address',
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    createdAtMs: 1_930_000_000_000,
                    updatedAtMs: 1_930_000_000_000,
                },
                [`${TEST_SIGNER.toLowerCase()}:valid-credit-snapshot-intent`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 2,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:valid-credit-snapshot-intent`,
                    requestId: 'valid-credit-snapshot-intent',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    createdAtMs: 1_930_000_000_000,
                    updatedAtMs: 1_930_000_000_000,
                },
            },
            deposits: {
                'signal:bad-deposit': {
                    depositKey: 'signal:bad-deposit',
                    depositor: 'also-not-an-address',
                    amountWei: 'not-a-number',
                    createdAtMs: 1_930_000_000_000,
                },
                'signal:valid-deposit': {
                    depositKey: 'signal:valid-deposit',
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    createdAtMs: 1_930_000_000_000,
                },
            },
            reimbursementCommitments: {
                'proposal:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
                    commitmentKey:
                        'proposal:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    proposalHash: `0x${'a'.repeat(64)}`,
                    signer: 'bad-commitment-signer',
                    recipientAddress: TEST_AGENT.toLowerCase(),
                    amountWei: 'bad-amount',
                    status: 'proposed',
                    createdAtMs: 1_930_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '0',
            backfilledReimbursementCommitmentsThroughBlock: '0',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        const malformedCreditSignals = await enrichSignals([], {
            publicClient,
            config: buildModuleConfig(),
            account: { address: TEST_AGENT },
            nowMs: 1_930_000_000_000,
        });
        const malformedCreditStateSignal = malformedCreditSignals.find(
            (signal) => signal?.kind === 'polymarketTradeIntentState'
        );
        assert.ok(malformedCreditStateSignal);
        assert.equal(
            malformedCreditStateSignal.credits[TEST_SIGNER.toLowerCase()].depositedWei,
            '50000000'
        );
        assert.equal(
            malformedCreditStateSignal.credits[TEST_SIGNER.toLowerCase()].reservedWei,
            '25000000'
        );

        await resetTradeIntentState();
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 3,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:bad-reimbursement-amount-intent`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:bad-reimbursement-amount-intent`,
                    requestId: 'bad-reimbursement-amount-intent',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    reimbursementAmountWei: 'not-a-number',
                    orderFilled: true,
                    tokenDeposited: true,
                    artifactCid: 'bafy-bad-reimbursement',
                    createdAtMs: 1_930_000_000_000,
                    updatedAtMs: 1_930_000_000_000,
                },
            },
            deposits: {
                'signal:valid-deposit': {
                    depositKey: 'signal:valid-deposit',
                    depositor: TEST_SIGNER.toLowerCase(),
                    amountWei: '50000000',
                    createdAtMs: 1_930_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '0',
            backfilledReimbursementCommitmentsThroughBlock: '0',
        });
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.safeCollateralBalance = 50_000_000n;
        const malformedPersistedAmountCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-after-bad-reimbursement-amount',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(malformedPersistedAmountCalls.length, 1);
        assert.equal(malformedPersistedAmountCalls[0].name, 'ipfs_publish');

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        const scopeArchiveCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-scope-mismatch',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(scopeArchiveCalls.length, 1);
        setTradeIntentStatePathForTest(stateFilePath);
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [],
                    commitmentSafe: TEST_SAFE,
                    agentAddress: TEST_AGENT,
                    publicClient,
                    config: buildModuleConfig({
                        agentConfig: {
                            polymarketIntentTrader: {
                                marketId: 'market-999',
                            },
                        },
                    }),
                }),
            /state scope/i
        );

        await resetTradeIntentState();
        const walletMismatchStateDir = await mkdtemp(path.join(tmpDir, 'wallet-mismatch-'));
        const walletMismatchStatePath = path.join(
            walletMismatchStateDir,
            '.trade-intent-state.json'
        );
        setTradeIntentStatePathForTest(walletMismatchStatePath);
        runtime.latestBlock = 550n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        const walletMismatchConfig = buildModuleConfig({
            polymarketClobAddress: TEST_OTHER_AGENT,
        });
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [
                        buildSignedMessageSignal({
                            requestId: 'pm-intent-wallet-mismatch-persist',
                        }),
                    ],
                    commitmentSafe: TEST_SAFE,
                    agentAddress: TEST_AGENT,
                    publicClient,
                    config: walletMismatchConfig,
                }),
            /must match runtime signer address/i
        );
        setTradeIntentStatePathForTest(walletMismatchStatePath);
        const recoveredAfterWalletMismatchCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(recoveredAfterWalletMismatchCalls.length, 1);
        assert.equal(recoveredAfterWalletMismatchCalls[0].name, 'ipfs_publish');

        await resetTradeIntentState();
        const blockNumberFailureStateDir = await mkdtemp(path.join(tmpDir, 'block-number-failure-'));
        const blockNumberFailureStatePath = path.join(
            blockNumberFailureStateDir,
            '.trade-intent-state.json'
        );
        setTradeIntentStatePathForTest(blockNumberFailureStatePath);
        runtime.latestBlock = 555n;
        runtime.blockNumberError = 'latest block RPC unavailable';
        await assert.rejects(
            () =>
                getDeterministicToolCalls({
                    signals: [
                        {
                            kind: 'erc20Deposit',
                            asset: TEST_USDC,
                            from: TEST_SIGNER,
                            amount: '50000000',
                            transactionHash: `0x${'1'.repeat(64)}`,
                            logIndex: 0,
                            blockNumber: 11n,
                            id: 'signal:block-number-failure-deposit',
                        },
                        buildSignedMessageSignal({
                            requestId: 'pm-intent-block-number-failure-persist',
                        }),
                    ],
                    commitmentSafe: TEST_SAFE,
                    agentAddress: TEST_AGENT,
                    publicClient,
                    config: buildModuleConfig(),
                }),
            /latest block RPC unavailable/i
        );
        runtime.blockNumberError = null;
        setTradeIntentStatePathForTest(blockNumberFailureStatePath);
        const recoveredAfterBlockNumberFailureCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.equal(recoveredAfterBlockNumberFailureCalls.length, 1);
        assert.equal(recoveredAfterBlockNumberFailureCalls[0].name, 'ipfs_publish');

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 560n;
        runtime.depositLogs = [
            {
                args: {
                    from: TEST_SIGNER,
                    value: 50_000_000n,
                },
                blockNumber: 10n,
                transactionHash: `0x${'d'.repeat(64)}`,
                logIndex: 0,
            },
        ];
        runtime.orderPayload = {
            order: {
                id: 'order-bad-settlement-refresh',
                status: 'MATCHED',
                original_size: '25',
                size_matched: '25',
            },
        };
        runtime.tradesPayload = [
            {
                id: 'trade-bad-settlement-refresh',
                status: 'CONFIRMED',
                taker_order_id: 'order-bad-settlement-refresh',
                price: '0.42',
            },
        ];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 2,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-bad-settlement-refresh`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-bad-settlement-refresh`,
                    requestId: 'pm-intent-bad-settlement-refresh',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    artifactCid: 'bafy-bad-settlement-refresh',
                    orderId: 'order-bad-settlement-refresh',
                    orderSubmittedAtMs: 1_930_000_000_000,
                    createdAtMs: 1_930_000_000_000,
                    updatedAtMs: 1_930_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '0',
            backfilledReimbursementCommitmentsThroughBlock: '560',
        });
        const malformedSettlementCalls = await getDeterministicToolCalls({
            signals: [
                buildSignedMessageSignal({
                    requestId: 'pm-intent-after-bad-settlement-refresh',
                }),
            ],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(malformedSettlementCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-bad-settlement-refresh`];
        assert.equal(
            storedIntent.lastOrderStatusRefreshError,
            'Unable to determine actual USDC spent for filled Polymarket BUY order order-bad-settlement-refresh.'
        );
        assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');
        assert.ok(
            state.intents[
                `${TEST_SIGNER.toLowerCase()}:pm-intent-after-bad-settlement-refresh`
            ]
        );

        await resetTradeIntentState();
        setTradeIntentStatePathForTest(stateFilePath);
        runtime.latestBlock = 561n;
        runtime.orderPayload = {
            malformed: true,
        };
        runtime.tradesPayload = [];
        await writeTradeIntentStateFixture(stateFilePath, {
            nextSequence: 1,
            intents: {
                [`${TEST_SIGNER.toLowerCase()}:pm-intent-bad-order-payload-refresh`]: {
                    sourceKind: 'signed_trade_intent',
                    sequence: 1,
                    intentKey: `${TEST_SIGNER.toLowerCase()}:pm-intent-bad-order-payload-refresh`,
                    requestId: 'pm-intent-bad-order-payload-refresh',
                    signer: TEST_SIGNER.toLowerCase(),
                    tokenId: NO_TOKEN_ID,
                    outcome: 'NO',
                    marketId: 'market-123',
                    maxSpendWei: '25000000',
                    reservedCreditAmountWei: '25000000',
                    artifactCid: 'bafy-bad-order-payload-refresh',
                    orderId: 'order-bad-order-payload-refresh',
                    orderSubmittedAtMs: 1_700_000_000_000,
                    createdAtMs: 1_700_000_000_000,
                    updatedAtMs: 1_700_000_000_000,
                },
            },
            backfilledDepositsThroughBlock: '0',
            backfilledReimbursementCommitmentsThroughBlock: '561',
        });
        const malformedOrderPayloadCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(malformedOrderPayloadCalls, []);
        state = getTradeIntentState();
        storedIntent =
            state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-bad-order-payload-refresh`];
        assert.equal(
            storedIntent.lastOrderStatusRefreshError,
            'Unable to parse Polymarket order status payload for submitted order order-bad-order-payload-refresh; refusing automatic retry until reconciled.'
        );
        assert.equal(typeof storedIntent.orderStatusRefreshFailedAtMs, 'number');

        console.log('[test] polymarket-intent-trader lifecycle OK');
    } finally {
        globalThis.fetch = originalFetch;
        await resetTradeIntentState();
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
