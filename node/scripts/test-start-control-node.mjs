import assert from 'node:assert/strict';
import { resolveToolExecutionOgContext } from './start-control-node.mjs';

const TEST_OG_MODULE = '0x1111111111111111111111111111111111111111';
const TEST_COLLATERAL = '0x2222222222222222222222222222222222222222';
const TEST_OPTIMISTIC_ORACLE = '0x3333333333333333333333333333333333333333';
const TEST_IDENTIFIER =
    '0x4444444444444444444444444444444444444444444444444444444444444444';

function buildMockPublicClient(readCalls) {
    return {
        async readContract({ address, functionName }) {
            assert.equal(address, TEST_OG_MODULE);
            readCalls.push(functionName);
            switch (functionName) {
                case 'collateral':
                    return TEST_COLLATERAL;
                case 'bondAmount':
                    return 123n;
                case 'optimisticOracleV3':
                    return TEST_OPTIMISTIC_ORACLE;
                case 'rules':
                    return 'Test rules';
                case 'identifier':
                    return TEST_IDENTIFIER;
                case 'liveness':
                    return 7200n;
                default:
                    throw new Error(`Unexpected readContract(${functionName})`);
            }
        },
    };
}

async function run() {
    const readCalls = [];
    const publicClient = buildMockPublicClient(readCalls);

    const skippedContext = await resolveToolExecutionOgContext({
        toolCalls: [{ name: 'publish_signed_proposal' }],
        publicClient,
        ogModule: TEST_OG_MODULE,
        cachedOgContext: null,
    });
    assert.equal(skippedContext, null);
    assert.deepEqual(readCalls, []);

    const loadedContext = await resolveToolExecutionOgContext({
        toolCalls: [{ name: 'dispute_assertion' }],
        publicClient,
        ogModule: TEST_OG_MODULE,
        cachedOgContext: null,
    });
    assert.equal(loadedContext.collateral, TEST_COLLATERAL);
    assert.equal(loadedContext.optimisticOracle, TEST_OPTIMISTIC_ORACLE);
    assert.equal(loadedContext.bondAmount, 123n);
    assert.equal(loadedContext.identifier, TEST_IDENTIFIER);
    assert.equal(loadedContext.liveness, 7200n);
    assert.equal(readCalls.length, 6);

    const cachedReadCount = readCalls.length;
    const cachedContext = await resolveToolExecutionOgContext({
        toolCalls: [{ name: 'dispute_assertion' }],
        publicClient,
        ogModule: TEST_OG_MODULE,
        cachedOgContext: loadedContext,
    });
    assert.equal(cachedContext, loadedContext);
    assert.equal(readCalls.length, cachedReadCount);

    console.log('[test] start-control-node OG context resolution OK');
}

run().catch((error) => {
    console.error('[test] start-control-node OG context resolution failed:', error?.message ?? error);
    process.exit(1);
});
