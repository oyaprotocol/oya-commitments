#!/usr/bin/env node
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { formatGasPolicy, projectGasPolicy } from '../src/gas-policy.mjs';

const usage = 'Usage: gas-policy.mjs --config FILE [--json]';
const maxBytes = 65_536;

function readConfig(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes) throw new Error();
        // Bound the read even if the file grows after fstat.
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, null);
            if (!count) break;
            length += count;
        }
        if (length > maxBytes) throw new Error();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    } catch {
        throw new Error('Config must be readable UTF-8 JSON in a regular file of at most 65536 bytes (no file symlinks).');
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function main(args) {
    if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
    let config, json = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config' && config === undefined && args[i + 1] && !args[i + 1].startsWith('--')) {
            config = args[++i];
        } else if (args[i] === '--json' && !json) json = true;
        else throw new Error(usage);
    }
    if (config === undefined) throw new Error(usage);
    const policy = projectGasPolicy(readConfig(config));
    console.log(json ? JSON.stringify(policy) : formatGasPolicy(policy));
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 2; }
