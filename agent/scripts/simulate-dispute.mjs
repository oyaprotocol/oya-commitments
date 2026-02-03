import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    http,
    parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function mustGetEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env var ${key}`);
    }
    return value;
}

function loadArtifact(relativePath) {
    return readFile(path.join(repoRoot, relativePath), 'utf8').then((raw) => JSON.parse(raw));
}

async function deployContract({ walletClient, publicClient, abi, bytecode, args }) {
    const hash = await walletClient.deployContract({
        abi,
        bytecode,
        args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
        throw new Error('Deployment failed (no contractAddress).');
    }
    return receipt.contractAddress;
}

async function main() {
    const rpcUrl = mustGetEnv('RPC_URL');
    const privateKey = mustGetEnv('PRIVATE_KEY');
    const caseArg = process.argv.find((arg) => arg.startsWith('--case='));
    const scenario = caseArg ? caseArg.split('=')[1] : 'dispute';
    if (!['dispute', 'no-dispute'].includes(scenario)) {
        throw new Error('Case must be one of: dispute, no-dispute.');
    }

    const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

    const [erc20Artifact, ooArtifact, ogArtifact] = await Promise.all([
        loadArtifact('out/MockERC20.sol/MockERC20.json'),
        loadArtifact('out/MockOptimisticOracleV3.sol/MockOptimisticOracleV3.json'),
        loadArtifact('out/MockOptimisticGovernor.sol/MockOptimisticGovernor.json'),
    ]);

    const erc20 = await deployContract({
        walletClient,
        publicClient,
        abi: erc20Artifact.abi,
        bytecode: erc20Artifact.bytecode.object ?? erc20Artifact.bytecode,
        args: ['Bond', 'BOND', 18],
    });

    const oo = await deployContract({
        walletClient,
        publicClient,
        abi: ooArtifact.abi,
        bytecode: ooArtifact.bytecode.object ?? ooArtifact.bytecode,
        args: [],
    });

    const og = await deployContract({
        walletClient,
        publicClient,
        abi: ogArtifact.abi,
        bytecode: ogArtifact.bytecode.object ?? ogArtifact.bytecode,
        args: [
            getAddress(erc20),
            0n,
            getAddress(oo),
            'Mock rules',
            '0x' + '11'.repeat(32),
            3600,
        ],
    });

    const erc20Client = {
        address: erc20,
        abi: erc20Artifact.abi,
    };
    const ooClient = {
        address: oo,
        abi: ooArtifact.abi,
    };

    const assertionId = `0x${'aa'.repeat(32)}`;
    const now = BigInt((await publicClient.getBlock()).timestamp);

    const mintHash = await walletClient.writeContract({
        ...erc20Client,
        functionName: 'mint',
        args: [account.address, 1_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const assertionHash = await walletClient.writeContract({
        ...ooClient,
        functionName: 'setAssertionSimple',
        args: [
            assertionId,
            account.address,
            Number(now),
            false,
            erc20,
            Number(now + 3600n),
            '0x' + '22'.repeat(32),
            100_000n,
        ],
    });
    await publicClient.waitForTransactionReceipt({ hash: assertionHash });

    const seeded = await publicClient.readContract({
        ...ooClient,
        functionName: 'getAssertion',
        args: [assertionId],
    });
    console.log('[sim] Seeded assertion currency:', seeded.currency);

    process.env.COMMITMENT_SAFE = account.address;
    process.env.OG_MODULE = og;
    process.env.WATCH_ASSETS = erc20;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

    const { postBondAndDispute } = await import('../src/index.js');

    if (scenario === 'dispute') {
        await postBondAndDispute({
            assertionId,
            explanation: 'Simulation dispute: proposal violates rules.',
        });
    } else {
        console.log('[sim] No-dispute case: leaving assertion undisputed.');
    }

    const updated = await publicClient.readContract({
        ...ooClient,
        functionName: 'getAssertion',
        args: [assertionId],
    });

    console.log('[sim] Assertion disputer:', updated.disputer);
}

main().catch((error) => {
    console.error('[sim] failed', error);
    process.exit(1);
});
