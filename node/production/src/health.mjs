export function workerFreshness(lastPollAt, operationTimeoutMs, now = Date.now()) {
    if (typeof lastPollAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(lastPollAt)) return 'malformed';
    const timestamp = Date.parse(lastPollAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== lastPollAt) return 'malformed';
    if (timestamp - now > 5000) return 'future';
    return now - timestamp < operationTimeoutMs + 60000 ? 'fresh' : 'stale';
}

export function workerHealthy(state, config, now = Date.now()) {
    return ['idle', 'processing'].includes(state.status) &&
        workerFreshness(state.lastPollAt, config.operationTimeoutMs, now) === 'fresh';
}

// Return only controlled codes; callers never forward health bodies or errors.
export function validateHealth(health, httpStatus, expected, now = Date.now()) {
    const invalid = code => ({ code, verified: false, healthy: false });
    if (!health || typeof health !== 'object' || Array.isArray(health)) return invalid('malformed');
    const worker = expected.role === 'worker';
    // Legacy direct nodes predate the role field, but have a distinct busy schema.
    if ((health.role === undefined && !worker ? 'direct' : health.role) !== expected.role ||
        (!worker && Object.hasOwn(health, 'target'))) return invalid('identity_mismatch');
    const mode = health.mode === undefined && !worker ? 'ledger' : health.mode;
    if (mode !== expected.mode || (worker && health.target !== expected.target)) return invalid('identity_mismatch');
    if (expected.mode === 'ledger') {
        const fields = ['chainId', 'ledgerContract', 'nodeAddress'];
        if (worker && fields.some(key => !Object.hasOwn(health, key))) return invalid('legacy_unverified');
        if (health.chainId !== expected.chainId || ['ledgerContract', 'nodeAddress'].some(key =>
            typeof health[key] !== 'string' || health[key].toLowerCase() !== expected[key].toLowerCase())) {
            return invalid('identity_mismatch');
        }
    } else if (['chainId', 'ledgerContract', 'nodeAddress'].some(key => Object.hasOwn(health, key))) {
        return invalid('identity_mismatch');
    }
    const healthyStates = worker ? ['idle', 'processing'] : ['ready', 'busy'];
    const unhealthyStates = worker ? ['starting', 'retrying', 'inbox_unavailable', 'shutting_down', 'stopped']
        : ['starting', 'shutting_down', 'stopped', 'transaction_outcome_unknown', 'batch_blocked'];
    const running = healthyStates.includes(health.status);
    if (!running && !unhealthyStates.includes(health.status)) return invalid('malformed');
    if (!worker && (typeof health.busy !== 'boolean' || (running && health.busy !== (health.status === 'busy')))) {
        return invalid('malformed');
    }
    if (expected.mode === 'ipfs' && ['transaction_outcome_unknown', 'batch_blocked'].includes(health.status)) return invalid('malformed');
    if (worker && (running || Object.hasOwn(health, 'lastPollAt'))) {
        const freshness = workerFreshness(health.lastPollAt, expected.operationTimeoutMs, now);
        if (freshness === 'future' || freshness === 'malformed' || (running && freshness === 'stale')) {
            return { code: freshness, verified: true, healthy: false };
        }
    }
    if (httpStatus !== (running ? 200 : 503)) return invalid('malformed');
    return { code: health.status, verified: true, healthy: running };
}
