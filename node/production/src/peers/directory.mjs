import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { getAddress } from 'ethers';

export const MAX_DIRECTORY_BYTES = 256 * 1024;
export const MAX_DIRECTORY_NODES = 256;
export class DirectoryError extends Error {
    constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DirectoryError(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fullMatch = (pattern, value) => typeof value === 'string' && pattern.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function fields(value, names, code) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), code);
}
function address(value) {
    requireValue(fullMatch(/^0x[0-9a-fA-F]{40}$(?![\s\S])/, value) && !/^0x0{40}$/.test(value), 'invalid_address');
    try { return getAddress(value); } catch { fail('invalid_address'); }
}
function receiveUrl(value) {
    requireValue(typeof value === 'string' && value.length <= 2048, 'invalid_receive_url');
    try {
        const url = new URL(value);
        // Require canonical spelling: no whitespace, escapes, default-port aliases,
        // dot segments, backslashes, empty query/fragment, or Unicode host coercion.
        requireValue(url.href === value && url.protocol === 'https:' && url.hostname &&
            !url.hostname.endsWith('.') && !url.username && !url.password && !url.search && !url.hash &&
            url.pathname === '/v1/jobs' && !value.includes('?') && !value.includes('#'), 'invalid_receive_url');
        return value;
    } catch { fail('invalid_receive_url'); }
}

// Pure validation; no DNS, keys, signer authorization or runtime configuration.
export function parsePeerDirectory(raw) {
    fields(raw, ['version', 'networkId', 'revision', 'execution', 'nodes'], 'invalid_directory_fields');
    requireValue(raw.version === 1, 'unsupported_directory_version');
    requireValue(fullMatch(/^[a-z0-9][a-z0-9._-]{0,63}$(?![\s\S])/, raw.networkId), 'invalid_network_id');
    requireValue(positiveInteger(raw.revision), 'invalid_revision');
    fields(raw.execution, ['mode', 'chainId', 'ledgerContract'], 'invalid_execution_fields');
    requireValue(raw.execution.mode === 'ledger' && positiveInteger(raw.execution.chainId), 'invalid_execution');
    const execution = Object.freeze({ mode: 'ledger', chainId: raw.execution.chainId,
        ledgerContract: address(raw.execution.ledgerContract) });
    requireValue(Array.isArray(raw.nodes) && raw.nodes.length <= MAX_DIRECTORY_NODES, 'invalid_nodes');
    const addresses = new Set(), endpoints = new Set(), targets = new Set();
    const nodes = Array.from(raw.nodes, record => {
        fields(record, ['nodeAddress', 'receiveUrl', 'target'], 'invalid_node_fields');
        const nodeAddress = address(record.nodeAddress), endpoint = receiveUrl(record.receiveUrl);
        requireValue(fullMatch(/^[a-z0-9][a-z0-9_-]{0,63}$(?![\s\S])/, record.target), 'invalid_target');
        const normalized = nodeAddress.toLowerCase();
        requireValue(!addresses.has(normalized), 'duplicate_node_address');
        requireValue(!endpoints.has(endpoint), 'duplicate_receive_url');
        requireValue(!targets.has(record.target), 'duplicate_target');
        addresses.add(normalized); endpoints.add(endpoint); targets.add(record.target);
        return Object.freeze({ nodeAddress, receiveUrl: endpoint, target: record.target });
    });
    nodes.sort((a, b) => a.nodeAddress.toLowerCase() < b.nodeAddress.toLowerCase() ? -1 : 1);
    return Object.freeze({ version: 1, networkId: raw.networkId, revision: raw.revision,
        execution, nodes: Object.freeze(nodes) });
}

export function decodePeerDirectory(bytes) {
    requireValue(bytes instanceof Uint8Array && bytes.byteLength <= MAX_DIRECTORY_BYTES, 'directory_too_large');
    let raw;
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        raw = JSON.parse(text); // Validate grammar before scanning the intact source for duplicate names.
        const scopes = [];
        // Consume whole strings so punctuation/escaped quotes inside values cannot create scopes.
        // An iterative stack also handles deeply nested (schema-invalid) JSON without recursion.
        for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
            const token = match[0];
            if (token === '{') scopes.push(new Set());
            else if (token === '[') scopes.push(null);
            else if (token === '}' || token === ']') scopes.pop();
            else {
                let next = match.index + token.length;
                while (/\s/.test(text[next] ?? '') && next < text.length) next++;
                if (text[next] === ':') {
                    const name = JSON.parse(token), names = scopes.at(-1);
                    requireValue(!names.has(name), 'invalid_directory_json');
                    names.add(name);
                }
            }
        }
    } catch { fail('invalid_directory_json'); }
    return Object.freeze({ directory: parsePeerDirectory(raw), fileSha256: sha256(bytes) });
}

// Open nonblocking so even a substituted FIFO cannot hang. Bound the read itself,
// not just stat(). Reject leaf symlinks and changes observed during the read.
export function loadPeerDirectory(path) {
    let fd;
    try {
        requireValue(typeof path === 'string' && path.length > 0, 'directory_read_failed');
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(fd);
        requireValue(before.isFile(), 'directory_not_regular');
        requireValue(before.size <= MAX_DIRECTORY_BYTES, 'directory_too_large');
        const buffer = Buffer.alloc(MAX_DIRECTORY_BYTES + 1);
        let size = 0, count;
        do {
            count = readSync(fd, buffer, size, buffer.length - size, null);
            size += count;
        } while (count && size < buffer.length);
        requireValue(size <= MAX_DIRECTORY_BYTES, 'directory_too_large');
        const after = fstatSync(fd);
        requireValue(before.size === size && after.size === size && before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs, 'directory_changed_during_read');
        return decodePeerDirectory(buffer.subarray(0, size));
    } catch (error) {
        if (error instanceof DirectoryError) throw error;
        fail('directory_read_failed');
    } finally { if (fd !== undefined) closeSync(fd); }
}

function content(directory) {
    return { version: directory.version, networkId: directory.networkId,
        execution: { ...directory.execution, ledgerContract: directory.execution.ledgerContract.toLowerCase() },
        nodes: directory.nodes.map(node => ({ ...node, nodeAddress: node.nodeAddress.toLowerCase() })) };
}
export function inspectPeerDirectory(raw) {
    const directory = parsePeerDirectory(raw);
    return { ...directory, nodeCount: directory.nodes.length, bootstrapOnly: directory.nodes.length === 0,
        contentSha256: sha256(JSON.stringify(content(directory))), runtimeAuthorization: 'unchanged' };
}

export function comparePeerDirectories(baseRaw, candidateRaw) {
    const base = parsePeerDirectory(baseRaw), candidate = parsePeerDirectory(candidateRaw);
    const oldContent = content(base), newContent = content(candidate);
    requireValue(base.networkId === candidate.networkId &&
        JSON.stringify(oldContent.execution) === JSON.stringify(newContent.execution), 'directory_domain_changed');
    const changed = JSON.stringify(oldContent) !== JSON.stringify(newContent);
    requireValue(candidate.revision >= base.revision && (!changed || candidate.revision > base.revision),
        'directory_revision_not_advanced');
    const identity = node => node.nodeAddress.toLowerCase();
    const oldNodes = new Map(base.nodes.map(node => [identity(node), node]));
    const newNodes = new Map(candidate.nodes.map(node => [identity(node), node]));
    return { baseRevision: base.revision, revision: candidate.revision, changed,
        added: candidate.nodes.filter(node => !oldNodes.has(identity(node))),
        removed: base.nodes.filter(node => !newNodes.has(identity(node))),
        updated: candidate.nodes.filter(node => oldNodes.has(identity(node)) &&
            JSON.stringify(oldNodes.get(identity(node))) !== JSON.stringify(node))
            .map(node => ({ before: oldNodes.get(identity(node)), after: node })) };
}
