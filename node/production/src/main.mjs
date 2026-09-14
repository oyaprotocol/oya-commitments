import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTransactionPreparer, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { hasBytecode } from './bytecode.mjs';
import { loadConfig } from './config.mjs';
import { createLocalSigner } from './signer.mjs';
import { createNodeServer } from './server.mjs';

export async function startNode(config, signer, {
    fetch = globalThis.fetch, log = (record) => console.log(JSON.stringify(record)), handleSignals = false,
} = {}) {
    const rpc = async (method, params = []) => (await requestEthereumJsonRpc({
        config: config.rpc, fetch, method, params,
    })).result;
    if (BigInt(await rpc('eth_chainId')) !== BigInt(config.chainId)) throw new Error('RPC chain ID does not match configuration.');
    if (!hasBytecode(await rpc('eth_getCode', [config.ledgerContract, 'latest']))) {
        throw new Error('No contract bytecode exists at ledgerContract.');
    }
    const transactionPreparer = createTransactionPreparer({
        config: config.rpc, fetch, chainId: config.chainId, signer, limits: config.limits,
    });
    const runtime = createNodeServer({ config, transactionPreparer, nodeAddress: signer.address, fetch, log });
    await new Promise((resolveListening, reject) => {
        runtime.server.once('error', reject);
        runtime.server.listen(config.port, config.host, resolveListening);
    });
    if (handleSignals) {
        const logLifecycle = (record) => {
            try { log(record); } catch {
                // A failed output sink must not abort startup or prevent shutdown.
            }
        };
        const signals = ['SIGINT', 'SIGTERM'];
        const close = runtime.close;
        let stopping = false;
        const stop = () => {
            if (stopping) return;
            stopping = true;
            logLifecycle({ event: 'stopping', message: 'Stopping node; waiting for active work to finish.' });
            runtime.close().catch(() => { process.exitCode = 1; });
        };
        // Keep handlers until accepted work drains, even if its client already disconnected.
        runtime.close = () => close().finally(() => {
            for (const signal of signals) process.off(signal, stop);
        });
        for (const signal of signals) process.on(signal, stop);
        logLifecycle({ event: 'listening', host: config.host, port: config.port, chainId: config.chainId,
            ledgerContract: config.ledgerContract, nodeAddress: signer.address });
    }
    return runtime;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: node node/production/src/main.mjs /absolute/path/to/config.json');
    const config = await loadConfig(args[0]);
    const signer = createLocalSigner(process.env.OYA_NODE_PRIVATE_KEY);
    await startNode(config, signer, { handleSignals: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => {
        // RPC URLs, IPFS headers, and wallet errors may contain secrets.
        console.error('Node startup failed. Check config, signer, and RPC/Ledger availability.');
        process.exitCode = 1;
    });
}
