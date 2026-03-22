import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { decodeFunctionData, erc1155Abi } from 'viem';
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
const TEST_ERC1155 = '0x6666666666666666666666666666666666666666';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;
const TEST_FILL_TX_HASH = `0x${'b'.repeat(64)}`;
const TEST_PROPOSAL_TX_HASH = `0x${'c'.repeat(64)}`;
const TEST_OG_PROPOSAL_HASH = `0x${'d'.repeat(64)}`;
const TEST_AMOUNT_WEI = '10000000';
const TEST_ERC1155_TOKEN_ID = '42';
const TEST_ERC1155_AMOUNT = '3';
const TEST_ERC1155_FILL_TX_HASH = `0x${'e'.repeat(64)}`;
const TEST_ERC1155_PROPOSAL_TX_HASH = `0x${'f'.repeat(64)}`;
const TEST_ERC1155_OG_PROPOSAL_HASH = `0x${'9'.repeat(64)}`;
const TEST_CHAIN_ID = 11155111;

function buildSignedMessageSignal(overrides = {}) {
    const requestId = overrides.requestId ?? 'withdrawal-request-001';
    const messageId = overrides.messageId ?? `msg_${requestId}`;
    return {
        kind: 'userMessage',
        chainId: overrides.chainId ?? TEST_CHAIN_ID,
        messageId,
        requestId,
        text: overrides.text ?? `Please withdraw 10 USDC to ${TEST_RECIPIENT}.`,
        command: overrides.command ?? 'withdraw',
        args: overrides.args ?? {
            asset: 'USDC',
            amount: '10',
            recipient: TEST_RECIPIENT,
        },
        metadata: overrides.metadata ?? {
            source: 'test-suite',
        },
        deadline: overrides.deadline ?? 1_900_000_000_000,
        receivedAtMs: overrides.receivedAtMs ?? 1_800_000_000_000,
        expiresAtMs: overrides.expiresAtMs ?? (overrides.deadline ?? 1_900_000_000_000),
        sender: {
            authType: 'eip191',
            address: TEST_SIGNER,
            signature: TEST_SIGNATURE,
            signedAtMs: overrides.signedAtMs ?? (overrides.receivedAtMs ?? 1_800_000_000_000),
        },
    };
}

function buildPublicClient({
    fillTxHash = TEST_FILL_TX_HASH,
    erc20SafeBalance = 50_000_000n,
    erc20AgentBalance = 20_000_000n,
    erc1155SafeBalance = 7n,
    erc1155AgentBalance = 5n,
} = {}) {
    return {
        async readContract({ address, functionName, args }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress === TEST_USDC.toLowerCase()) {
                if (functionName === 'symbol') {
                    return 'USDC';
                }
                if (functionName === 'decimals') {
                    return 6;
                }
                if (functionName === 'balanceOf') {
                    const owner = String(args?.[0] ?? '').toLowerCase();
                    if (owner === TEST_SAFE.toLowerCase()) {
                        return erc20SafeBalance;
                    }
                    if (owner === TEST_AGENT.toLowerCase()) {
                        return erc20AgentBalance;
                    }
                    return 0n;
                }
            }
            if (normalizedAddress === TEST_ERC1155.toLowerCase() && functionName === 'balanceOf') {
                const owner = String(args?.[0] ?? '').toLowerCase();
                const tokenId = String(args?.[1] ?? '');
                assert.equal(tokenId, TEST_ERC1155_TOKEN_ID);
                if (owner === TEST_SAFE.toLowerCase()) {
                    return erc1155SafeBalance;
                }
                if (owner === TEST_AGENT.toLowerCase()) {
                    return erc1155AgentBalance;
                }
                return 0n;
            }
            throw new Error(`Unexpected functionName: ${functionName}`);
        },
        async getBalance() {
            return 0n;
        },
        async getTransactionReceipt({ hash }) {
            if (String(hash).toLowerCase() !== fillTxHash.toLowerCase()) {
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
        assert.ok(prompt.includes('make_erc1155_transfer'));
        assert.ok(prompt.includes('post_bond_and_propose directly'));

        const signal = buildSignedMessageSignal();
        const artifact = buildSignedRequestArchiveArtifact({
            message: signal,
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
        });
        assert.equal(artifact.requestId, signal.requestId);
        assert.equal(artifact.signedRequest.signer, TEST_SIGNER);
        assert.equal(artifact.signedRequest.envelope.chainId, TEST_CHAIN_ID);
        assert.equal(
            artifact.signedRequest.canonicalMessage,
            buildSignedMessagePayload({
                address: TEST_SIGNER,
                chainId: signal.chainId,
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
                        json: JSON.stringify(archiveSignal.archiveArtifact),
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

        await resetRequestArchiveState();

        const erc1155Signal = buildSignedMessageSignal({
            requestId: 'withdrawal-request-erc1155-001',
            text: `Please withdraw ${TEST_ERC1155_AMOUNT} units of ERC1155 token ${TEST_ERC1155_TOKEN_ID} from collection ${TEST_ERC1155} to ${TEST_RECIPIENT}.`,
            args: {
                note: 'erc1155 withdrawal request',
            },
            receivedAtMs: 1_800_000_100_000,
            deadline: 1_900_000_100_000,
        });
        const erc1155PublicClient = buildPublicClient({
            fillTxHash: TEST_ERC1155_FILL_TX_HASH,
        });
        const erc1155Config = {
            commitmentSafe: TEST_SAFE,
            watchAssets: [],
            watchNativeBalance: false,
            watchErc1155Assets: [
                {
                    token: TEST_ERC1155,
                    tokenId: TEST_ERC1155_TOKEN_ID,
                    symbol: 'TEST-ERC1155-42',
                },
            ],
        };

        const erc1155InitialSignals = await enrichSignals([erc1155Signal], {
            publicClient: erc1155PublicClient,
            config: erc1155Config,
            account: {
                address: TEST_AGENT,
            },
            nowMs: erc1155Signal.receivedAtMs,
            latestBlock: 100n,
        });

        const erc1155ArchiveSignal = erc1155InitialSignals.find(
            (entry) => entry.kind === 'signedRequestArchive'
        );
        assert.ok(erc1155ArchiveSignal);

        const erc1155AssetSignal = erc1155InitialSignals.find(
            (entry) => entry.kind === 'fastWithdrawAsset'
        );
        assert.ok(erc1155AssetSignal);
        assert.equal(erc1155AssetSignal.assetKind, 'erc1155');
        assert.equal(erc1155AssetSignal.token, TEST_ERC1155);
        assert.equal(erc1155AssetSignal.tokenId, TEST_ERC1155_TOKEN_ID);
        assert.equal(erc1155AssetSignal.symbol, 'TEST-ERC1155-42');
        assert.equal(erc1155AssetSignal.agentBalance, 5n);

        const validatedErc1155ArchiveAndFill = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'archive-erc1155-request',
                    name: 'ipfs_publish',
                    arguments: JSON.stringify({
                        json: JSON.stringify(erc1155ArchiveSignal.archiveArtifact),
                        filename: erc1155ArchiveSignal.archiveFilename,
                    }),
                },
                {
                    callId: 'direct-erc1155-fill',
                    name: 'make_erc1155_transfer',
                    arguments: JSON.stringify({
                        token: TEST_ERC1155,
                        recipient: TEST_RECIPIENT,
                        tokenId: TEST_ERC1155_TOKEN_ID,
                        amount: TEST_ERC1155_AMOUNT,
                    }),
                },
            ],
            signals: erc1155InitialSignals,
            config: {
                ...erc1155Config,
                ipfsEnabled: true,
            },
            agentAddress: TEST_AGENT,
        });
        assert.equal(validatedErc1155ArchiveAndFill.length, 2);
        assert.equal(validatedErc1155ArchiveAndFill[1].name, 'make_erc1155_transfer');
        assert.equal(validatedErc1155ArchiveAndFill[1].parsedArguments.token, TEST_ERC1155);
        assert.equal(
            validatedErc1155ArchiveAndFill[1].parsedArguments.tokenId,
            TEST_ERC1155_TOKEN_ID
        );
        assert.equal(
            validatedErc1155ArchiveAndFill[1].parsedArguments.amount,
            TEST_ERC1155_AMOUNT
        );
        assert.equal(validatedErc1155ArchiveAndFill[1].parsedArguments.data, '0x');

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyfastwithdrawerc1155cid',
                uri: 'ipfs://bafyfastwithdrawerc1155cid',
                pinned: true,
                publishResult: {
                    Name: erc1155ArchiveSignal.archiveFilename,
                },
            },
        });

        await onToolOutput({
            name: 'make_erc1155_transfer',
            parsedOutput: {
                status: 'confirmed',
                transactionHash: TEST_ERC1155_FILL_TX_HASH,
            },
        });

        const erc1155State = await getRequestArchiveState();
        assert.equal(
            erc1155State.requests[erc1155Signal.requestId].directFillAssetKind,
            'erc1155'
        );
        assert.equal(
            erc1155State.requests[erc1155Signal.requestId].directFillToken,
            TEST_ERC1155
        );
        assert.equal(
            erc1155State.requests[erc1155Signal.requestId].directFillTokenId,
            TEST_ERC1155_TOKEN_ID
        );
        assert.equal(
            erc1155State.requests[erc1155Signal.requestId].directFillAmount,
            TEST_ERC1155_AMOUNT
        );
        assert.equal(
            erc1155State.requests[erc1155Signal.requestId].directFillAmountWei,
            null
        );

        const erc1155FollowupSignals = await enrichSignals([], {
            publicClient: erc1155PublicClient,
            config: erc1155Config,
            account: {
                address: TEST_AGENT,
            },
            nowMs: erc1155Signal.receivedAtMs + 30_000,
            latestBlock: 102n,
        });

        const erc1155RequestSignal = erc1155FollowupSignals.find(
            (entry) => entry.kind === 'fastWithdrawRequest'
        );
        assert.ok(erc1155RequestSignal);
        assert.equal(erc1155RequestSignal.status, 'fill_confirmed');
        assert.equal(erc1155RequestSignal.directFillAssetKind, 'erc1155');
        assert.equal(erc1155RequestSignal.directFillToken, TEST_ERC1155);
        assert.equal(erc1155RequestSignal.directFillTokenId, TEST_ERC1155_TOKEN_ID);
        assert.equal(erc1155RequestSignal.directFillAmount, TEST_ERC1155_AMOUNT);
        assert.equal(erc1155RequestSignal.eligibleForReimbursement, true);
        assert.ok(Array.isArray(erc1155RequestSignal.expectedReimbursementTransactions));
        assert.equal(erc1155RequestSignal.expectedReimbursementTransactions.length, 1);
        assert.equal(
            erc1155RequestSignal.expectedReimbursementTransactions[0].to,
            TEST_ERC1155
        );
        assert.equal(
            erc1155RequestSignal.expectedReimbursementTransactions[0].value,
            '0'
        );
        assert.equal(
            erc1155RequestSignal.expectedReimbursementTransactions[0].operation,
            0
        );

        const decodedErc1155Reimbursement = decodeFunctionData({
            abi: erc1155Abi,
            data: erc1155RequestSignal.expectedReimbursementTransactions[0].data,
        });
        assert.equal(decodedErc1155Reimbursement.functionName, 'safeTransferFrom');
        assert.equal(decodedErc1155Reimbursement.args[0].toLowerCase(), TEST_SAFE.toLowerCase());
        assert.equal(decodedErc1155Reimbursement.args[1].toLowerCase(), TEST_AGENT.toLowerCase());
        assert.equal(decodedErc1155Reimbursement.args[2], 42n);
        assert.equal(decodedErc1155Reimbursement.args[3], 3n);
        assert.equal(decodedErc1155Reimbursement.args[4], '0x');

        const validatedErc1155Proposal = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'reimburse-erc1155',
                    name: 'post_bond_and_propose',
                    arguments: JSON.stringify({
                        transactions: [],
                        explanation: erc1155RequestSignal.expectedReimbursementExplanation,
                    }),
                },
            ],
            signals: erc1155FollowupSignals,
            config: {
                ...erc1155Config,
                ipfsEnabled: true,
            },
            agentAddress: TEST_AGENT,
        });
        assert.equal(validatedErc1155Proposal.length, 1);
        assert.equal(validatedErc1155Proposal[0].name, 'post_bond_and_propose');
        assert.equal(
            validatedErc1155Proposal[0].parsedArguments.transactions[0].to,
            TEST_ERC1155
        );

        await onToolOutput({
            name: 'post_bond_and_propose',
            parsedOutput: {
                status: 'submitted',
                transactionHash: TEST_ERC1155_PROPOSAL_TX_HASH,
                ogProposalHash: TEST_ERC1155_OG_PROPOSAL_HASH,
            },
        });

        const reimbursedErc1155State = await getRequestArchiveState();
        assert.equal(
            reimbursedErc1155State.requests[erc1155Signal.requestId].reimbursementProposalHash,
            TEST_ERC1155_OG_PROPOSAL_HASH
        );
        assert.equal(
            reimbursedErc1155State.requests[erc1155Signal.requestId].reimbursementSubmissionTxHash,
            TEST_ERC1155_PROPOSAL_TX_HASH
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
