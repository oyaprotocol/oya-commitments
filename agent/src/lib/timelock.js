const MONTHS_REGEX =
    '(January|February|March|April|May|June|July|August|September|October|November|December)';

const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
};

function parseNumber(value) {
    if (!value) return null;
    const trimmed = value.trim().toLowerCase();
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
    }
    return NUMBER_WORDS[trimmed] ?? null;
}

function unitToMs(unit) {
    switch (unit.toLowerCase()) {
        case 'minute':
        case 'minutes':
            return 60_000;
        case 'hour':
        case 'hours':
            return 3_600_000;
        case 'day':
        case 'days':
            return 86_400_000;
        default:
            return null;
    }
}

function extractAbsoluteTimelocks(rulesText) {
    if (!rulesText) return [];
    const regex = new RegExp(
        `(after|on or after)\\s+${MONTHS_REGEX}\\s+\\d{1,2},\\s+\\d{4}[^.\\n]*`,
        'gi'
    );
    const matches = [];
    let match;
    while ((match = regex.exec(rulesText)) !== null) {
        const phrase = match[0];
        const raw = phrase.replace(/^(after|on or after)\s+/i, '').trim();
        const trimmed = raw.replace(/[\s.]+$/g, '');
        const hasTimezone = /\b(PST|PDT|UTC|GMT|Z)\b/i.test(trimmed);
        let parsed = Date.parse(trimmed);
        if (!Number.isFinite(parsed)) {
            const cleaned = trimmed.replace(/\s+(PST|PDT|UTC|GMT)\b/i, '');
            parsed = Date.parse(cleaned);
        }
        if (!Number.isFinite(parsed)) {
            const dateOnlyMatch = cleanedDateOnly(trimmed);
            if (dateOnlyMatch) {
                parsed = Date.parse(dateOnlyMatch);
            }
        }
        if (!hasTimezone && Number.isFinite(parsed)) {
            const hasTime = /\b\d{1,2}:\d{2}(\s*[AP]M)?\b/i.test(trimmed);
            const dateOnlyMatch = hasTime ? null : cleanedDateOnly(trimmed);
            const withUtc = dateOnlyMatch
                ? `${dateOnlyMatch} 00:00 UTC`
                : `${trimmed} UTC`;
            const utcParsed = Date.parse(withUtc);
            if (Number.isFinite(utcParsed)) {
                parsed = utcParsed;
            }
        }
        if (Number.isFinite(parsed)) {
            matches.push({
                kind: 'absolute',
                timestampMs: parsed,
                source: phrase,
            });
        }
    }
    return matches;
}

function cleanedDateOnly(text) {
    const dateOnly = new RegExp(`${MONTHS_REGEX}\\s+\\d{1,2},\\s+\\d{4}`, 'i');
    const match = text.match(dateOnly);
    return match ? match[0] : null;
}

function extractRelativeTimelocks(rulesText) {
    if (!rulesText) return [];
    const regex = /(\d+|\w+)\s*(minute|minutes|hour|hours|day|days)\s+after\s+deposit/gi;
    const matches = [];
    let match;
    while ((match = regex.exec(rulesText)) !== null) {
        const amount = parseNumber(match[1]);
        const unitMs = unitToMs(match[2]);
        if (!amount || !unitMs) continue;
        matches.push({
            kind: 'relative',
            offsetMs: amount * unitMs,
            anchor: 'deposit',
            source: match[0],
        });
    }
    return matches;
}

function extractTimelockTriggers({ rulesText, deposits }) {
    const triggers = [];
    const absolute = extractAbsoluteTimelocks(rulesText);
    for (const lock of absolute) {
        triggers.push({
            id: `absolute:${lock.timestampMs}`,
            kind: 'absolute',
            timestampMs: lock.timestampMs,
            source: lock.source,
        });
    }

    const relative = extractRelativeTimelocks(rulesText);
    if (relative.length > 0 && Array.isArray(deposits)) {
        for (const deposit of deposits) {
            if (!deposit?.timestampMs) continue;
            for (const rule of relative) {
                const ts = deposit.timestampMs + rule.offsetMs;
                triggers.push({
                    id: `relative:${deposit.id ?? deposit.transactionHash ?? deposit.blockNumber}:${rule.offsetMs}`,
                    kind: 'relative',
                    timestampMs: ts,
                    source: rule.source,
                    anchor: 'deposit',
                    deposit,
                });
            }
        }
    }

    return triggers;
}

export { extractTimelockTriggers };
