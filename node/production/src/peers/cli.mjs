import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { readBounded } from './config.mjs';
import { signPeer } from './protocol.mjs';
import { inspectEnvelope, sendPeer } from './client.mjs';

export async function saveEnvelope(file, envelope) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(envelope) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await open(dirname(resolve(file)), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
}
export async function main(args = process.argv.slice(2)) {
    const [command, ...values] = args;
    if (command === 'prepare' && values.length === 7) {
        const [networkId, receiver, target, textFile, keyFile, expiresAt, output] = values;
        const key = (await readBounded(keyFile, 256)).trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid key file.');
        const envelope = await signPeer(new Wallet(key), { networkId, receiver, target,
            text: await readBounded(textFile, 8192), expiresAt: Number(expiresAt) });
        inspectEnvelope(envelope, true);
        await saveEnvelope(output, envelope);
        console.log(JSON.stringify({ status: 'prepared', requestId: envelope.requestId }));
    } else if (['submit', 'status'].includes(command) && values.length === 2) {
        const [origin, file] = values;
        const bytes = await readBounded(file, 65536);
        console.log(JSON.stringify(await sendPeer(origin, bytes, command)));
    } else throw new Error('Usage: prepare NETWORK RECEIVER TARGET TEXT_FILE KEY_FILE EXPIRY_MS OUTPUT | submit|status ORIGIN ENVELOPE_FILE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(() => { console.error('Peer command failed. Check inputs; preserve saved envelope and query status after uncertain submission.'); process.exitCode = 1; });
}
