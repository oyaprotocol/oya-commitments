import { readFile } from 'node:fs/promises';

const registry = new URL('../peers/testnet-directory.json', import.meta.url);
const upstream = 'https://raw.githubusercontent.com/oyaprotocol/oya-commitments/main/node/production/peers/testnet-directory.json';
const [command = 'list', ...args] = process.argv.slice(2);

if (!((command === 'list' && args.length <= 1) || (command === 'fetch' && args.length === 0))) {
    console.error('Usage: peer-directory.mjs [list [FILE] | fetch]');
    process.exitCode = 2;
} else {
    try {
        let text;
        if (command === 'fetch') {
            const response = await fetch(upstream, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error('Download failed');
            text = await response.text();
        } else {
            text = await readFile(args[0] ?? registry, 'utf8');
        }
        const nodes = JSON.parse(text);
        // Catch accidental file/response errors; repository review establishes trust.
        if (!Array.isArray(nodes) || !nodes.every(node => node &&
            ['nodeAddress', 'receiveUrl', 'target'].every(key => typeof node[key] === 'string' && node[key].length > 0))) {
            throw new Error('Expected node records');
        }
        console.log(JSON.stringify(nodes, null, 2));
    } catch {
        console.error('Unable to load peer registry. Check the file or retry the upstream fetch.');
        process.exitCode = 1;
    }
}
