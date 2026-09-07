import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';

try {
    const [nodeUrl, textPath] = process.argv.slice(2);
    if (!nodeUrl || !textPath || process.argv.length !== 4) throw new Error();
    const wallet = new Wallet(process.env.OYA_AGENT_PRIVATE_KEY);
    const text = await readFile(textPath, 'utf8');
    if (!text.length || !/^[\x00-\x7f]+$/.test(text)) throw new Error();
    const response = await fetch(`${nodeUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, signer: wallet.address, signature: await wallet.signMessage(text) }),
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    if (response.status !== 202) process.exitCode = 1;
} catch {
    console.error('Could not submit message. Supply OYA_AGENT_PRIVATE_KEY, a node URL, and a nonempty ASCII text file.');
    process.exitCode = 1;
}
