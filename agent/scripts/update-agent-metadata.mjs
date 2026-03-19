import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    getArgValue,
    loadScriptEnv,
    normalizeAgentName,
    repoRoot,
    resolveAgentDirectory,
    resolveAgentRef,
} from './lib/cli-runtime.mjs';

loadScriptEnv();

function formatCaip10(chainId, address) {
    const cleaned = address.toLowerCase();
    return `eip155:${chainId}:${cleaned}`;
}

async function main() {
    const agentRef =
        getArgValue('--agent=') ??
        resolveAgentRef({ flag: '--agent=' });
    const agentName = normalizeAgentName(agentRef);
    const agentJsonPath = path.join(
        resolveAgentDirectory(agentRef, { repoRootPath: repoRoot }),
        'agent.json'
    );

    const agentIdArg = getArgValue('--agent-id=');
    const agentId = agentIdArg ?? process.env.AGENT_ID;
    if (!agentId) {
        throw new Error('Missing --agent-id or AGENT_ID.');
    }

    const chainId = getArgValue('--chain-id=') ?? process.env.CHAIN_ID ?? '11155111';
    const wallet = getArgValue('--agent-wallet=') ?? process.env.AGENT_WALLET;
    if (!wallet) {
        throw new Error('Missing --agent-wallet or AGENT_WALLET.');
    }

    const registry =
        getArgValue('--agent-registry=') ??
        process.env.AGENT_REGISTRY ??
        '0x8004A818BFB912233c491871b3d84c89A494BD9e';

    const raw = await readFile(agentJsonPath, 'utf8');
    const json = JSON.parse(raw);

    json.endpoints = Array.isArray(json.endpoints) ? json.endpoints : [];
    const walletEndpoint = formatCaip10(chainId, wallet);
    const existingEndpoint = json.endpoints.find((item) => item?.name === 'agentWallet');
    if (existingEndpoint) {
        existingEndpoint.endpoint = walletEndpoint;
    } else {
        json.endpoints.push({ name: 'agentWallet', endpoint: walletEndpoint });
    }

    json.registrations = Array.isArray(json.registrations) ? json.registrations : [];
    const registryEndpoint = formatCaip10(chainId, registry).toLowerCase();
    const agentIdValue = String(agentId);
    const normalizedRegistrations = [];
    let updated = false;
    for (const entry of json.registrations) {
        if (!entry?.agentRegistry) continue;
        const normalizedRegistry = String(entry.agentRegistry).toLowerCase();
        if (normalizedRegistry === registryEndpoint) {
            if (!updated) {
                normalizedRegistrations.push({
                    agentId: agentIdValue,
                    agentRegistry: registryEndpoint,
                });
                updated = true;
            }
            continue;
        }
        normalizedRegistrations.push({
            ...entry,
            agentRegistry: normalizedRegistry,
        });
    }
    if (!updated) {
        normalizedRegistrations.push({
            agentId: agentIdValue,
            agentRegistry: registryEndpoint,
        });
    }
    json.registrations = normalizedRegistrations;

    await writeFile(agentJsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

    console.log('[agent] Updated metadata:', agentJsonPath);
}

main().catch((error) => {
    console.error('[agent] update failed:', error.message ?? error);
    process.exit(1);
});
