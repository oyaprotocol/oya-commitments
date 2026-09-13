import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';

export function localUrl(config) {
    return `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
}

export async function loadLocalConfig(configPath, envPath, { env = process.env, log = console.log } = {}) {
    const fail = (message) => { log(`FAIL ${message}`); return null; };
    let selectedEnv;
    try {
        selectedEnv = { ...env, ...parseEnv(await readFile(envPath, 'utf8')) };
    } catch {
        return fail('Environment file. Check that the selected file exists and is readable.');
    }
    let config;
    try {
        config = parseConfig(JSON.parse(await readFile(configPath, 'utf8')), { env: selectedEnv });
    } catch {
        return fail('Configuration. Check the JSON, chainId, loggerContract, allowedSigners, rpcUrl, and ipfsUrl.');
    }
    if (!['127.0.0.1', '::1'].includes(config.host)) {
        return fail('Local binding. Set host to 127.0.0.1 or ::1.');
    }
    return { config, env: selectedEnv };
}

export async function loadLocalSettings(configPath, envPath, options = {}) {
    const settings = await loadLocalConfig(configPath, envPath, options);
    if (!settings) return null;
    const { config, env: selectedEnv } = settings;
    let nodeAddress;
    try {
        nodeAddress = createLocalSigner(selectedEnv.OYA_NODE_PRIVATE_KEY).address;
    } catch {
        (options.log ?? console.log)('FAIL Node signing key. Set a valid OYA_NODE_PRIVATE_KEY in the selected file or environment.');
        return null;
    }
    // The runtime needs only its own Oya credentials, never agent or deployment keys.
    const nodeKeys = ['OYA_NODE_PRIVATE_KEY', 'OYA_RPC_AUTHORIZATION', 'OYA_IPFS_AUTHORIZATION'];
    const nodeEnv = Object.fromEntries(Object.entries(selectedEnv).filter(([key]) =>
        nodeKeys.includes(key) || (!key.startsWith('OYA_') && !key.startsWith('LOGGER_'))));
    return { config, nodeAddress, nodeEnv };
}
