import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';

let signal;
try {
    const timeoutMs = Number(process.env.OYA_MESSAGE_TIMEOUT_MS ?? 210_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error();
    const [nodeUrl, textPath] = process.argv.slice(2);
    if (!nodeUrl || !textPath || process.argv.length !== 4) throw new Error();
    const wallet = new Wallet(process.env.OYA_AGENT_PRIVATE_KEY);
    const text = await readFile(textPath, 'utf8');
    if (!text.length || !/^[\x01-\x7f]+$/.test(text)) throw new Error();
    const body = JSON.stringify({ text, signer: wallet.address, signature: await wallet.signMessage(text) });
    signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${nodeUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, signal, redirect: 'error',
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    if (response.status !== 200) process.exitCode = 1;
} catch {
    console.error(signal?.aborted
        ? 'Message request timed out. Publication may still complete; inspect the node outcome before retrying.'
        : 'Could not submit message. Check OYA_AGENT_PRIVATE_KEY, node URL, nonempty ASCII text file without NUL, and OYA_MESSAGE_TIMEOUT_MS (integer 1–2147483647).');
    process.exitCode = 1;
}
