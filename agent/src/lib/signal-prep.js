import { extractTimelockTriggers } from './timelock.js';
import { collectPriceTriggerSignals } from './uniswapV3Price.js';

export function createSignalPreparationRuntime({
    agentModule,
    publicClient,
    config,
    account,
    commitmentText,
    trackedAssets,
}) {
    const depositHistory = [];
    const blockTimestampCache = new Map();
    const timelockTriggers = new Map();
    const priceTriggerState = new Map();
    const tokenMetaCache = new Map();
    const poolMetaCache = new Map();
    const resolvedPoolCache = new Map();

    async function getBlockTimestampMs(blockNumber) {
        if (!blockNumber) {
            return undefined;
        }
        const key = blockNumber.toString();
        if (blockTimestampCache.has(key)) {
            return blockTimestampCache.get(key);
        }
        const block = await publicClient.getBlock({ blockNumber });
        const timestampMs = Number(block.timestamp) * 1000;
        blockTimestampCache.set(key, timestampMs);
        return timestampMs;
    }

    async function recordDeposits(deposits) {
        for (const deposit of deposits) {
            depositHistory.push({
                ...deposit,
                timestampMs: await getBlockTimestampMs(deposit.blockNumber),
            });
        }
    }

    function updateTimelockSchedule({ rulesText }) {
        const triggers = extractTimelockTriggers({
            rulesText,
            deposits: depositHistory,
        });

        for (const trigger of triggers) {
            if (!timelockTriggers.has(trigger.id)) {
                timelockTriggers.set(trigger.id, { ...trigger, fired: false });
            }
        }
    }

    function collectDueTimelocks(nowMs) {
        const due = [];
        for (const trigger of timelockTriggers.values()) {
            if (trigger.fired) {
                continue;
            }
            if (trigger.timestampMs <= nowMs) {
                due.push(trigger);
            }
        }
        return due;
    }

    function markTimelocksFired(triggers) {
        for (const trigger of triggers) {
            const existing = timelockTriggers.get(trigger.id);
            if (existing) {
                existing.fired = true;
            }
        }
    }

    async function getActivePriceTriggers({ rulesText }) {
        if (typeof agentModule?.getPriceTriggers !== 'function') {
            return [];
        }

        try {
            const parsed = await agentModule.getPriceTriggers({
                commitmentText: rulesText ?? commitmentText ?? '',
                config,
            });
            if (Array.isArray(parsed)) {
                return parsed;
            }
            console.warn('[agent] getPriceTriggers() returned non-array; ignoring.');
            return [];
        } catch (error) {
            console.warn(
                '[agent] getPriceTriggers() failed; skipping price triggers:',
                error?.message ?? error
            );
            return [];
        }
    }

    async function seedTrackedAssetsFromRules({ rulesText }) {
        const triggers = await getActivePriceTriggers({ rulesText });
        for (const trigger of triggers) {
            if (trigger?.baseToken) {
                trackedAssets.add(String(trigger.baseToken).toLowerCase());
            }
            if (trigger?.quoteToken) {
                trackedAssets.add(String(trigger.quoteToken).toLowerCase());
            }
        }
        return triggers;
    }

    async function collectPriceSignals({ triggers, nowMs }) {
        return collectPriceTriggerSignals({
            publicClient,
            config,
            triggers,
            nowMs,
            triggerState: priceTriggerState,
            tokenMetaCache,
            poolMetaCache,
            resolvedPoolCache,
        });
    }

    async function prepareSignalsForDecision(
        signals,
        { nowMs, latestBlock, onchainPendingProposal }
    ) {
        let signalsToProcess = signals;
        if (agentModule?.augmentSignals) {
            signalsToProcess = agentModule.augmentSignals(signalsToProcess, {
                nowMs,
                latestBlock,
            });
        }
        if (agentModule?.enrichSignals) {
            try {
                signalsToProcess = await agentModule.enrichSignals(signalsToProcess, {
                    publicClient,
                    config,
                    account,
                    onchainPendingProposal,
                    nowMs,
                    latestBlock,
                });
            } catch (error) {
                console.error('[agent] Failed to enrich signals:', error);
            }
        }
        return Array.isArray(signalsToProcess) ? signalsToProcess : [];
    }

    return {
        recordDeposits,
        updateTimelockSchedule,
        collectDueTimelocks,
        markTimelocksFired,
        getActivePriceTriggers,
        seedTrackedAssetsFromRules,
        collectPriceSignals,
        prepareSignalsForDecision,
    };
}
