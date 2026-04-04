// Search Polymarket for WTI Crude Oil markets
const searchTerms = ['WTI', 'crude oil', 'oil price'];

for (const term of searchTerms) {
    console.log(`\n=== Searching: "${term}" ===`);
    try {
        const res = await fetch(`https://clob.polymarket.com/markets?next_cursor=LTE%3D&limit=10&active=true&closed=false&query=${encodeURIComponent(term)}`);
        if (!res.ok) {
            console.log(`  Status: ${res.status}`);
            continue;
        }
        const data = await res.json();
        const markets = data?.data ?? data ?? [];
        if (Array.isArray(markets) && markets.length > 0) {
            for (const m of markets) {
                console.log(`\n  Market: ${m.question || m.description || 'N/A'}`);
                console.log(`  Condition ID: ${m.condition_id}`);
                console.log(`  Active: ${m.active}, Closed: ${m.closed}`);
                if (m.tokens && Array.isArray(m.tokens)) {
                    for (const t of m.tokens) {
                        console.log(`    Token: ${t.outcome} id=${t.token_id}`);
                    }
                }
            }
        } else {
            console.log('  No results');
        }
    } catch(e) {
        console.log(`  Error: ${e.message}`);
    }
}

// Also try the gamma API
console.log('\n=== Gamma API search ===');
try {
    const res = await fetch('https://gamma-api.polymarket.com/markets?limit=10&active=true&closed=false&q=WTI%20crude%20oil');
    if (res.ok) {
        const markets = await res.json();
        for (const m of markets) {
            console.log(`\n  Market: ${m.question}`);
            console.log(`  Condition ID: ${m.conditionId}`);
            console.log(`  Slug: ${m.slug}`);
            if (m.clobTokenIds) console.log(`  CLOB Token IDs: ${m.clobTokenIds}`);
            if (m.outcomes) console.log(`  Outcomes: ${m.outcomes}`);
        }
    }
} catch(e) {
    console.log(`  Error: ${e.message}`);
}
