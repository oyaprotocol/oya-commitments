import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, decodeEventLog, http } from 'viem';
import { getAddress } from 'viem';
import { createSignerClient } from '../src/lib/signer.js';
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
    return `eip155:${chainId}:${address.toLowerCase()}`;
}

const REGISTRY_BY_NETWORK = {
    ethereum: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'ethereum-sepolia': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    base: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'base-sepolia': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    polygon: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'polygon-amoy': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    gnosis: {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    scroll: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'scroll-testnet': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    monad: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'monad-testnet': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    bsc: {
        identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    'bsc-testnet': {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
};

const identityRegistryAbi = [
    {
        type: 'function',
        name: 'register',
        inputs: [{ name: 'agentURI', type: 'string' }],
        outputs: [{ name: 'agentId', type: 'uint256' }],
        stateMutability: 'nonpayable',
    },
    {
        type: 'event',
        name: 'Registered',
        inputs: [
            { indexed: true, name: 'agentId', type: 'uint256' },
            { indexed: false, name: 'agentURI', type: 'string' },
            { indexed: true, name: 'owner', type: 'address' },
        ],
        anonymous: false,
    },
];

async function main() {
    const agentRef =
        getArgValue('--agent=') ??
        resolveAgentRef({ flag: '--agent=' });
    const agentName = normalizeAgentName(agentRef);
    const agentJsonPath = `${resolveAgentDirectory(agentRef, {
        repoRootPath: repoRoot,
    })}/agent.json`;

    const agentUriArg = getArgValue('--agent-uri=');
    const agentOrg = process.env.AGENT_ORG ?? 'oyaprotocol';
    const agentRepo = process.env.AGENT_REPO ?? 'oya-commitments';
    const agentBranch = process.env.AGENT_BRANCH;
    if (!agentBranch && !process.env.AGENT_URI_BASE && !process.env.AGENT_URI) {
        throw new Error('Missing AGENT_BRANCH (or provide AGENT_URI / AGENT_URI_BASE).');
    }
    const agentUriBase =
        process.env.AGENT_URI_BASE ??
        (agentBranch
            ? `https://raw.githubusercontent.com/${agentOrg}/${agentRepo}/${agentBranch}/agent-library/agents`
            : null);
    const agentUri =
        agentUriArg ??
        process.env.AGENT_URI ??
        (agentUriBase ? `${agentUriBase}/${agentName}/agent.json` : null);
    if (!agentUri) {
        throw new Error('Missing --agent-uri or AGENT_URI (or AGENT_URI_BASE).');
    }

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
        throw new Error('Missing RPC_URL.');
    }

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const { account, walletClient } = await createSignerClient({ rpcUrl });

    const chainId =
        Number(getArgValue('--chain-id=')) ||
        Number(process.env.CHAIN_ID) ||
        (await publicClient.getChainId());
    const registryOverride = getArgValue('--agent-registry=') ?? process.env.AGENT_REGISTRY;
    const network =
        getArgValue('--network=') ??
        process.env.AGENT_NETWORK ??
        (chainId === 1
            ? 'ethereum'
            : chainId === 11155111
              ? 'ethereum-sepolia'
              : undefined);
    const registry =
        registryOverride ?? (network ? REGISTRY_BY_NETWORK[network]?.identityRegistry : undefined);
    if (!registry) {
        throw new Error(
            `No IdentityRegistry configured for chainId ${chainId}. Provide --agent-registry or set AGENT_NETWORK.`
        );
    }

    const txHash = await walletClient.writeContract({
        address: getAddress(registry),
        abi: identityRegistryAbi,
        functionName: 'register',
        args: [agentUri],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    let agentId;
    for (const log of receipt.logs) {
        try {
            const decoded = decodeEventLog({
                abi: identityRegistryAbi,
                data: log.data,
                topics: log.topics,
            });
            if (decoded.eventName === 'Registered') {
                agentId = decoded.args.agentId;
                break;
            }
        } catch (error) {
            // ignore unrelated logs
        }
    }

    if (agentId === undefined) {
        throw new Error('Failed to parse Registered event for agentId.');
    }

    const wallet = getArgValue('--agent-wallet=') ?? process.env.AGENT_WALLET ?? account.address;
    const registryEndpoint = formatCaip10(chainId, registry).toLowerCase();
    const walletEndpoint = formatCaip10(chainId, wallet);

    const raw = await readFile(agentJsonPath, 'utf8');
    const json = JSON.parse(raw);
    json.endpoints = Array.isArray(json.endpoints) ? json.endpoints : [];
    const existingEndpoint = json.endpoints.find((item) => item?.name === 'agentWallet');
    if (existingEndpoint) {
        existingEndpoint.endpoint = walletEndpoint;
    } else {
        json.endpoints.push({ name: 'agentWallet', endpoint: walletEndpoint });
    }

    const agentIdValue = String(agentId);
    json.registrations = Array.isArray(json.registrations) ? json.registrations : [];
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

    console.log('[agent] Registered:', {
        agentId: agentIdValue,
        agentRegistry: registryEndpoint,
        agentURI: agentUri,
        txHash,
    });
    console.log('[agent] Updated metadata:', agentJsonPath);
}

main().catch((error) => {
    console.error('[agent] registration failed:', error.message ?? error);
    process.exit(1);
});
