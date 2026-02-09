import { getAddress, zeroAddress } from 'viem';

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

function normalizeComparator(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === 'gte' || value === '>=') return 'gte';
    if (value === 'lte' || value === '<=') return 'lte';
    throw new Error(`Unsupported comparator in inferred trigger: ${raw}`);
}

function normalizeInferredTrigger(trigger, index) {
    if (!trigger || typeof trigger !== 'object') {
        throw new Error(`Inferred trigger at index ${index} is not an object.`);
    }

    const threshold = Number(trigger.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
        throw new Error(`Inferred trigger ${index} has invalid threshold.`);
    }

    const normalized = {
        id: trigger.id ? String(trigger.id) : `inferred-trigger-${index + 1}`,
        label: trigger.label ? String(trigger.label) : undefined,
        baseToken: getAddress(String(trigger.baseToken)),
        quoteToken: getAddress(String(trigger.quoteToken)),
        comparator: normalizeComparator(trigger.comparator),
        threshold,
        priority: Number.isFinite(Number(trigger.priority)) ? Number(trigger.priority) : index,
        emitOnce: trigger.emitOnce === undefined ? true : Boolean(trigger.emitOnce),
    };
    if (!Number.isInteger(normalized.priority) || normalized.priority < 0) {
        throw new Error(`Inferred trigger ${index} has invalid priority.`);
    }
    if (normalized.baseToken === normalized.quoteToken) {
        throw new Error(`Inferred trigger ${index} has identical base and quote token.`);
    }

    if (trigger.pool) {
        normalized.pool = getAddress(String(trigger.pool));
        if (normalized.pool === zeroAddress) {
            throw new Error(`Inferred trigger ${index} has zero-address pool.`);
        }
    } else {
        normalized.poolSelection = 'high-liquidity';
    }

    return normalized;
}

function sanitizeInferredTriggers(triggers) {
    const normalized = triggers.map(normalizeInferredTrigger);
    const seenIds = new Set();
    for (const trigger of normalized) {
        if (seenIds.has(trigger.id)) {
            throw new Error(`Duplicate inferred trigger id: ${trigger.id}`);
        }
        seenIds.add(trigger.id);
    }

    normalized.sort((a, b) => {
        const p = a.priority - b.priority;
        if (p !== 0) return p;
        return a.id.localeCompare(b.id);
    });

    return normalized;
}

async function inferPriceTriggersFromCommitment({ config, commitmentText }) {
    if (!config?.openAiApiKey || !commitmentText) {
        return [];
    }

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content:
                    'Extract price-trigger specifications from a plain-language commitment. Return strict JSON with shape {"triggers":[...]}. Each trigger must include: id, label, baseToken, quoteToken, comparator (gte|lte), threshold (number), priority (number), and optional pool (address). If pool is omitted, high-liquidity routing will be used. Use only information present in the commitment text and do not invent token addresses.',
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
    if (!raw) return [];

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Failed to parse inferred trigger JSON: ${raw}`);
    }

    const triggers = Array.isArray(parsed?.triggers) ? parsed.triggers : [];
    return sanitizeInferredTriggers(triggers);
}

export { inferPriceTriggersFromCommitment, sanitizeInferredTriggers };
