import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS = Object.freeze({
    WETH: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    UNI: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
});

const ALLOWED_POOLS = new Set([
    '0x6418eec70f50913ff0d756b48d32ce7c02b47c47',
    '0x287b0e934ed0439e2a7b1d5f0fc25ea2c24b64f7',
]);

const ALLOWED_ROUTERS = new Set([
    '0xe592427a0aece92de3edee1f18e0157c05861564',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
]);

const inferredTriggersCache = new Map();

function isHexChar(char) {
    const code = char.charCodeAt(0);
    return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 70) ||
        (code >= 97 && code <= 102)
    );
}

function normalizeAddress(value) {
    if (typeof value !== 'string') {
        throw new Error(`Invalid address: ${value}`);
    }
    if (value.length !== 42 || !value.startsWith('0x')) {
        throw new Error(`Invalid address: ${value}`);
    }
    for (let i = 2; i < value.length; i += 1) {
        if (!isHexChar(value[i])) {
            throw new Error(`Invalid address: ${value}`);
        }
    }
    return value.toLowerCase();
}

function normalizeComparator(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'gte' || normalized === '>=') return 'gte';
    if (normalized === 'lte' || normalized === '<=') return 'lte';
    throw new Error(`Unsupported comparator: ${value}`);
}

function extractFirstText(responseJson) {
    const outputs = responseJson?.output;
    if (!Array.isArray(outputs)) return '';

    for (const item of outputs) {
        if (!item?.content) continue;
        for (const chunk of item.content) {
            if (chunk?.text) return chunk.text;
            if (chunk?.output_text) return chunk.output_text?.text ?? '';
            if (chunk?.text?.value) return chunk.text.value;
        }
    }

    return '';
}

function statePath() {
    return process.env.PRICE_RACE_STATE_PATH
        ? path.resolve(process.env.PRICE_RACE_STATE_PATH)
        : path.join(__dirname, '.price-race-state.json');
}

function commitmentKey(commitmentText) {
    return createHash('sha256').update(commitmentText ?? '').digest('hex');
}

function readState() {
    const file = statePath();
    if (!existsSync(file)) {
        return { commitments: {} };
    }

    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return { commitments: {} };
        }
        return {
            commitments:
                parsed.commitments && typeof parsed.commitments === 'object'
                    ? parsed.commitments
                    : {},
        };
    } catch (error) {
        return { commitments: {} };
    }
}

function writeState(state) {
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function isCommitmentExecuted(commitmentText) {
    if (!commitmentText) return false;
    const key = commitmentKey(commitmentText);
    const state = readState();
    return Boolean(state.commitments?.[key]?.executed);
}

function markCommitmentExecuted(commitmentText, metadata = {}) {
    if (!commitmentText) return;
    const key = commitmentKey(commitmentText);
    const state = readState();
    state.commitments[key] = {
        executed: true,
        executedAt: new Date().toISOString(),
        ...metadata,
    };
    writeState(state);
}

function sanitizeInferredTriggers(rawTriggers) {
    if (!Array.isArray(rawTriggers)) {
        return [];
    }

    const normalized = rawTriggers.map((trigger, index) => {
        if (!trigger || typeof trigger !== 'object') {
            throw new Error(`Inferred trigger at index ${index} is not an object.`);
        }

        const baseToken = normalizeAddress(String(trigger.baseToken));
        const quoteToken = normalizeAddress(String(trigger.quoteToken));
        if (baseToken === quoteToken) {
            throw new Error(`Inferred trigger ${index} uses the same base and quote token.`);
        }

        const threshold = Number(trigger.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) {
            throw new Error(`Inferred trigger ${index} has invalid threshold.`);
        }

        const priorityRaw = trigger.priority ?? index;
        const priority = Number(priorityRaw);
        if (!Number.isInteger(priority) || priority < 0) {
            throw new Error(`Inferred trigger ${index} has invalid priority.`);
        }

        const out = {
            id: trigger.id ? String(trigger.id) : `inferred-trigger-${index + 1}`,
            label: trigger.label ? String(trigger.label) : undefined,
            baseToken,
            quoteToken,
            comparator: normalizeComparator(trigger.comparator),
            threshold,
            priority,
            emitOnce: trigger.emitOnce === undefined ? true : Boolean(trigger.emitOnce),
        };

        if (trigger.pool) {
            const pool = normalizeAddress(String(trigger.pool));
            if (!ALLOWED_POOLS.has(pool)) {
                throw new Error(`Inferred trigger ${out.id} references non-allowlisted pool ${pool}`);
            }
            out.pool = pool;
        } else {
            throw new Error(`Inferred trigger ${out.id} must include an explicit pool address.`);
        }

        return out;
    });

    const seenIds = new Set();
    for (const trigger of normalized) {
        if (seenIds.has(trigger.id)) {
            throw new Error(`Duplicate inferred trigger id: ${trigger.id}`);
        }
        seenIds.add(trigger.id);
    }

    normalized.sort((a, b) => {
        const priorityCmp = a.priority - b.priority;
        if (priorityCmp !== 0) return priorityCmp;
        return a.id.localeCompare(b.id);
    });

    return normalized;
}

async function getPriceTriggers({ commitmentText, config }) {
    if (!commitmentText || !config?.openAiApiKey) {
        return [];
    }

    if (isCommitmentExecuted(commitmentText)) {
        return [];
    }

    if (inferredTriggersCache.has(commitmentText)) {
        return inferredTriggersCache.get(commitmentText);
    }

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content:
                    'Extract exactly two Uniswap V3 price race triggers from this plain-language commitment. Return strict JSON: {"triggers":[...]}. Each trigger must include: id, label, baseToken, quoteToken, comparator (gte|lte), threshold (number), priority (number), and pool (address). Use only addresses and conditions present in the commitment text. Do not invent pools, tokens, or thresholds.',
            },
            {
                role: 'user',
                content: commitmentText,
            },
        ],
        text: { format: { type: 'json_object' } },
    };

    const res = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error while inferring triggers: ${res.status} ${text}`);
    }

    const json = await res.json();
    const raw = extractFirstText(json);
    if (!raw) {
        inferredTriggersCache.set(commitmentText, []);
        return [];
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Failed to parse inferred trigger JSON: ${raw}`);
    }

    const triggers = sanitizeInferredTriggers(parsed?.triggers ?? []);
    inferredTriggersCache.set(commitmentText, triggers);
    return triggers;
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch (error) {
            return null;
        }
    }
    return null;
}

function isMatchingPriceSignal(signal, actionFee, tokenIn, tokenOut) {
    if (!signal || signal.kind !== 'priceTrigger') return false;
    if (!signal.pool || !ALLOWED_POOLS.has(String(signal.pool).toLowerCase())) return false;

    const sBase = String(signal.baseToken ?? '').toLowerCase();
    const sQuote = String(signal.quoteToken ?? '').toLowerCase();
    const pairMatches =
        (sBase === tokenIn && sQuote === tokenOut) ||
        (sBase === tokenOut && sQuote === tokenIn);
    if (!pairMatches) return false;

    if (signal.poolFee === undefined || signal.poolFee === null) return false;
    return Number(signal.poolFee) === actionFee;
}

async function validateToolCalls({ toolCalls, signals, commitmentText, commitmentSafe }) {
    if (isCommitmentExecuted(commitmentText)) {
        throw new Error('Commitment already executed; refusing additional swap proposals.');
    }

    const validated = [];
    const safeAddress = commitmentSafe ? String(commitmentSafe).toLowerCase() : null;

    for (const call of toolCalls) {
        if (call.name === 'dispute_assertion') {
            validated.push(call);
            continue;
        }

        if (call.name === 'post_bond_and_propose') {
            continue;
        }

        if (call.name !== 'build_og_transactions') {
            continue;
        }

        const args = parseCallArgs(call);
        if (!args || !Array.isArray(args.actions) || args.actions.length !== 1) {
            throw new Error('build_og_transactions must include exactly one swap action.');
        }

        const action = args.actions[0];
        if (action.kind !== 'uniswap_v3_exact_input_single') {
            throw new Error('Only uniswap_v3_exact_input_single is allowed for this agent.');
        }

        const tokenIn = normalizeAddress(String(action.tokenIn));
        const tokenOut = normalizeAddress(String(action.tokenOut));
        const router = normalizeAddress(String(action.router));
        const recipient = normalizeAddress(String(action.recipient));
        const fee = Number(action.fee);
        const amountIn = BigInt(action.amountInWei ?? '0');
        const amountOutMin = BigInt(action.amountOutMinWei ?? '0');

        if (tokenIn !== TOKENS.WETH) {
            throw new Error('Swap tokenIn must be Sepolia WETH.');
        }
        if (tokenOut !== TOKENS.USDC && tokenOut !== TOKENS.UNI) {
            throw new Error('Swap tokenOut must be Sepolia USDC or UNI.');
        }
        if (!ALLOWED_ROUTERS.has(router)) {
            throw new Error(`Router ${router} is not allowlisted.`);
        }
        if (safeAddress && recipient !== safeAddress) {
            throw new Error('Swap recipient must be the commitment Safe.');
        }
        if (!Number.isInteger(fee) || fee <= 0) {
            throw new Error('Swap fee must be a positive integer.');
        }
        if (amountIn <= 0n) {
            throw new Error('Swap amountInWei must be > 0.');
        }
        if (amountOutMin < 0n) {
            throw new Error('Swap amountOutMinWei must be >= 0.');
        }

        const hasSignalMatch = Array.isArray(signals)
            ? signals.some((signal) => isMatchingPriceSignal(signal, fee, tokenIn, tokenOut))
            : false;
        if (!hasSignalMatch) {
            throw new Error(
                'Swap action does not match an allowlisted priceTrigger signal in the current cycle.'
            );
        }

        validated.push(call);
    }

    return validated;
}

async function onToolOutput({ name, parsedOutput, commitmentText }) {
    if (name !== 'post_bond_and_propose') return;
    if (parsedOutput?.status !== 'submitted') return;

    markCommitmentExecuted(commitmentText, {
        proposalHash: parsedOutput?.proposalHash ? String(parsedOutput.proposalHash) : null,
    });
}

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose and dispute.'
        : proposeEnabled
          ? 'You may propose but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute but you may not propose.'
            : 'You may not propose or dispute; provide opinions only.';

    return [
        'You are a price-race swap agent for a commitment Safe controlled by an Optimistic Governor.',
        'Your own address is provided as agentAddress.',
        'Interpret the commitment as a multi-choice race and execute at most one winning branch.',
        'Use your reasoning over the plain-language commitment and incoming signals. Do not depend on rigid text pattern matching.',
        'First trigger wins. If multiple triggers appear true in one cycle, use signal priority and then lexical triggerId order.',
        'Use all currently available WETH in the Safe for the winning branch swap.',
        'Preferred flow: build_og_transactions with one uniswap_v3_exact_input_single action, then rely on runner propose submission.',
        'Only use allowlisted Sepolia addresses from the commitment context. Never execute both branches.',
        'Use the poolFee from a priceTrigger signal when preparing uniswap_v3_exact_input_single actions.',
        'Never route purchased assets to addresses other than the commitment Safe unless explicitly required by the commitment.',
        'If there is insufficient evidence that a trigger fired first, or route/liquidity/slippage constraints are not safely satisfiable, return ignore.',
        'Default to disputing proposals that violate these rules; prefer no-op when unsure.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
        'If no action is needed, output strict JSON with keys: action (propose|deposit|dispute|ignore|other) and rationale (string).',
    ]
        .filter(Boolean)
        .join(' ');
}

export {
    getPriceTriggers,
    getSystemPrompt,
    isCommitmentExecuted,
    markCommitmentExecuted,
    onToolOutput,
    sanitizeInferredTriggers,
    validateToolCalls,
};
