import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
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
const TEST_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const TEST_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const YES_TOKEN_ID = '101';
const NO_TOKEN_ID = '202';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;
const TEST_PROPOSAL_HASH = `0x${'a'.repeat(64)}`;
const TEST_ORDER_ID = 'order-1';
const TEST_TIMEOUT_ORDER_ID = 'order-timeout';
const TEST_DEPOSIT_TX_HASH = `0x${'b'.repeat(64)}`;
const TEST_REIMBURSE_TX_HASH = `0x${'c'.repeat(64)}`;

function buildModuleConfig(overrides = {}) {
    const baseAgentConfig = {
        polymarketIntentTrader: {
            authorizedAgent: TEST_AGENT,
            marketId: 'market-123',
            yesTokenId: YES_TOKEN_ID,
            noTokenId: NO_TOKEN_ID,
            collateralToken: TEST_USDC,
            ctfContract: TEST_CTF,
        },
    };
    const overrideAgentConfig = overrides.agentConfig ?? {};
    return {
        commitmentSafe: TEST_SAFE,
        ogModule: '0x4444444444444444444444444444444444444444',
        startBlock: 0,
        ipfsEnabled: true,
        proposeEnabled: true,
        polymarketClobEnabled: true,
        polymarketClobApiKey: 'k_test',
        polymarketClobApiSecret: 's_test',
        polymarketClobApiPassphrase: 'p_test',
        polymarketClobAddress: TEST_AGENT,
        watchAssets: [TEST_USDC],
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

function buildSignedMessageSignal(overrides = {}) {
    const requestId = overrides.requestId ?? 'pm-intent-001';
    const receivedAtMs = overrides.receivedAtMs ?? 1_800_000_000_000;
    const deadline = overrides.deadline ?? receivedAtMs + 60_000;

    return {
        kind: 'userMessage',
        messageId: overrides.messageId ?? `msg_${requestId}`,
        requestId,
        text:
            overrides.text ??
            'Buy NO for up to 25 USDC if the price is 0.42 or better before 6pm UTC.',
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
            return 137;
        },
        async getBlockNumber() {
            return runtime.latestBlock;
        },
        async getCode({ address }) {
            return String(address).toLowerCase() === TEST_SAFE.toLowerCase() ? '0x1' : '0x';
        },
        async getLogs({ address, args, fromBlock, toBlock }) {
            if (String(address).toLowerCase() !== TEST_USDC.toLowerCase()) {
                return [];
            }
            if (String(args?.to ?? '').toLowerCase() !== TEST_SAFE.toLowerCase()) {
                return [];
            }
            const normalizedFromBlock = BigInt(fromBlock ?? 0n);
            const normalizedToBlock = BigInt(toBlock ?? runtime.latestBlock);
            return runtime.depositLogs.filter((log) => {
                const blockNumber = BigInt(log.blockNumber ?? 0n);
                return (
                    blockNumber >= normalizedFromBlock &&
                    blockNumber <= normalizedToBlock
                );
            });
        },
        async readContract({ address, functionName, args }) {
            if (
                String(address).toLowerCase() === TEST_CTF.toLowerCase() &&
                functionName === 'balanceOf'
            ) {
                const owner = String(args?.[0] ?? '').toLowerCase();
                const tokenId = BigInt(args?.[1] ?? 0n).toString();
                return BigInt(runtime.ctfBalances[`${owner}:${tokenId}`] ?? 0n);
            }
            throw new Error(
                `Unexpected readContract call: address=${address} functionName=${functionName}`
            );
        },
        async getTransactionReceipt({ hash }) {
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
    setTradeIntentStatePathForTest(path.join(tmpDir, '.trade-intent-state.json'));

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
            },
        },
        tradesPayload: [
            {
                id: 'trade-1',
                status: 'CONFIRMED',
                taker_order_id: TEST_ORDER_ID,
                price: '0.32',
                size: '62.5',
            },
        ],
        ctfBalances: {},
        receipts: {},
        orderFetchError: null,
        tradesFetchError: null,
    };

    const publicClient = buildPublicClient(runtime);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/fee-rate') {
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

        runtime.latestBlock = 101n;
        runtime.depositLogs.push({
            args: {
                from: TEST_OTHER_SIGNER,
                value: 30_000_000n,
            },
            blockNumber: 101n,
            transactionHash: `0x${'e'.repeat(64)}`,
            logIndex: 0,
        });
        const incrementalBackfillCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            publicClient,
            config: buildModuleConfig(),
        });
        assert.deepEqual(incrementalBackfillCalls, []);
        state = getTradeIntentState();
        assert.equal(Object.keys(state.deposits).length, 2);

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
        assert.equal(archiveArgs.json.interpretedIntent.maxSpendWei, '25000000');

        state = getTradeIntentState();
        let storedIntent = state.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
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
        assert.equal(orderArgs.chainId, 137);
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
        assert.equal(depositArgs.amount, '62500000');
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
        assert.equal(storedIntent.filledShareAmount, '62500000');
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
        assert.equal(typeof storedIntent.orderSubmittedAtMs, 'number');

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
