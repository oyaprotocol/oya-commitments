function normalizeAddress(raw) {
    if (typeof raw !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
        throw new Error(`Invalid address: ${raw}`);
    }
    return raw;
}

function normalizeComparator(raw) {
    if (raw === 'gte' || raw === '>=') return 'gte';
    if (raw === 'lte' || raw === '<=') return 'lte';
    throw new Error(`Unsupported comparator: ${raw}`);
}

function parseTokenMap(commitmentText) {
    const tokenMap = new Map();
    const lines = commitmentText.split('\n');
    for (const line of lines) {
        const match = line.match(/^\s*-\s*([A-Z][A-Z0-9_]*)\s*=\s*(0x[a-fA-F0-9]{40})\s*$/);
        if (!match) continue;
        tokenMap.set(match[1], normalizeAddress(match[2]));
    }
    return tokenMap;
}

function parseTriggerLine(line) {
    const raw = line.replace(/^\s*-\s*/, '');
    const fields = raw
        .split('|')
        .map((segment) => segment.trim())
        .filter(Boolean);

    const out = {};
    for (const field of fields) {
        const eq = field.indexOf('=');
        if (eq <= 0) continue;
        const key = field.slice(0, eq).trim();
        const value = field.slice(eq + 1).trim();
        out[key] = value;
    }
    return out;
}

function getPriceTriggers({ commitmentText }) {
    if (!commitmentText) return [];

    const tokenMap = parseTokenMap(commitmentText);
    const triggers = [];

    for (const line of commitmentText.split('\n')) {
        if (!/^\s*-\s*id=/.test(line)) continue;

        const fields = parseTriggerLine(line);
        if (!fields.id || !fields.pair || !fields.comparator || !fields.threshold) {
            throw new Error(`Malformed trigger line: ${line}`);
        }

        const [baseSymbol, quoteSymbol] = fields.pair.split('/').map((value) => value.trim());
        if (!baseSymbol || !quoteSymbol) {
            throw new Error(`Invalid pair in trigger line: ${line}`);
        }

        const baseToken = tokenMap.get(baseSymbol);
        const quoteToken = tokenMap.get(quoteSymbol);
        if (!baseToken || !quoteToken) {
            throw new Error(
                `Token address missing for pair ${fields.pair}. Define both symbols in TOKEN_MAP.`
            );
        }

        const threshold = Number(fields.threshold);
        if (!Number.isFinite(threshold)) {
            throw new Error(`Invalid threshold in trigger line: ${line}`);
        }

        const trigger = {
            id: fields.id,
            label: fields.label ?? `${fields.pair} ${fields.comparator} ${fields.threshold}`,
            baseToken,
            quoteToken,
            comparator: normalizeComparator(fields.comparator),
            threshold,
            priority: fields.priority !== undefined ? Number(fields.priority) : 0,
            emitOnce: fields.emitOnce === undefined ? true : fields.emitOnce !== 'false',
        };

        if (fields.pool) {
            if (fields.pool.toLowerCase() === 'high-liquidity') {
                trigger.poolSelection = 'high-liquidity';
            } else {
                trigger.pool = normalizeAddress(fields.pool);
            }
        } else {
            trigger.poolSelection = 'high-liquidity';
        }

        triggers.push(trigger);
    }

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
        'Price trigger specs are parsed from the commitment text itself. Do not invent trigger values.',
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
