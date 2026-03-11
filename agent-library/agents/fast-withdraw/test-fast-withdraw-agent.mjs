import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    buildSignedRequestArchiveArtifact,
    decodeRequestIdFromFilename,
    enrichSignals,
    getRequestArchiveState,
    getSystemPrompt,
    onToolOutput,
    resetRequestArchiveState,
    setRequestArchiveStatePathForTest,
    validateToolCalls,
} from './agent.js';

const TEST_SIGNER = '0x1111111111111111111111111111111111111111';
const TEST_SAFE = '0x2222222222222222222222222222222222222222';
const TEST_AGENT = '0x3333333333333333333333333333333333333333';
const TEST_RECIPIENT = '0x4444444444444444444444444444444444444444';
const TEST_USDC = '0x5555555555555555555555555555555555555555';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;
const TEST_FILL_TX_HASH = `0x${'b'.repeat(64)}`;
const TEST_PROPOSAL_TX_HASH = `0x${'c'.repeat(64)}`;
const TEST_OG_PROPOSAL_HASH = `0x${'d'.repeat(64)}`;
const TEST_AMOUNT_WEI = '10000000';

function buildSignedMessageSignal() {
    return {
        kind: 'userMessage',
        messageId: 'msg_fast_1',
        requestId: 'withdrawal-request-001',
        text: `Please withdraw 10 USDC to ${TEST_RECIPIENT}.`,
        command: 'withdraw',
        args: {
            asset: 'USDC',
            amount: '10',
            recipient: TEST_RECIPIENT,
        },
        metadata: {
            source: 'test-suite',
        },
        deadline: 1_900_000_000_000,
        receivedAtMs: 1_800_000_000_000,
        expiresAtMs: 1_900_000_000_000,
        sender: {
            authType: 'eip191',
            address: TEST_SIGNER,
            signature: TEST_SIGNATURE,
            signedAtMs: 1_800_000_000_000,
        },
    };
}

function buildPublicClient() {
    return {
        async readContract({ address, functionName, args }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress !== TEST_USDC.toLowerCase()) {
                throw new Error(`Unexpected token address: ${address}`);
            }
            if (functionName === 'symbol') {
                return 'USDC';
            }
            if (functionName === 'decimals') {
                return 6;
            }
            if (functionName === 'balanceOf') {
                const owner = String(args?.[0] ?? '').toLowerCase();
                if (owner === TEST_SAFE.toLowerCase()) {
                    return 50_000_000n;
                }
                if (owner === TEST_AGENT.toLowerCase()) {
                    return 20_000_000n;
                }
                return 0n;
            }
            throw new Error(`Unexpected functionName: ${functionName}`);
        },
        async getBalance() {
            return 0n;
        },
        async getTransactionReceipt({ hash }) {
            if (String(hash).toLowerCase() !== TEST_FILL_TX_HASH.toLowerCase()) {
                throw new Error(`Unexpected tx hash: ${hash}`);
            }
            return {
                blockNumber: 100n,
            };
        },
    };
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fast-withdraw-agent-'));
    setRequestArchiveStatePathForTest(path.join(tmpDir, '.request-archive-state.json'));

    try {
        await resetRequestArchiveState();

        const prompt = getSystemPrompt({
            proposeEnabled: true,
            disputeEnabled: true,
            commitmentText: 'Fast withdraw commitment.',
        });
        assert.ok(prompt.includes('fast-withdraw commitment agent'));
        assert.ok(prompt.includes('Only use assets that appear in fastWithdrawAsset signals'));
        assert.ok(prompt.includes('make_transfer'));
        assert.ok(prompt.includes('post_bond_and_propose directly'));

        const signal = buildSignedMessageSignal();
        const artifact = buildSignedRequestArchiveArtifact({
            message: signal,
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
        });
        assert.equal(artifact.requestId, signal.requestId);
        assert.equal(artifact.signedRequest.signer, TEST_SIGNER);
        assert.equal(
            artifact.signedRequest.canonicalMessage,
            buildSignedMessagePayload({
                address: TEST_SIGNER,
                timestampMs: signal.sender.signedAtMs,
                text: signal.text,
                command: signal.command,
                args: signal.args,
                metadata: signal.metadata,
                requestId: signal.requestId,
                deadline: signal.deadline,
            })
        );

        const publicClient = buildPublicClient();
        const baseConfig = {
            commitmentSafe: TEST_SAFE,
            watchAssets: [TEST_USDC],
            watchNativeBalance: false,
        };

        const initialSignals = await enrichSignals([signal], {
            publicClient,
            config: baseConfig,
            account: {
                address: TEST_AGENT,
            },
            nowMs: signal.receivedAtMs,
            latestBlock: 100n,
        });

        const archiveSignal = initialSignals.find((entry) => entry.kind === 'signedRequestArchive');
        assert.ok(archiveSignal);
        assert.equal(archiveSignal.archived, false);
        assert.equal(
            decodeRequestIdFromFilename(archiveSignal.archiveFilename),
            signal.requestId
        );

        const assetSignal = initialSignals.find((entry) => entry.kind === 'fastWithdrawAsset');
        assert.ok(assetSignal);
        assert.equal(assetSignal.symbol, 'USDC');
        assert.equal(assetSignal.decimals, 6);
        assert.equal(assetSignal.agentBalance, 20_000_000n);

        const validatedArchiveAndFill = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'archive-request',
                    name: 'ipfs_publish',
                    arguments: JSON.stringify({
                        json: archiveSignal.archiveArtifact,
                        filename: archiveSignal.archiveFilename,
                        pin: false,
                    }),
                },
                {
                    callId: 'direct-fill',
                    name: 'make_transfer',
                    arguments: JSON.stringify({
                        asset: TEST_USDC,
                        recipient: TEST_RECIPIENT,
                        amountWei: TEST_AMOUNT_WEI,
                    }),
                },
            ],
            signals: initialSignals,
            config: {
                ...baseConfig,
                ipfsEnabled: true,
            },
            agentAddress: TEST_AGENT,
        });
        assert.equal(validatedArchiveAndFill.length, 2);
        assert.equal(validatedArchiveAndFill[0].name, 'ipfs_publish');
        assert.equal(validatedArchiveAndFill[1].name, 'make_transfer');
        assert.equal(validatedArchiveAndFill[0].parsedArguments.pin, true);
        assert.equal(validatedArchiveAndFill[1].parsedArguments.asset, TEST_USDC);
        assert.equal(validatedArchiveAndFill[1].parsedArguments.recipient, TEST_RECIPIENT);
        assert.equal(validatedArchiveAndFill[1].parsedArguments.amountWei, TEST_AMOUNT_WEI);

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyfastwithdrawcid',
                uri: 'ipfs://bafyfastwithdrawcid',
                pinned: true,
                publishResult: {
                    Name: archiveSignal.archiveFilename,
                },
            },
        });

        await onToolOutput({
            name: 'make_transfer',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_FILL_TX_HASH,
            },
        });

        const archivedAndFilledState = await getRequestArchiveState();
        assert.equal(
            archivedAndFilledState.requests[signal.requestId].artifactCid,
            'bafyfastwithdrawcid'
        );
        assert.equal(
            archivedAndFilledState.requests[signal.requestId].directFillTxHash,
            TEST_FILL_TX_HASH
        );
        assert.equal(
            archivedAndFilledState.requests[signal.requestId].directFillAsset,
            TEST_USDC
        );
        assert.equal(
            archivedAndFilledState.requests[signal.requestId].directFillRecipient,
            TEST_RECIPIENT
        );
        assert.equal(
            archivedAndFilledState.requests[signal.requestId].directFillAmountWei,
            TEST_AMOUNT_WEI
        );

        const notYetConfirmedSignals = await enrichSignals(
            [
                {
                    kind: 'erc20BalanceSnapshot',
                    asset: TEST_USDC,
                    amount: 50_000_000n,
                    blockNumber: 100n,
                },
            ],
            {
                publicClient,
                config: baseConfig,
                account: {
                    address: TEST_AGENT,
                },
                nowMs: signal.receivedAtMs + 10_000,
                latestBlock: 100n,
            }
        );

        await assert.rejects(
            () =>
                validateToolCalls({
                    toolCalls: [
                        {
                            callId: 'too-early-reimburse',
                            name: 'post_bond_and_propose',
                            arguments: JSON.stringify({
                                transactions: [],
                                explanation: '',
                            }),
                        },
                    ],
                    signals: notYetConfirmedSignals,
                    config: {
                        ...baseConfig,
                        ipfsEnabled: true,
                    },
                    agentAddress: TEST_AGENT,
                }),
            /No fast-withdraw request is eligible/
        );

        const followupSignals = await enrichSignals(
            [
                {
                    kind: 'erc20BalanceSnapshot',
                    asset: TEST_USDC,
                    amount: 50_000_000n,
                    blockNumber: 102n,
                },
            ],
            {
                publicClient,
                config: baseConfig,
                account: {
                    address: TEST_AGENT,
                },
                nowMs: signal.receivedAtMs + 30_000,
                latestBlock: 102n,
            }
        );

        const requestSignal = followupSignals.find((entry) => entry.kind === 'fastWithdrawRequest');
        assert.ok(requestSignal);
        assert.equal(requestSignal.status, 'fill_confirmed');
        assert.equal(requestSignal.directFillConfirmations, 3);
        assert.equal(requestSignal.eligibleForReimbursement, true);
        assert.ok(Array.isArray(requestSignal.expectedReimbursementTransactions));
        assert.equal(requestSignal.expectedReimbursementTransactions.length, 1);
        assert.equal(
            requestSignal.expectedReimbursementExplanation,
            JSON.stringify({
                version: 'oya-fast-withdraw-reimbursement-v1',
                requestId: signal.requestId,
                signedRequestCid: 'ipfs://bafyfastwithdrawcid',
                fillTxHash: TEST_FILL_TX_HASH,
            })
        );

        const validatedProposal = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'reimburse',
                    name: 'post_bond_and_propose',
                    arguments: JSON.stringify({
                        transactions: [],
                        explanation: requestSignal.expectedReimbursementExplanation,
                    }),
                },
            ],
            signals: followupSignals,
            config: {
                ...baseConfig,
                ipfsEnabled: true,
            },
            agentAddress: TEST_AGENT,
        });
        assert.equal(validatedProposal.length, 1);
        assert.equal(validatedProposal[0].name, 'post_bond_and_propose');
        assert.equal(
            validatedProposal[0].parsedArguments.explanation,
            requestSignal.expectedReimbursementExplanation
        );
        assert.equal(validatedProposal[0].parsedArguments.transactions.length, 1);

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_PROPOSAL_TX_HASH,
                ogProposalHash: TEST_OG_PROPOSAL_HASH,
            },
        });

        const reimbursedState = await getRequestArchiveState();
        assert.equal(
            reimbursedState.requests[signal.requestId].reimbursementProposalHash,
            TEST_OG_PROPOSAL_HASH
        );
        assert.equal(
            reimbursedState.requests[signal.requestId].reimbursementSubmissionTxHash,
            TEST_PROPOSAL_TX_HASH
        );
        assert.equal(
            reimbursedState.requests[signal.requestId].reimbursementExplanation,
            requestSignal.expectedReimbursementExplanation
        );

        console.log('[test] fast-withdraw agent OK');
    } finally {
        await resetRequestArchiveState();
        setRequestArchiveStatePathForTest(null);
    }
}

run().catch((error) => {
    console.error('[test] fast-withdraw agent failed:', error?.message ?? error);
    process.exit(1);
});
