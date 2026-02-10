import assert from 'node:assert/strict';
import { loadOptimisticGovernorDefaults } from '../src/lib/og.js';

const COLLATERAL_CHECKSUM = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const COLLATERAL_LOWER = COLLATERAL_CHECKSUM.toLowerCase();
const OG_MODULE = '0x0000000000000000000000000000000000000001';

async function run() {
    const trackedAssets = new Set([COLLATERAL_LOWER]);
    const publicClient = {
        readContract: async () => COLLATERAL_CHECKSUM,
    };

    await loadOptimisticGovernorDefaults({
        publicClient,
        ogModule: OG_MODULE,
        trackedAssets,
    });

    assert.equal(trackedAssets.size, 1);
    assert.equal(trackedAssets.has(COLLATERAL_LOWER), true);

    console.log('[test] tracked asset normalization OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
