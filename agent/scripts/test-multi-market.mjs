/**
 * Quick test to check if the multi-market agent's fetchLatestSourceTrade works.
 *
 * Usage:
 *   cd ~/oya-commitments && node agent/scripts/test-multi-market.mjs
 */

const DATA_API_HOST = 'https://data-api.polymarket.com';
const GAMMA_API_HOST = 'https://gamma-api.polymarket.com';
const SOURCE_USER = '0x777fae71d2ff9ec48a1213d48ba1d9d91024a1bb'; // Albert1953

async function testFetchTrades() {
    console.log('--- Testing Data API (fetch trades without market filter) ---');
    const params = new URLSearchParams({
        user: SOURCE_USER,
        limit: '5',
        offset: '0',
    });
    params.set('type', 'TRADE');

    try {
        const url = `${DATA_API_HOST}/activity?${params.toString()}`;
        console.log('Fetching:', url);
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        console.log('Status:', response.status);
        const data = await response.json();
        console.log('Results:', data.length, 'trades');
        if (data.length > 0) {
            const first = data[0];
            console.log('Latest trade:', JSON.stringify(first, null, 2));
            console.log('conditionId:', first.conditionId);

            if (first.slug) {
                console.log('\n--- Testing Gamma API by SLUG ---');
                const gammaUrl = `${GAMMA_API_HOST}/markets?slug=${encodeURIComponent(first.slug)}`;
                console.log('Fetching:', gammaUrl);
                const gammaResponse = await fetch(gammaUrl, { signal: AbortSignal.timeout(10_000) });
                console.log('Status:', gammaResponse.status);
                const gammaData = await gammaResponse.json();
                console.log('Full Gamma response (first 500 chars):', JSON.stringify(gammaData).substring(0, 500));
                const market = Array.isArray(gammaData) ? gammaData[0] : gammaData;
                if (market) {
                    console.log('Market question:', market.question);
                    console.log('Tokens field:', JSON.stringify(market.tokens, null, 2));
                    console.log('clobTokenIds:', market.clobTokenIds);
                    // Check all keys that might contain token IDs
                    const tokenKeys = Object.keys(market).filter(k =>
                        k.toLowerCase().includes('token') || k.toLowerCase().includes('clob')
                    );
                    console.log('Token-related keys:', tokenKeys);
                    for (const key of tokenKeys) {
                        console.log(`  ${key}:`, JSON.stringify(market[key]));
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testFetchTrades();
