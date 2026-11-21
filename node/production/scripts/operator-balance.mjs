import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const maxBytes = 65536;

// A shared signal bounds the entire observation, including DNS, headers and slow bodies.
async function quantity(profile, signal, id, method, params) {
    const url = new URL(profile.rpcUrl);
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (profile.authorization !== undefined) headers.authorization = profile.authorization;
    const options = { method: 'POST', headers, agent: false, signal, maxHeaderSize: 16384 };
    if (url.hostname === 'localhost') options.lookup = (_name, opts, done) => done(null,
        opts.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
    const incoming = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, resolve);
        request.on('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    try {
        if (incoming.statusCode !== 200 || Number(incoming.headers['content-length']) > maxBytes ||
            (incoming.headers['content-encoding'] ?? 'identity') !== 'identity') throw new Error();
        let size = 0;
        const chunks = [];
        for await (const chunk of incoming) {
            size += chunk.length;
            if (size > maxBytes) throw new Error();
            chunks.push(chunk);
        }
        const reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
        if (reply?.jsonrpc !== '2.0' || reply.id !== id || Object.hasOwn(reply, 'error') ||
            typeof reply.result !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(reply.result)) throw new Error();
        return BigInt(reply.result);
    } finally { incoming.destroy(); }
}

export async function operatorBalance(profile) {
    const { role, mode, nodeAddress, chainId = null } = profile;
    const snapshot = { version: 1, role, mode, chainId, nodeAddress, observedAt: null, blockNumber: null, balanceWei: null };
    if (mode === 'ipfs') return { ...snapshot, status: 'not_applicable' };
    const signal = AbortSignal.timeout(5000);
    try {
        const chain = await quantity(profile, signal, 1, 'eth_chainId', []);
        if (chain !== BigInt(chainId)) return { ...snapshot, status: 'wrong_chain' };
        const block = await quantity(profile, signal, 2, 'eth_blockNumber', []);
        const balance = await quantity(profile, signal, 3, 'eth_getBalance', [nodeAddress, `0x${block.toString(16)}`]);
        return { ...snapshot, observedAt: new Date().toISOString(), blockNumber: block.toString(),
            balanceWei: balance.toString(), status: 'observed' };
    } catch { return { ...snapshot, status: signal.aborted ? 'timeout' : 'unavailable' }; }
}

export function formatBalance(value) {
    if (value.mode === 'ipfs') return `${value.role} ipfs: native balance is not applicable.`;
    const identity = `${value.role} ledger: node ${value.nodeAddress} on chain ${value.chainId}`;
    return value.status === 'observed'
        ? `${identity}: ${value.balanceWei} wei at block ${value.blockNumber} (${value.observedAt})`
        : `${identity}: balance unknown (${value.status}).`;
}
