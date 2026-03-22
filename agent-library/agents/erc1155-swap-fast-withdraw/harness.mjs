import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { erc1155Abi } from 'viem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function escapeForRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOrderId(signer, requestId) {
    return `request:${getAddress(signer)}:${String(requestId).trim()}`;
}

function getStatePath({ chainId, commitmentSafe }) {
    return path.join(
        __dirname,
        `.swap-state-chain-${String(chainId).trim()}-safe-${String(commitmentSafe).trim().toLowerCase()}.json`
    );
}

async function readSwapState(statePath) {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw);
}

async function readOrder(statePath, orderId) {
    const state = await readSwapState(statePath);
    return state?.orders?.[orderId] ?? null;
}

function sortOrders(records) {
    return [...records].sort((left, right) => {
        const leftSequence = Number(left?.sequence ?? 0);
        const rightSequence = Number(right?.sequence ?? 0);
        if (leftSequence !== rightSequence) {
            return leftSequence - rightSequence;
        }
        return String(left?.orderId ?? '').localeCompare(String(right?.orderId ?? ''));
    });
}

function getOpenOrders(state) {
    return sortOrders(
        Object.values(state?.orders ?? {}).filter(
            (order) =>
                order?.sourceKind === 'signed_request' &&
                typeof order?.reservedCreditAmountWei === 'string' &&
                !order?.reimbursedAtMs &&
                !order?.closedAtMs &&
                !order?.creditReleasedAtMs
        )
    );
}

function getPendingDirectFillReservedTokenAmount(state) {
    let total = 0n;
    for (const order of getOpenOrders(state)) {
        if (!order?.directFillTxHash || order?.directFillConfirmed) {
            continue;
        }
        if (order.directFillBlockNumber !== undefined && order.directFillBlockNumber !== null) {
            continue;
        }
        total += BigInt(order.tokenAmount ?? 0);
    }
    return total;
}

function getPendingSafeReimbursementReservedWei(state) {
    let total = 0n;
    for (const order of getOpenOrders(state)) {
        if (!order?.directFillTxHash) {
            continue;
        }
        total += BigInt(order.reimbursementAmountWei ?? 0);
    }
    return total;
}

function getNextDirectFillCandidate(state, { agentTokenInventory, safeUsdcBalance }) {
    let availableAgentTokenBalance =
        BigInt(agentTokenInventory) - getPendingDirectFillReservedTokenAmount(state);
    if (availableAgentTokenBalance < 0n) {
        availableAgentTokenBalance = 0n;
    }

    let availableSafePaymentBalance =
        BigInt(safeUsdcBalance) - getPendingSafeReimbursementReservedWei(state);
    if (availableSafePaymentBalance < 0n) {
        availableSafePaymentBalance = 0n;
    }

    for (const order of getOpenOrders(state)) {
        if (!order?.artifactUri || order?.directFillTxHash) {
            continue;
        }
        if (availableAgentTokenBalance < BigInt(order.tokenAmount ?? 0)) {
            continue;
        }
        if (availableSafePaymentBalance < BigInt(order.reimbursementAmountWei ?? 0)) {
            continue;
        }
        return order;
    }

    return null;
}

async function findBlockingReimbursementOrder(statePath, currentOrderId) {
    const state = await readSwapState(statePath);
    for (const order of Object.values(state?.orders ?? {})) {
        if (!order || order.orderId === currentOrderId) {
            continue;
        }
        const isOpen = !order.reimbursedAtMs && !order.creditReleasedAtMs && !order.closedAtMs;
        const hasReachedReimbursementQueue =
            order.reimbursementSubmissionTxHash ||
            order.reimbursementProposalHash ||
            order.directFillConfirmed;
        if (isOpen && hasReachedReimbursementQueue) {
            return {
                orderId: order.orderId,
                proposalHash: order.reimbursementProposalHash ?? null,
                submissionTxHash: order.reimbursementSubmissionTxHash ?? null,
                directFillConfirmed: order.directFillConfirmed === true,
            };
        }
    }
    return null;
}

function getHarnessDefinition() {
    return {
        scenario: 'erc1155-swap-fast-withdraw-remote-smoke',
        description:
            'Deposits Sepolia USDC into the configured commitment, sends a signed ERC1155 withdrawal request, and waits for archive, direct fill, and reimbursement proposal submission when inventory is available.',
    };
}

async function runSmokeScenario(ctx) {
    if (ctx.profile.chainId !== 11155111) {
        throw new Error('erc1155-swap-fast-withdraw smoke is currently defined only for Sepolia.');
    }

    const deployment = await ctx.ensureDeployment();
    const agent = await ctx.ensureAgentStarted();
    const depositor = ctx.loadRole('depositor');
    const { publicClient } = ctx.createHarnessClients();
    const trackedErc1155 = ctx.runtimeConfig.watchErc1155Assets?.[0];
    if (!trackedErc1155?.token || trackedErc1155?.tokenId === undefined) {
        throw new Error('erc1155-swap-fast-withdraw smoke requires one tracked ERC1155 asset.');
    }
    const statePath = getStatePath({
        chainId: ctx.profile.chainId,
        commitmentSafe: ctx.runtimeConfig.commitmentSafe,
    });
    const recipientBalanceBefore = await publicClient.readContract({
        address: trackedErc1155.token,
        abi: erc1155Abi,
        functionName: 'balanceOf',
        args: [depositor.address, BigInt(trackedErc1155.tokenId)],
    });

    const deposit = await ctx.sendDeposit({
        roleName: 'depositor',
    });
    await ctx.waitForAgentLog(
        new RegExp(`Recorded ERC20 deposit credit for ${escapeForRegex(depositor.address)}:.*${escapeForRegex(deposit.transactionHash.toLowerCase())}`, 'i'),
        { timeoutMs: 30_000 }
    );

    const requestId = `remote-smoke-${Date.now()}`;
    const orderId = buildOrderId(depositor.address, requestId);
    const response = await ctx.sendMessage({
        roleName: 'depositor',
        requestId,
        text: `Please fast withdraw 1 unit of token ${trackedErc1155.tokenId} to ${depositor.address}.`,
        command: 'fast_withdraw_erc1155',
        args: {
            recipient: depositor.address,
            amount: '1',
            token: trackedErc1155.token,
            tokenId: trackedErc1155.tokenId,
        },
    });

    assert.equal(response.status, 202, `Expected 202 from message API, got ${response.status}.`);
    assert.equal(response.ok, true, 'Message API should accept the smoke-test withdrawal request.');
    assert.equal(response.response?.status, 'queued', 'Withdrawal request should be queued.');

    await ctx.waitForAgentLog(
        new RegExp(`Accepted signed ERC1155 withdrawal request ${escapeForRegex(orderId)}`),
        { timeoutMs: 45_000 }
    );
    const archiveLog = await ctx.waitForAgentLog(
        new RegExp(`Signed request archive published for order ${escapeForRegex(orderId)}: uri=ipfs://`),
        { timeoutMs: 60_000 }
    );

    const archiveUriMatch = archiveLog.match(new RegExp(`Signed request archive published for order ${escapeForRegex(orderId)}: uri=(ipfs://[^\\s.]+)`));
    const archiveUri = archiveUriMatch?.[1] ?? null;
    const inventoryCheck = await Promise.all([
        publicClient.readContract({
            address: trackedErc1155.token,
            abi: erc1155Abi,
            functionName: 'balanceOf',
            args: [agent.signerAddress, BigInt(trackedErc1155.tokenId)],
        }),
        publicClient.readContract({
            address: ctx.runtimeConfig.defaultDepositAsset,
            abi: [
                {
                    type: 'function',
                    name: 'balanceOf',
                    stateMutability: 'view',
                    inputs: [{ name: 'account', type: 'address' }],
                    outputs: [{ name: '', type: 'uint256' }],
                },
            ],
            functionName: 'balanceOf',
            args: [ctx.runtimeConfig.commitmentSafe],
        }),
    ]);
    const agentTokenInventory = BigInt(inventoryCheck[0]);
    const safeUsdcBalance = BigInt(inventoryCheck[1]);
    const shouldAssertFillAndProposal =
        agentTokenInventory >= 1n &&
        safeUsdcBalance >= BigInt(deposit.amountWei);

    let directFill = null;
    let reimbursement = null;
    let fillAndProposalSkippedReason = null;

    if (shouldAssertFillAndProposal) {
        const stateAfterArchive = await readSwapState(statePath);
        const nextDirectFillCandidate = getNextDirectFillCandidate(stateAfterArchive, {
            agentTokenInventory,
            safeUsdcBalance,
        });
        if (nextDirectFillCandidate && nextDirectFillCandidate.orderId !== orderId) {
            fillAndProposalSkippedReason =
                `Direct fill skipped because another order is ahead in the direct fill queue: order=${nextDirectFillCandidate.orderId}.`;
        } else if (!nextDirectFillCandidate) {
            fillAndProposalSkippedReason =
                `Direct fill skipped because the current order is not fillable under the present inventory and Safe reimbursement reservations.`;
        } else {
        await ctx.waitForAgentLog(
            new RegExp(`Preparing direct ERC1155 fill for order ${escapeForRegex(orderId)}\\.`),
            { timeoutMs: 60_000 }
        );
        const filledOrder = await ctx.pollUntil(
            async () => {
                const order = await readOrder(statePath, orderId);
                if (order?.directFillConfirmed && order?.directFillTxHash) {
                    return order;
                }
                return null;
            },
            {
                timeoutMs: 120_000,
                intervalMs: 1_000,
                label: `direct fill confirmation for ${orderId}`,
            }
        );
        const recipientBalanceAfter = await publicClient.readContract({
            address: trackedErc1155.token,
            abi: erc1155Abi,
            functionName: 'balanceOf',
            args: [depositor.address, BigInt(trackedErc1155.tokenId)],
        });
        assert.ok(
            BigInt(recipientBalanceAfter) >= BigInt(recipientBalanceBefore) + 1n,
            `Expected recipient ERC1155 balance to increase after direct fill for ${orderId}.`
        );

        directFill = {
            txHash: filledOrder.directFillTxHash,
            confirmed: filledOrder.directFillConfirmed === true,
            blockNumber: filledOrder.directFillBlockNumber ?? null,
            recipientBalanceBefore: BigInt(recipientBalanceBefore).toString(),
            recipientBalanceAfter: BigInt(recipientBalanceAfter).toString(),
        };
        const blockingReimbursementOrder = await findBlockingReimbursementOrder(statePath, orderId);
        if (blockingReimbursementOrder) {
            fillAndProposalSkippedReason =
                `Reimbursement proposal skipped because another order is already ahead in the reimbursement queue: order=${blockingReimbursementOrder.orderId} proposalHash=${blockingReimbursementOrder.proposalHash ?? 'pending'}.`;
            reimbursement = {
                skipped: true,
                blockingOrder: blockingReimbursementOrder,
            };
        } else {
            await ctx.waitForAgentLog(
                new RegExp(`Preparing reimbursement proposal for order ${escapeForRegex(orderId)}\\.`),
                { timeoutMs: 60_000 }
            );
            const reimbursingOrder = await ctx.pollUntil(
                async () => {
                    const order = await readOrder(statePath, orderId);
                    if (order?.reimbursementSubmissionTxHash) {
                        return order;
                    }
                    return null;
                },
                {
                    timeoutMs: 120_000,
                    intervalMs: 1_000,
                    label: `reimbursement proposal submission for ${orderId}`,
                }
            );
            reimbursement = {
                skipped: false,
                submissionTxHash: reimbursingOrder.reimbursementSubmissionTxHash ?? null,
                proposalHash: reimbursingOrder.reimbursementProposalHash ?? null,
                submittedAtMs: reimbursingOrder.reimbursementSubmittedAtMs ?? null,
                explanation: reimbursingOrder.reimbursementExplanation ?? null,
            };
        }
        }
    } else {
        fillAndProposalSkippedReason =
            `Insufficient live prerequisites: agentTokenInventory=${agentTokenInventory.toString()} safeUsdcBalance=${safeUsdcBalance.toString()} requiredTokenAmount=1 requiredReimbursementWei=${deposit.amountWei}.`;
    }

    return {
        scenario: 'erc1155-swap-fast-withdraw-remote-smoke',
        deployment,
        agent,
        deposit,
        message: {
            requestId: response.requestId,
            status: response.status,
            messageId: response.response?.messageId ?? null,
            endpoint: response.endpoint,
            orderId,
        },
        archiveUri,
        fillAndProposal: {
            asserted: shouldAssertFillAndProposal,
            skippedReason: fillAndProposalSkippedReason,
            directFill,
            reimbursement,
            liveBalances: {
                agentTokenInventory: agentTokenInventory.toString(),
                safeUsdcBalance: safeUsdcBalance.toString(),
            },
        },
    };
}

export { getHarnessDefinition, runSmokeScenario };
