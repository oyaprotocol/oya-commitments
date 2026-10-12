import { chmod, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';

export const intervalMs = 60 * 60 * 1000;

export async function initialize(keyPath, configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (![11155111, 31337].includes(config.chainId) || !Array.isArray(config.allowedSigners)) {
        throw new Error('Testing requires Sepolia or Anvil and an existing signer allowlist.');
    }
    let key;
    try { key = await readFile(keyPath, 'utf8'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        key = Wallet.createRandom().privateKey;
        await writeFile(keyPath, `${key}\n`, { flag: 'wx', mode: 0o600 });
    }
    const wallet = new Wallet(key.trim());
    await chmod(keyPath, 0o600);
    if (!config.allowedSigners.some(address => address.toLowerCase() === wallet.address.toLowerCase())) {
        config.allowedSigners.push(wallet.address);
        await chmod(configPath, 0o600);
        // Preserve the inode: the stopped node's config may already be bind-mounted.
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    return wallet.address;
}

export async function runAgent(wallet, { timeoutMs = 210_000, signal, fetch = globalThis.fetch,
    wait = delay, now = () => performance.now(), log = console.log } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid request deadline.');
    while (!signal.aborted) {
        const started = now();
        const text = `Hourly test message ${new Date().toISOString()} ${randomUUID()}`;
        let response;
        try {
            const signature = await wallet.signMessage(text);
            if (signal.aborted) return 0;
            // A stop signal cancels the hourly wait, but drains an admitted publication.
            response = await fetch('http://node:8787/v1/messages', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, signer: wallet.address, signature }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const result = await response.json();
            const publication = result.publication;
            if (response.status !== 200 || result.status !== 'logged' || publication?.status !== 'logged'
                || typeof publication.cid !== 'string'
                || !/^[a-zA-Z0-9]{1,128}$/.test(publication.cid)
                || !/^0x[0-9a-fA-F]{64}$/.test(publication.transactionHash)) throw new Error();
            log(JSON.stringify({ event: 'test_message_logged', signer: wallet.address,
                cid: publication.cid, transactionHash: publication.transactionHash }));
        } catch {
            log(JSON.stringify({ event: 'test_agent_stopped', httpStatus: response?.status,
                reason: 'Publication was not confirmed. Inspect node logs and Ledger before restarting; no retry was made.' }));
            return 1;
        }
        try {
            await wait(Math.max(0, intervalMs - (now() - started)), undefined, { signal });
        } catch (error) {
            if (!signal.aborted) throw error;
        }
    }
    return 0;
}

export async function main(args) {
    const stopped = new AbortController();
    const stop = () => stopped.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        const [action, keyPath, value] = args;
        if (args.length !== 3 || !keyPath || !value) throw new Error();
        if (action === 'init') {
            console.log(`Test agent address: ${await initialize(keyPath, value)}`);
            return 0;
        }
        if (action !== 'run') throw new Error();
        const wallet = new Wallet((await readFile(keyPath, 'utf8')).trim());
        return await runAgent(wallet, { timeoutMs: Number(value), signal: stopped.signal });
    } catch {
        console.error('Test agent failed. Check the key file, testnet configuration, and command arguments.');
        return 1;
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await main(process.argv.slice(2));
}
