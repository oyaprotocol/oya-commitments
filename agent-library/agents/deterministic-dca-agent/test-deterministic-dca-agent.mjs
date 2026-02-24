import assert from 'node:assert/strict';
import {
    getSystemPrompt,
    splitReimbursementTranches,
    computeFillNotionalUsdcWei,
    computeWethAmountWei,
    findContractDeploymentBlock,
    buildCampaigns,
    chooseCampaignAction,
    validateToolCalls,
} from './agent.js';

async function run() {
    const prompt = getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: false,
        commitmentText: 'Deterministic DCA commitment.',
    });
    assert.ok(prompt.includes('deterministic'));

    const tranches = splitReimbursementTranches(100_000_000n);
    assert.deepEqual(tranches, [25_000_000n, 25_000_000n, 25_000_000n, 25_000_000n]);

    const discoveredDeploymentBlock = await findContractDeploymentBlock({
        publicClient: {
            getCode: async ({ blockNumber }) => {
                if (blockNumber < 123n) return '0x';
                return '0x1234';
            },
        },
        address: '0x00000000000000000000000000000000000000cc',
        latestBlock: 500n,
    });
    assert.equal(discoveredDeploymentBlock, 123n);

    const fillNotional = computeFillNotionalUsdcWei(25_000_000n);
    assert.equal(fillNotional, 24_875_000n);
    const wethWei = computeWethAmountWei({
        fillNotionalUsdcWei: 24_875_000n,
        chainlinkAnswer: 2_000n * 10n ** 8n,
    });
    assert.equal(wethWei, 12_437_500_000_000_000n);

    const depositTs = Date.now() - 13 * 60 * 60 * 1000;
    const { campaigns, anomalies } = buildCampaigns({
        deposits: [
            {
                amountWei: 100_000_000n,
                blockNumber: 1n,
                logIndex: 0,
                timestampMs: depositTs,
            },
        ],
        reimbursementRecords: [
            { amountWei: 25_000_000n, status: 'executed', blockNumber: 2n, logIndex: 0 },
            { amountWei: 25_000_000n, status: 'executed', blockNumber: 3n, logIndex: 0 },
        ],
        agentFillDeposits: [
            { amountWei: 1n, blockNumber: 2n, logIndex: 1 },
            { amountWei: 1n, blockNumber: 3n, logIndex: 1 },
        ],
    });
    assert.equal(anomalies.length, 0);
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].proposalCount, 2);
    assert.equal(campaigns[0].executedCount, 2);
    assert.equal(campaigns[0].unpairedFillCount, 0);

    const action = chooseCampaignAction({
        campaign: campaigns[0],
        nowMs: Date.now(),
    });
    assert.equal(action.action, 'deposit_and_propose');
    assert.equal(action.nextTrancheIndex, 2);
    assert.equal(action.reimbursementAmountWei, 25_000_000n);

    const proposeOnly = chooseCampaignAction({
        campaign: {
            ...campaigns[0],
            agentFillCount: 3,
            unpairedFillCount: 1,
            proposalCount: 2,
            pendingCount: 0,
        },
        nowMs: Date.now(),
    });
    assert.equal(proposeOnly.action, 'propose_only');

    const validatedTwoStep = await validateToolCalls({
        toolCalls: [
            {
                callId: 'deposit',
                name: 'make_deposit',
                arguments: JSON.stringify({
                    asset: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
                    amountWei: '100',
                }),
            },
            {
                callId: 'build',
                name: 'build_og_transactions',
                arguments: JSON.stringify({
                    actions: [
                        {
                            kind: 'erc20_transfer',
                            token: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
                            to: '0x00000000000000000000000000000000000000aa',
                            amountWei: '25000000',
                        },
                    ],
                }),
            },
        ],
        commitmentSafe: '0x00000000000000000000000000000000000000bb',
        agentAddress: '0x00000000000000000000000000000000000000aa',
    });
    assert.equal(validatedTwoStep.length, 2);

    console.log('[test] deterministic-dca-agent OK');
}

run();
