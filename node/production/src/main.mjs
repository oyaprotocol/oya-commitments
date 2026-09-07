import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { loadConfig } from './config.mjs';
import { createLocalSigner } from './signer.mjs';
import { openStore } from './store.mjs';
import { createPublisher } from './publication.mjs';
import { createNodeServer } from './server.mjs';

export async function startNode(config, signer) {
    const rpc = async (method, params = []) => (await requestEthereumJsonRpc({
        config: config.rpc, fetch: globalThis.fetch, method, params,
    })).result;
    if (BigInt(await rpc('eth_chainId')) !== BigInt(config.chainId)) throw new Error('RPC chain ID does not match configuration.');
    const code = await rpc('eth_getCode', [config.loggerContract, 'latest']);
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || code === '0x0') {
        throw new Error('No contract bytecode exists at loggerContract.');
    }
    const store = await openStore(config.stateDir, {
        version: 1, chainId: config.chainId,
        loggerContract: config.loggerContract.toLowerCase(), nodeAddress: signer.address.toLowerCase(),
    });
    try {
        const publisher = createPublisher({ config, signer, store });
        try { await publisher.recover(); } catch {
            console.error(JSON.stringify({ event: 'recovery_required', ...publisher.status() }));
        }
        const server = createNodeServer({ config, publisher, nodeAddress: signer.address });
        await new Promise((resolveListening, reject) => {
            server.once('error', reject);
            server.listen(config.port, config.host, resolveListening);
        });
        return {
            server,
            async close() {
                await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
                await publisher.waitForIdle();
                await store.close();
            },
        };
    } catch (error) {
        await store.close();
        throw error;
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: npm start -- /absolute/path/to/config.json');
    const config = await loadConfig(args[0]);
    const signer = createLocalSigner(process.env.OYA_NODE_PRIVATE_KEY);
    const runtime = await startNode(config, signer);
    console.log(JSON.stringify({
        event: 'listening', host: config.host, port: config.port, chainId: config.chainId,
        loggerContract: config.loggerContract, nodeAddress: signer.address,
    }));
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        // Drain accepted work so state is not discarded when the client disconnects.
        runtime.close().catch(() => { process.exitCode = 1; });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => {
        // RPC URLs, IPFS headers, and wallet errors may contain secrets.
        console.error('Node startup failed. Check config, signer, RPC/Logger availability, and the state-directory lock.');
        process.exitCode = 1;
    });
}
