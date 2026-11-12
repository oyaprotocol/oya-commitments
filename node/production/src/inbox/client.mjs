import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { signJob } from './protocol.mjs';
import { inboxUrl, readJson } from './config.mjs';
import { createInboxClient } from './http.mjs';

async function saveNew(path, content) {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function readMessage(path) {
    const file = await open(path, 'r');
    try {
        // One extra byte detects oversized input without loading the whole file.
        const buffer = Buffer.alloc(8193);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) return buffer.subarray(0, size).toString('utf8');
            size += bytesRead;
        }
        throw new Error('Message too large.');
    } finally { await file.close(); }
}
export async function main(args = process.argv.slice(2)) {
    const [command, ...rest] = args;
    if (command === 'evidence') {
        const { main: verify } = await import('../verify-ledger.mjs');
        await verify(rest);
    } else if (command === 'keygen' && rest.length === 1) {
        const wallet = Wallet.createRandom();
        await saveNew(rest[0], wallet.privateKey + '\n');
        console.log(JSON.stringify({ address: wallet.address }));
    } else if (command === 'prepare' && rest.length === 4) {
        const [keyFile, target, textFile, jobFile] = rest;
        const wallet = new Wallet((await readFile(keyFile, 'utf8')).trim());
        const text = await readMessage(textFile);
        if (!text.length || !/^[\x01-\x7f]+$/.test(text)) throw new Error('Message must be nonempty ASCII text without NUL.');
        if (Buffer.byteLength(text) > 8192) throw new Error('Message too large.');
        const job = await signJob(wallet, target, text);
        await saveNew(jobFile, JSON.stringify(job, null, 2) + '\n');
        console.log(JSON.stringify({ requestId: job.requestId, expiresAt: job.expiresAt }));
    } else if (['submit', 'status'].includes(command) && rest.length === 2) {
        const [url, jobFile] = rest;
        const result = await createInboxClient(inboxUrl(url))(`/v1/${command === 'submit' ? 'jobs' : 'status'}`, await readJson(jobFile));
        console.log(JSON.stringify(result, null, 2));
    } else throw new Error('Usage: client keygen KEY_FILE | prepare KEY_FILE TARGET TEXT_FILE JOB_FILE | submit|status INBOX_URL JOB_FILE | evidence LOG_FILE SETTINGS_FILE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`Inbox client failed${error.status ? ` (HTTP ${error.status})` : ''}. Check arguments, file access, signatures and service availability.`);
        process.exitCode = 1;
    });
}
