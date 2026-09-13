import { createTimeoutSignal, invokeWithAbort } from '@oyaprotocol/utils';
import { localUrl } from './local-config.mjs';

export async function statusLocalNode({ config, nodeAddress }, {
    fetch = globalThis.fetch, log = console.log, timeoutMs = 5000,
} = {}) {
    const fail = (message) => { log(`FAIL ${message}`); return 1; };
    const timeout = createTimeoutSignal(timeoutMs);
    let response;
    let health;
    try {
        health = await invokeWithAbort(async () => {
            response = await fetch(`${localUrl(config)}/healthz`, { signal: timeout.signal, redirect: 'error' });
            return response.json();
        }, timeout.signal);
    } catch {
        return fail(timeout.signal.aborted ? `Node health timed out after ${timeoutMs / 1000}s.`
            : response ? 'Could not read a valid node health response.' : 'Node is unreachable. Check whether it is running.');
    } finally {
        timeout.cleanup();
    }
    const running = health?.status === 'ready' || health?.status === 'busy';
    const unavailable = health?.status === 'shutting_down' || health?.status === 'transaction_outcome_unknown';
    if ((!running && !unavailable) || response.status !== (running ? 200 : 503)
        || typeof health.busy !== 'boolean' || (running && health.busy !== (health.status === 'busy'))
        || !Number.isSafeInteger(health.chainId) || health.chainId < 1
        || !/^0x[0-9a-fA-F]{40}$/.test(health.loggerContract ?? '')
        || !/^0x[0-9a-fA-F]{40}$/.test(health.nodeAddress ?? '')
        || typeof health.loggerContract !== 'string' || typeof health.nodeAddress !== 'string') {
        return fail('Malformed node health response. Check the service at the configured local port.');
    }
    if (health.chainId !== config.chainId || health.loggerContract.toLowerCase() !== config.loggerContract.toLowerCase()
        || health.nodeAddress.toLowerCase() !== nodeAddress.toLowerCase()) {
        return fail('Node identity mismatch. Check the configured chain, Logger, node key, and local port.');
    }
    log(`${running ? 'OK' : 'FAIL'} ${health.status} at ${localUrl(config)}; node ${nodeAddress}; chain ${config.chainId}; Logger ${config.loggerContract}.`);
    if (health.status === 'transaction_outcome_unknown') {
        log('Inspect the prior transaction before restarting or retrying.');
    }
    return running ? 0 : 1;
}
