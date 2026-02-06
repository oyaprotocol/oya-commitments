function normalizeAddress(raw) {
    if (typeof raw !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
        throw new Error(`Invalid address: ${raw}`);
    }
    return raw;
}

function normalizeComparator(raw) {
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'gte' || normalized === '>=' || normalized === 'greater than or equal to') {
        return 'gte';
    }
    if (normalized === 'lte' || normalized === '<=' || normalized === 'less than or equal to') {
        return 'lte';
    }
    throw new Error(`Unsupported comparator: ${raw}`);
}

function extractTokenAddress({ symbol, commitmentText }) {
    const patterns = [
        new RegExp(`\\b${symbol}\\b[^\\n.]{0,80}?(0x[a-fA-F0-9]{40})`, 'i'),
        new RegExp(`(0x[a-fA-F0-9]{40})[^\\n.]{0,80}?\\b${symbol}\\b`, 'i'),
    ];

    for (const pattern of patterns) {
        const match = commitmentText.match(pattern);
        if (match?.[1]) {
            return normalizeAddress(match[1]);
        }
    }

    throw new Error(`Missing token address for symbol ${symbol} in commitment text.`);
}

function parseTriggerStatements(commitmentText) {
    const lines = commitmentText.split('\n');
    const conditionRegex =
        /\bIf\s+([A-Z][A-Z0-9_]*)\s*\/\s*([A-Z][A-Z0-9_]*)\s+(?:price\s+)?(?:is\s+)?(>=|<=|greater than or equal to|less than or equal to)\s*([0-9]+(?:\.[0-9]+)?)/i;

    const triggers = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = line.match(conditionRegex);
        if (!match) continue;

        const baseSymbol = match[1].trim();
        const quoteSymbol = match[2].trim();
        const comparator = normalizeComparator(match[3]);
        const threshold = Number(match[4]);
        if (!Number.isFinite(threshold)) {
            throw new Error(`Invalid threshold in line: ${line}`);
        }

        const context = [line, lines[index + 1] ?? '', lines[index + 2] ?? ''].join(' ');
        const poolMatch = context.match(/pool(?:\s+address)?\s*(0x[a-fA-F0-9]{40})/i);
        const hasHighLiquidity = /high[-\s]liquidity/i.test(context);

        const trigger = {
            id: `trigger-${triggers.length + 1}-${baseSymbol.toLowerCase()}-${quoteSymbol.toLowerCase()}`,
            label: `${baseSymbol}/${quoteSymbol} ${comparator === 'gte' ? '>=' : '<='} ${threshold}`,
            baseSymbol,
            quoteSymbol,
            comparator,
            threshold,
            priority: triggers.length,
            emitOnce: true,
        };

        if (poolMatch?.[1]) {
            trigger.pool = normalizeAddress(poolMatch[1]);
        } else if (hasHighLiquidity) {
            trigger.poolSelection = 'high-liquidity';
        } else {
            trigger.poolSelection = 'high-liquidity';
        }

        triggers.push(trigger);
    }

    return triggers;
}

function getPriceTriggers({ commitmentText }) {
    if (!commitmentText) return [];

    const parsed = parseTriggerStatements(commitmentText);
    return parsed.map((trigger) => ({
        id: trigger.id,
        label: trigger.label,
        baseToken: extractTokenAddress({ symbol: trigger.baseSymbol, commitmentText }),
        quoteToken: extractTokenAddress({ symbol: trigger.quoteSymbol, commitmentText }),
        comparator: trigger.comparator,
        threshold: trigger.threshold,
        priority: trigger.priority,
        emitOnce: trigger.emitOnce,
        ...(trigger.pool ? { pool: trigger.pool } : { poolSelection: trigger.poolSelection }),
    }));
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
        'Price trigger specs are parsed from plain-language commitment text itself. Do not invent trigger values.',
        'First trigger wins. If both triggers appear true in one cycle, use trigger priority and then lexical triggerId order.',
        'Use all currently available USDC in the Safe for the winning branch swap.',
        'Preferred flow: build_og_transactions with uniswap_v3_exact_input_single actions, then post_bond_and_propose.',
        'When pool addresses are specified in the commitment/rules, use those pools. Otherwise use high-liquidity Uniswap routing that satisfies slippage constraints.',
        'Use the poolFee from a priceTrigger signal when preparing uniswap_v3_exact_input_single actions.',
        'Never execute both branches, and never route the purchased asset to addresses other than the commitment Safe unless the commitment explicitly says so.',
        'If there is insufficient evidence that a trigger fired first, or route/liquidity/slippage constraints are not safely satisfiable, return ignore.',
        'Default to disputing proposals that violate these rules; prefer no-op when unsure.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
        'If no action is needed, output strict JSON with keys: action (propose|deposit|dispute|ignore|other) and rationale (string).',
    ]
        .filter(Boolean)
        .join(' ');
}

export { getPriceTriggers, getSystemPrompt };
