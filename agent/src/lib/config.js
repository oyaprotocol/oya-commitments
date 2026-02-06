import { getAddress } from 'viem';
import { mustGetEnv, parseAddressList, parseJsonEnv } from './utils.js';

function normalizePriceTrigger(trigger, index) {
    if (!trigger || typeof trigger !== 'object') {
        throw new Error(`PRICE_TRIGGERS_JSON[${index}] must be an object`);
    }
    if (!trigger.pool || !trigger.baseToken || !trigger.quoteToken) {
        throw new Error(
            `PRICE_TRIGGERS_JSON[${index}] requires pool, baseToken, and quoteToken`
        );
    }
    if (!trigger.comparator || !['gte', 'lte'].includes(trigger.comparator)) {
        throw new Error(`PRICE_TRIGGERS_JSON[${index}] comparator must be "gte" or "lte"`);
    }
    if (trigger.threshold === undefined || trigger.threshold === null) {
        throw new Error(`PRICE_TRIGGERS_JSON[${index}] requires threshold`);
    }

    const threshold = Number(trigger.threshold);
    if (!Number.isFinite(threshold)) {
        throw new Error(`PRICE_TRIGGERS_JSON[${index}] threshold must be numeric`);
    }

    return {
        id: trigger.id ?? `price-trigger-${index}`,
        label: trigger.label,
        pool: getAddress(trigger.pool),
        baseToken: getAddress(trigger.baseToken),
        quoteToken: getAddress(trigger.quoteToken),
        comparator: trigger.comparator,
        threshold,
        priority: Number(trigger.priority ?? 0),
        emitOnce: trigger.emitOnce === undefined ? true : Boolean(trigger.emitOnce),
    };
}

function parsePriceTriggers(raw) {
    const parsed = parseJsonEnv(raw, []);
    if (!Array.isArray(parsed)) {
        throw new Error('PRICE_TRIGGERS_JSON must be a JSON array');
    }
    return parsed.map(normalizePriceTrigger);
}

function buildConfig() {
    return {
        rpcUrl: mustGetEnv('RPC_URL'),
        commitmentSafe: getAddress(mustGetEnv('COMMITMENT_SAFE')),
        ogModule: getAddress(mustGetEnv('OG_MODULE')),
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 10_000),
        startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : undefined,
        watchAssets: parseAddressList(process.env.WATCH_ASSETS),
        watchNativeBalance:
            process.env.WATCH_NATIVE_BALANCE === undefined
                ? true
                : process.env.WATCH_NATIVE_BALANCE.toLowerCase() !== 'false',
        defaultDepositAsset: process.env.DEFAULT_DEPOSIT_ASSET
            ? getAddress(process.env.DEFAULT_DEPOSIT_ASSET)
            : undefined,
        defaultDepositAmountWei: process.env.DEFAULT_DEPOSIT_AMOUNT_WEI
            ? BigInt(process.env.DEFAULT_DEPOSIT_AMOUNT_WEI)
            : undefined,
        bondSpender: (process.env.BOND_SPENDER ?? 'og').toLowerCase(),
        openAiApiKey: process.env.OPENAI_API_KEY,
        openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
        openAiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        allowProposeOnSimulationFail: true,
        proposeGasLimit: process.env.PROPOSE_GAS_LIMIT
            ? BigInt(process.env.PROPOSE_GAS_LIMIT)
            : 2_000_000n,
        executeRetryMs: Number(process.env.EXECUTE_RETRY_MS ?? 60_000),
        proposeEnabled:
            process.env.PROPOSE_ENABLED === undefined
                ? true
                : process.env.PROPOSE_ENABLED.toLowerCase() !== 'false',
        disputeEnabled:
            process.env.DISPUTE_ENABLED === undefined
                ? true
                : process.env.DISPUTE_ENABLED.toLowerCase() !== 'false',
        disputeRetryMs: Number(process.env.DISPUTE_RETRY_MS ?? 60_000),
        agentModule: process.env.AGENT_MODULE,
        priceTriggers: parsePriceTriggers(process.env.PRICE_TRIGGERS_JSON),
    };
}

export { buildConfig };
