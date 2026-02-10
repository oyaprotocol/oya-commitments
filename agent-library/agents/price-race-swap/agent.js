const TOKENS = Object.freeze({
    WETH: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
    USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    UNI: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
});

const ALLOWED_ROUTERS = new Set([
    '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e',
]);
const DEFAULT_ROUTER = '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e';
const ALLOWED_FEE_TIERS = new Set([500, 3000, 10000]);

const inferredTriggersCache = new Map();
const singleFireState = {
    proposalSubmitted: false,
    proposalHash: null,
};

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
            // Keep price conditions level-triggered so a later deposit can still act.
            emitOnce: trigger.emitOnce === undefined ? false : Boolean(trigger.emitOnce),
        };

        if (trigger.pool) {
            out.pool = normalizeAddress(String(trigger.pool));
        } else {
            out.poolSelection = 'high-liquidity';
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

    if (inferredTriggersCache.has(commitmentText)) {
        return inferredTriggersCache.get(commitmentText);
    }

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content:
                    'Extract exactly two Uniswap V3 price race triggers from this plain-language commitment. Return strict JSON: {"triggers":[...]}. Each trigger must include: id, label, baseToken, quoteToken, comparator (gte|lte), threshold (number), priority (number), and optional pool (address). If pool is not explicit in the commitment, omit it and high-liquidity pool selection will be used. Use only addresses and conditions present in the commitment text. Do not invent pools, tokens, or thresholds.',
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

    const sBase = String(signal.baseToken ?? '').toLowerCase();
    const sQuote = String(signal.quoteToken ?? '').toLowerCase();
    const pairMatches =
        (sBase === tokenIn && sQuote === tokenOut) ||
        (sBase === tokenOut && sQuote === tokenIn);
    if (!pairMatches) return false;

    if (signal.poolFee === undefined || signal.poolFee === null) return false;
    return Number(signal.poolFee) === actionFee;
}

function pickWinningPriceTrigger(signals) {
    const triggers = Array.isArray(signals)
        ? signals.filter((signal) => signal?.kind === 'priceTrigger')
        : [];
    if (triggers.length === 0) return null;
    const sorted = [...triggers].sort((a, b) => {
        const pa = Number(a?.priority ?? Number.MAX_SAFE_INTEGER);
        const pb = Number(b?.priority ?? Number.MAX_SAFE_INTEGER);
        if (pa !== pb) return pa - pb;
        return String(a?.triggerId ?? '').localeCompare(String(b?.triggerId ?? ''));
    });
    return sorted[0];
}

function pickWethSnapshot(signals) {
    if (!Array.isArray(signals)) return null;
    for (const signal of signals) {
        if (signal?.kind !== 'erc20BalanceSnapshot') continue;
        if (String(signal.asset ?? '').toLowerCase() !== TOKENS.WETH) continue;
        return signal;
    }
    return null;
}

async function validateToolCalls({ toolCalls, signals, commitmentText, commitmentSafe }) {
    const validated = [];
    const safeAddress = commitmentSafe ? String(commitmentSafe).toLowerCase() : null;
    const winningTrigger = pickWinningPriceTrigger(signals);
    const wethSnapshot = pickWethSnapshot(signals);

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
        if (singleFireState.proposalSubmitted) {
            throw new Error('Single-fire lock engaged: a proposal was already submitted.');
        }

        const args = parseCallArgs(call);
        if (!args || !Array.isArray(args.actions) || args.actions.length !== 1) {
            throw new Error('build_og_transactions must include exactly one swap action.');
        }

        const action = args.actions[0];
        if (action.kind !== 'uniswap_v3_exact_input_single') {
            throw new Error('Only uniswap_v3_exact_input_single is allowed for this agent.');
        }

        if (!winningTrigger) {
            throw new Error('No priceTrigger signal available for this cycle.');
        }
        if (!wethSnapshot?.amount) {
            throw new Error('No WETH erc20BalanceSnapshot available for this cycle.');
        }

        const inferredTokenOut =
            String(winningTrigger.baseToken ?? '').toLowerCase() === TOKENS.WETH
                ? String(winningTrigger.quoteToken ?? '').toLowerCase()
                : String(winningTrigger.baseToken ?? '').toLowerCase();

        const tokenIn = normalizeAddress(String(action.tokenIn ?? TOKENS.WETH));
        const tokenOut = normalizeAddress(String(action.tokenOut ?? inferredTokenOut));
        const router = DEFAULT_ROUTER;
        const recipient = normalizeAddress(String(action.recipient ?? safeAddress));
        const fee = Number(action.fee ?? winningTrigger.poolFee);
        const amountIn = BigInt(action.amountInWei ?? String(wethSnapshot.amount));
        const amountOutMin = BigInt(action.amountOutMinWei ?? '0');

        action.tokenIn = tokenIn;
        action.tokenOut = tokenOut;
        action.router = router;
        action.recipient = recipient;
        action.fee = fee;
        action.amountInWei = amountIn.toString();
        action.amountOutMinWei = amountOutMin.toString();
        args.actions[0] = action;

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
        if (!ALLOWED_FEE_TIERS.has(fee)) {
            throw new Error('Swap fee tier is not allowlisted.');
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
                'Swap action does not match a current priceTrigger signal in the current cycle.'
            );
        }

        validated.push({
            ...call,
            parsedArguments: args,
        });
    }

    return validated;
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
        'Single-fire mode is enabled: after one successful proposal submission, do not propose again.',
        'Use your reasoning over the plain-language commitment and incoming signals. Do not depend on rigid text pattern matching.',
        'Treat erc20BalanceSnapshot signals as authoritative current Safe balances for this cycle.',
        'If exactly one priceTrigger signal is present in this cycle, treat it as the winning branch for this cycle.',
        'When both a winning priceTrigger and a WETH erc20BalanceSnapshot are present, you have enough information to act.',
        'First trigger wins. If multiple triggers appear true in one cycle, use signal priority and then lexical triggerId order.',
        'Use all currently available WETH in the Safe for the winning branch swap.',
        'Build one uniswap_v3_exact_input_single action where amountInWei equals the WETH snapshot amount.',
        `Set router to Sepolia Uniswap V3 SwapRouter02 at ${DEFAULT_ROUTER}.`,
        'Compute amountOutMinWei using observedPrice and max slippage 0.50% (multiply expected output by 0.995).',
        'If tokenIn is the base token of observedPrice, expectedOut ~= amountIn * observedPrice adjusted for token decimals.',
        'If tokenIn is the quote token and tokenOut is base, expectedOut ~= amountIn / observedPrice adjusted for token decimals.',
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

function onToolOutput({ name, parsedOutput }) {
    if (!name || !parsedOutput || parsedOutput.status !== 'submitted') return;
    if (name !== 'post_bond_and_propose' && name !== 'auto_post_bond_and_propose') return;
    singleFireState.proposalSubmitted = true;
    singleFireState.proposalHash = parsedOutput.proposalHash ?? null;
}

function getSingleFireState() {
    return { ...singleFireState };
}

function resetSingleFireState() {
    singleFireState.proposalSubmitted = false;
    singleFireState.proposalHash = null;
}

export {
    getPriceTriggers,
    getSystemPrompt,
    getSingleFireState,
    onToolOutput,
    resetSingleFireState,
    sanitizeInferredTriggers,
    validateToolCalls,
};
