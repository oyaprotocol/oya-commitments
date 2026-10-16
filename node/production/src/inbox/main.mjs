import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, parseInboxConfig, databaseOptions, token } from './config.mjs';
import { InboxStore } from './store.mjs';
import { createInboxServer } from './http.mjs';

export async function main(args = process.argv.slice(2)) {
    const [configFile, secretsFile, command] = args;
    if (!configFile || !secretsFile || (command && command !== 'prune') || args.length > 3) throw new Error('Usage: inbox CONFIG_JSON SECRETS_JSON [prune]');
    const config = parseInboxConfig(await readJson(configFile));
    const secrets = await readJson(secretsFile);
    const workerToken = token(secrets.workerToken);
    const store = new InboxStore(await databaseOptions(config, secrets), config);
    try { await store.initialize(); } catch (error) { await store.close(); throw error; }
    if (command === 'prune') {
        try { console.log(JSON.stringify(await store.prune())); } finally { await store.close(); }
        return;
    }
    const log = record => { try { console.log(JSON.stringify(record)); } catch {} };
    const server = createInboxServer({ config, workerToken, store, log });
    try {
        await new Promise((resolveListening, reject) => {
            server.once('error', reject);
            server.listen(config.port, config.host, resolveListening);
        });
    } catch (error) { await store.close(); throw error; }
    log({ event: 'inbox_listening', target: config.target, port: config.port });
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        server.close(() => { store.close().catch(() => { process.exitCode = 1; }); });
        server.closeIdleConnections();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => { console.error('Inbox startup failed. Check configuration, secrets and PostgreSQL availability.'); process.exitCode = 1; });
}
