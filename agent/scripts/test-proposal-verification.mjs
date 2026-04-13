import assert from 'node:assert/strict';
import {
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionData,
    erc20Abi,
} from 'viem';
import { computeRulesHash, verifyProposal } from '../src/lib/proposal-verification.js';
import { buildSignedProposalPayload } from '../src/lib/signed-proposal.js';

const AGENT = '0x1111111111111111111111111111111111111111';
const OTHER_AGENT = '0x1212121212121212121212121212121212121212';
const SAFE = '0x2222222222222222222222222222222222222222';
const DEPOSIT_TOKEN = '0x3333333333333333333333333333333333333333';
const REIMBURSEMENT_TOKEN = '0x4444444444444444444444444444444444444444';
const OG_MODULE = '0x5555555555555555555555555555555555555555';
const OTHER_SAFE = '0x8888888888888888888888888888888888888888';
const OTHER_OG_MODULE = '0x9999999999999999999999999999999999999999';
const RECOVERY_A = '0x6666666666666666666666666666666666666666';
const RECOVERY_B = '0x7777777777777777777777777777777777777777';
const DEPOSIT_TX_HASH = `0x${'a'.repeat(64)}`;
const PENDING_PROPOSAL_TX_HASH = `0x${'b'.repeat(64)}`;

function buildRulesText(agentAddress = AGENT) {
    return [
        'Agent Proxy',
        '---',
        `The agent at address ${agentAddress} may trade tokens in this commitment for different tokens, at the current fair market exchange rate. To execute the trade, they deposit tokens from their own wallet into the Safe, and propose to withdraw tokens of equal or lesser value. Token prices are based on the prices at the time of the deposit.`,
        '',
        'Account Recovery and Rule Updates',
        '---',
        `These rules may be updated by a 1/2 consensus of addresses ${RECOVERY_A}, ${RECOVERY_B}. After the rule update is executed, the new rules apply to all future transaction proposals.`,
    ].join('\n');
}

function buildTransferLog({ token, from, to, amountWei }) {
    return {
        address: token,
        topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: 'Transfer',
            args: {
                from,
                to,
            },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(amountWei)]),
    };
}

function buildEnvelope({
    requestId,
    depositTxHashes = [DEPOSIT_TX_HASH],
    commitmentSafe = SAFE,
    ogModule = OG_MODULE,
    signerAddress = AGENT,
    authorizedAgent = AGENT,
    reimbursementRecipient = authorizedAgent,
    rulesText = buildRulesText(authorizedAgent),
}) {
    return {
        address: signerAddress,
        chainId: 11155111,
        timestampMs: 1_760_000_000_000,
        requestId,
        commitmentSafe,
        ogModule,
        transactions: [
            {
                to: REIMBURSEMENT_TOKEN,
                value: '0',
                data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'transfer',
                    args: [reimbursementRecipient, 1_000_000n],
                }),
                operation: 0,
            },
        ],
        explanation: 'Agent reimbursement proposal.',
        metadata: {
            verification: {
                proposalKind: 'agent_proxy_reimbursement',
                rulesHash: computeRulesHash(rulesText),
                depositTxHashes,
                depositPriceSnapshots: depositTxHashes.map((depositTxHash) => ({
                    depositTxHash,
                    depositAssetPriceUsdMicros: '2000000',
                    reimbursementAssetPricesUsdMicros: {
                        [REIMBURSEMENT_TOKEN]: '1000000',
                    },
                })),
                reimbursementAllocations: depositTxHashes.map((depositTxHash, index) => ({
                    depositTxHash,
                    reimbursements:
                        index === 0
                            ? [
                                  {
                                      token: REIMBURSEMENT_TOKEN,
                                      amountWei: '1000000',
                                  },
                              ]
                            : [
                                  {
                                      token: REIMBURSEMENT_TOKEN,
                                      amountWei: '1',
                                  },
                              ],
                })),
            },
        },
        deadline: null,
    };
}

function buildPublicClient({ rulesText = buildRulesText() } = {}) {
    const receipts = new Map([
        [
            DEPOSIT_TX_HASH,
            {
                status: 'success',
                blockNumber: 123n,
                logs: [
                    buildTransferLog({
                        token: DEPOSIT_TOKEN,
                        from: AGENT,
                        to: SAFE,
                        amountWei: '1000000',
                    }),
                ],
            },
        ],
    ]);

    return {
        async getTransactionReceipt({ hash }) {
            const receipt = receipts.get(hash);
            if (!receipt) {
                throw new Error(`unknown receipt for ${hash}`);
            }
            return receipt;
        },
        async readContract({ address, functionName }) {
            if (functionName === 'rules') {
                const normalized = address.toLowerCase();
                if (normalized === OG_MODULE.toLowerCase()) return rulesText;
            }
            if (functionName === 'decimals') {
                const normalized = address.toLowerCase();
                if (normalized === DEPOSIT_TOKEN.toLowerCase()) return 6;
                if (normalized === REIMBURSEMENT_TOKEN.toLowerCase()) return 6;
            }
            throw new Error(`unexpected readContract ${functionName} ${address}`);
        },
        async getBlockNumber() {
            return 999n;
        },
        async getLogs() {
            return [];
        },
    };
}

async function main() {
    const rulesText = buildRulesText();
    const publicClient = buildPublicClient();

    const validResult = await verifyProposal({
        envelope: buildEnvelope({ requestId: 'valid' }),
        publicClient,
        storeRecords: [],
        nowMs: 1_760_000_001_000,
    });
    assert.equal(validResult.status, 'valid');
    assert.equal(validResult.rules.rulesHash, computeRulesHash(rulesText));
    assert.equal(validResult.derivedFacts.authorizedAgent, AGENT.toLowerCase());
    assert.equal(validResult.derivedFacts.totalBatchDepositValueUsdMicros, '2000000');
    assert.equal(validResult.derivedFacts.reimbursementValueUsdMicros, '1000000');
    assert.equal(
        validResult.checks.find((check) => check.id === 'whole_batch_value_ceiling')?.status,
        'pass'
    );

    const existingPendingEnvelope = buildEnvelope({ requestId: 'existing-pending' });
    const pendingStoreRecord = {
        signer: AGENT.toLowerCase(),
        chainId: 11155111,
        requestId: 'existing-pending',
        signature: `0x${'1'.repeat(130)}`,
        canonicalMessage: buildSignedProposalPayload(existingPendingEnvelope),
        receivedAtMs: 1_760_000_000_000,
        publishedAtMs: 1_760_000_000_500,
        artifact: null,
        cid: 'bafy-test',
        uri: 'ipfs://bafy-test',
        pinned: true,
        publishResult: null,
        pinResult: null,
        lastError: null,
        verification: null,
        submission: {
            status: 'submitted',
            submittedAtMs: 1_760_000_000_600,
            transactionHash: PENDING_PROPOSAL_TX_HASH,
            ogProposalHash: null,
            result: null,
            error: null,
            sideEffectsLikelyCommitted: true,
        },
        createdAtMs: 1_760_000_000_000,
        updatedAtMs: 1_760_000_000_600,
    };
    const reservedResult = await verifyProposal({
        envelope: buildEnvelope({ requestId: 'reserved-deposit' }),
        publicClient,
        storeRecords: [pendingStoreRecord],
        nowMs: 1_760_000_001_000,
    });
    assert.equal(reservedResult.status, 'invalid');
    assert.equal(
        reservedResult.checks.find((check) => check.id === 'deposit_reuse')?.status,
        'fail'
    );

    const sameCommitmentDifferentAgentEnvelope = buildEnvelope({
        requestId: 'same-commitment-different-agent',
        signerAddress: OTHER_AGENT,
        authorizedAgent: OTHER_AGENT,
        reimbursementRecipient: OTHER_AGENT,
        rulesText: buildRulesText(OTHER_AGENT),
    });
    const sameCommitmentDifferentAgentRecord = {
        ...pendingStoreRecord,
        signer: OTHER_AGENT.toLowerCase(),
        requestId: 'same-commitment-different-agent',
        canonicalMessage: buildSignedProposalPayload(sameCommitmentDifferentAgentEnvelope),
    };
    const sameCommitmentDifferentAgentResult = await verifyProposal({
        envelope: buildEnvelope({ requestId: 'same-deposit-same-commitment-other-agent' }),
        publicClient,
        storeRecords: [sameCommitmentDifferentAgentRecord],
        nowMs: 1_760_000_001_000,
    });
    assert.equal(sameCommitmentDifferentAgentResult.status, 'valid');
    assert.equal(
        sameCommitmentDifferentAgentResult.checks.find((check) => check.id === 'deposit_reuse')
            ?.status,
        'pass'
    );

    const foreignCommitmentEnvelope = buildEnvelope({
        requestId: 'foreign-commitment',
        commitmentSafe: OTHER_SAFE,
        ogModule: OTHER_OG_MODULE,
    });
    const foreignCommitmentRecord = {
        ...pendingStoreRecord,
        requestId: 'foreign-commitment',
        canonicalMessage: buildSignedProposalPayload(foreignCommitmentEnvelope),
    };
    const foreignCommitmentResult = await verifyProposal({
        envelope: buildEnvelope({ requestId: 'same-deposit-other-commitment' }),
        publicClient,
        storeRecords: [foreignCommitmentRecord],
        nowMs: 1_760_000_001_000,
    });
    assert.equal(foreignCommitmentResult.status, 'valid');
    assert.equal(
        foreignCommitmentResult.checks.find((check) => check.id === 'deposit_reuse')?.status,
        'pass'
    );

    console.log('[test] proposal verification OK');
}

main().catch((error) => {
    console.error('[test] proposal verification failed:', error?.message ?? error);
    process.exit(1);
});
