import assert from 'node:assert/strict';
import { extractTimelockTriggers } from '../../../agent/src/lib/timelock.js';

function run() {
    const rulesAbsolute =
        'Funds may be withdrawn after January 15, 2026 12:00AM PST.';
    const absTriggers = extractTimelockTriggers({ rulesText: rulesAbsolute, deposits: [] });
    assert.equal(absTriggers.length, 1);
    assert.equal(absTriggers[0].kind, 'absolute');
    assert.ok(absTriggers[0].timestampMs > 0);

    const rulesRelative =
        'Funds may be withdrawn five minutes after deposit.';
    const deposits = [
        {
            id: 'dep1',
            timestampMs: Date.UTC(2025, 0, 1, 0, 0, 0),
        },
    ];
    const relTriggers = extractTimelockTriggers({ rulesText: rulesRelative, deposits });
    assert.equal(relTriggers.length, 1);
    assert.equal(relTriggers[0].kind, 'relative');
    assert.equal(relTriggers[0].timestampMs, deposits[0].timestampMs + 5 * 60 * 1000);

    console.log('[test] timelock parsing OK');
}

run();
