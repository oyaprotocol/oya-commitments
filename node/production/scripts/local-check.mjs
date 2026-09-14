import { parseTransactionQuantity, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { createTimeoutSignal, invokeWithAbort } from '@oyaprotocol/utils';
import { hasBytecode } from '../src/bytecode.mjs';

export async function checkLocalNode({ config, nodeAddress }, {
    fetch = globalThis.fetch, log = console.log, timeoutMs = 10_000,
} = {}) {
    const fail = (message) => { log(`FAIL ${message}`); return 1; };
    log(`Node ${nodeAddress}; chain ${config.chainId}; Ledger ${config.ledgerContract}.`);

    const rpc = async (method, params, signal) => (await requestEthereumJsonRpc({
        config: config.rpc, fetch, method, params, signal,
    })).result;
    const checks = [
        ['Ethereum chain', 'Check RPC availability, authorization, and chainId.', async (signal) =>
            parseTransactionQuantity(await rpc('eth_chainId', [], signal), 'eth_chainId result') === BigInt(config.chainId)],
        ['Ledger bytecode', 'Check ledgerContract and deploy Ledger on the selected chain.', async (signal) =>
            hasBytecode(await rpc('eth_getCode', [config.ledgerContract, 'latest'], signal))],
        ['Node gas balance', 'Check RPC availability and fund the node address with native currency.', async (signal) => {
            const balance = parseTransactionQuantity(await rpc('eth_getBalance', [nodeAddress, 'latest'], signal), 'eth_getBalance result');
            return balance > 0n;
        }],
        ['IPFS API', 'Check the Kubo API endpoint and its authorization.', async (signal) => {
            const response = await fetch(`${config.ipfs.url}/api/v0/version`, {
                method: 'POST', headers: config.ipfs.headers, signal,
            });
            const body = await response.json();
            return response.ok && typeof body?.Version === 'string' && body.Version.trim().length > 0;
        }],
    ];
    for (const [name, advice, run] of checks) {
        const timeout = createTimeoutSignal(timeoutMs);
        let passed = false;
        try {
            passed = await invokeWithAbort(() => run(timeout.signal), timeout.signal);
        } catch {
            // Provider errors, response bodies, and URLs may contain credentials.
        } finally {
            timeout.cleanup();
        }
        if (!passed) return fail(`${name}. ${advice} Each probe has a ${timeoutMs / 1000}s deadline.`);
        log(`OK ${name}.`);
    }
    log('Read-only checks passed.');
    return 0;
}
