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
    return value;
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
        if (baseToken.toLowerCase() === quoteToken.toLowerCase()) {
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
                    'Extract Uniswap V3 price race triggers from this plain-language commitment. Return strict JSON with shape {"triggers":[...]}. Each trigger must include: id, label, baseToken, quoteToken, comparator (gte|lte), threshold (number), priority (number), and optional pool (address). If no pool is explicit, omit pool and it will use high-liquidity selection. Use only addresses and conditions present in the commitment text.',
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
        'Preferred flow: build_og_transactions with uniswap_v3_exact_input_single actions, then post_bond_and_propose.',
        'When pool addresses are specified in the commitment/rules, use those pools. Otherwise use high-liquidity Uniswap routing that satisfies slippage constraints.',
        'Use the poolFee from a priceTrigger signal when preparing uniswap_v3_exact_input_single actions.',
        'Never execute both branches, and never route purchased assets to addresses other than the commitment Safe unless explicitly required by the commitment.',
        'If there is insufficient evidence that a trigger fired first, or route/liquidity/slippage constraints are not safely satisfiable, return ignore.',
        'Default to disputing proposals that violate these rules; prefer no-op when unsure.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
        'If no action is needed, output strict JSON with keys: action (propose|deposit|dispute|ignore|other) and rationale (string).',
    ]
        .filter(Boolean)
        .join(' ');
}

export { getPriceTriggers, getSystemPrompt, sanitizeInferredTriggers };
