import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { id } from 'ethers';
import { evidenceJson, ledgerEvidenceSettings, readEvidenceBytes, readEvidenceJson } from './ledger-evidence.mjs';

const topic = id('Log(address,bytes32,string)');
const hex = n => `0x${n.toString(16)}`;
function quantity(value) {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(value)) throw new Error('Invalid quantity');
    const n = Number(BigInt(value));
    if (!Number.isSafeInteger(n)) throw new Error('Unsafe quantity');
    return n;
}

export async function discoverLedger(from, to, input) {
    if (![from, to].every(n => Number.isSafeInteger(n) && n >= 0) || to < from || to - from >= 1024) {
        throw new Error('Choose an inclusive range of 1 to 1024 blocks');
    }
    const config = ledgerEvidenceSettings(input);
    const signal = AbortSignal.timeout(config.timeoutMs);
    let seq = 0;
    async function rpc(method, params) {
        const request = { jsonrpc: '2.0', id: ++seq, method, params };
        const reply = evidenceJson(await readEvidenceBytes(config.rpc, '', request, signal, config.requestTimeoutMs));
        if (reply?.jsonrpc !== '2.0' || reply.id !== seq || !Object.hasOwn(reply, 'result') || Object.hasOwn(reply, 'error')) throw new Error('Invalid RPC response');
        return reply.result;
    }
    if (quantity(await rpc('eth_chainId', [])) !== config.chainId) throw new Error('Wrong chain');
    if (quantity(await rpc('eth_blockNumber', [])) < to) throw new Error('Range beyond head');
    const logs = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: config.ledgerContract, topics: [topic] }]);
    if (!Array.isArray(logs)) throw new Error('Expected logs');
    const positions = new Set();
    return logs.map(log => {
        const block = quantity(log.blockNumber), logIndex = quantity(log.logIndex);
        const key = `${block}:${logIndex}`;
        if (block < from || block > to || positions.has(key) || log.address?.toLowerCase() !== config.ledgerContract ||
            !Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== topic ||
            (log.removed !== undefined && log.removed !== false) || typeof log.transactionHash !== 'string' ||
            !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) throw new Error('Inconsistent log response');
        positions.add(key);
        return { block, record: { transactionHash: log.transactionHash.toLowerCase(), logIndex } };
    }).sort((a, b) => a.block - b.block || a.record.logIndex - b.record.logIndex).map(entry => entry.record);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [from, to, settings, ...extra] = process.argv.slice(2);
    try {
        if (extra.length || !settings || ![from, to].every(v => /^(0|[1-9][0-9]*)$/.test(v))) throw new Error();
        console.log(JSON.stringify(await discoverLedger(Number(from), Number(to), await readEvidenceJson(settings)), null, 2));
    } catch {
        console.error('Discovery failed. Check the decimal block range, verifier settings and RPC availability. Retry a smaller range if needed.');
        process.exitCode = 1;
    }
}
