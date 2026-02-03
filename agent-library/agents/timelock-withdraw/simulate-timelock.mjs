import { extractTimelockTriggers } from '../../../agent/src/lib/timelock.js';

function simulate({ rulesText, depositTimestampMs, nowMs }) {
    const deposits = [
        {
            id: 'dep1',
            timestampMs: depositTimestampMs,
        },
    ];

    const triggers = extractTimelockTriggers({ rulesText, deposits });
    const due = triggers.filter((trigger) => trigger.timestampMs <= nowMs);

    console.log('[sim] rules:', rulesText);
    console.log('[sim] depositTimestampMs:', depositTimestampMs);
    console.log('[sim] nowMs:', nowMs);
    console.log('[sim] triggers:', triggers);
    console.log('[sim] due:', due);
}

const rulesText =
    process.env.TIMELOCK_RULES ??
    'Funds may be withdrawn five minutes after deposit.';

const nowMs = Date.now();
const depositTimestampMs = nowMs - 10 * 60 * 1000;

simulate({ rulesText, depositTimestampMs, nowMs });
