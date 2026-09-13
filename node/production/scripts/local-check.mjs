import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { parseTransactionQuantity, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { createTimeoutSignal, invokeWithAbort } from '@oyaprotocol/utils';
import { loadConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';

export async function checkLocalNode(configPath, envPath, {
    env = process.env, fetch = globalThis.fetch, log = console.log, timeoutMs = 10_000,
} = {}) {
    const fail = (message) => { log(`FAIL ${message}`); return 1; };
    let selectedEnv;
    try {
        selectedEnv = { ...env, ...parseEnv(await readFile(envPath, 'utf8')) };
    } catch {
        return fail('Environment file. Check that the selected file exists and is readable.');
    }
    let config;
    try {
        config = await loadConfig(configPath, selectedEnv);
    } catch {
        return fail('Configuration. Check the JSON, chainId, loggerContract, allowedSigners, rpcUrl, and ipfsUrl.');
    }
    if (!['127.0.0.1', '::1'].includes(config.host)) {
        return fail('Local binding. Set host to 127.0.0.1 or ::1.');
    }
    let nodeAddress;
    try {
        nodeAddress = createLocalSigner(selectedEnv.OYA_NODE_PRIVATE_KEY).address;
    } catch {
        return fail('Node signing key. Set a valid OYA_NODE_PRIVATE_KEY in the selected file or environment.');
    }
    log(`Node ${nodeAddress}; chain ${config.chainId}; Logger ${config.loggerContract}.`);

    const rpc = async (method, params, signal) => (await requestEthereumJsonRpc({
        config: config.rpc, fetch, method, params, signal,
    })).result;
    const checks = [
        ['Ethereum chain', 'Check RPC availability, authorization, and chainId.', async (signal) =>
            parseTransactionQuantity(await rpc('eth_chainId', [], signal), 'eth_chainId result') === BigInt(config.chainId)],
        ['Logger bytecode', 'Check loggerContract and deploy Logger on the selected chain.', async (signal) => {
            const code = await rpc('eth_getCode', [config.loggerContract, 'latest'], signal);
            return typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code);
        }],
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
