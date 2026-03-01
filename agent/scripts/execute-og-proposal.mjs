import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';
import {
    optimisticGovernorAbi,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
} from '../src/lib/og.js';
import { createSignerClient } from '../src/lib/signer.js';
import { findContractDeploymentBlock, getLogsChunked } from '../src/lib/chain-history.js';
import { normalizeHashOrNull } from '../src/lib/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

const DEFAULT_LOG_CHUNK_SIZE = 5_000n;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;

function getArgValue(prefix) {
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

function hasFlag(flag) {
    return process.argv.includes(flag);
}

function parseNonNegativeBigInt(value, label) {
    let parsed;
    try {
        parsed = BigInt(String(value));
    } catch (error) {
        throw new Error(`${label} must be an integer.`);
    }
    if (parsed < 0n) {
        throw new Error(`${label} must be >= 0.`);
    }
    return parsed;
}

function parsePositiveBigInt(value, label) {
    const parsed = parseNonNegativeBigInt(value, label);
    if (parsed <= 0n) {
        throw new Error(`${label} must be > 0.`);
    }
    return parsed;
}

function parsePositiveNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive number.`);
    }
    return parsed;
}

function sortByChainPosition(entries) {
    return [...entries].sort((left, right) => {
        const leftBlock = BigInt(left?.blockNumber ?? 0n);
        const rightBlock = BigInt(right?.blockNumber ?? 0n);
        if (leftBlock !== rightBlock) {
            return leftBlock < rightBlock ? -1 : 1;
        }
        const leftLogIndex = BigInt(left?.logIndex ?? 0);
        const rightLogIndex = BigInt(right?.logIndex ?? 0);
        if (leftLogIndex === rightLogIndex) {
            return 0;
        }
        return leftLogIndex < rightLogIndex ? -1 : 1;
    });
}

function printUsage() {
    console.log(`Usage:
node agent/scripts/execute-og-proposal.mjs --og=<og-module-address> --proposal-hash=<0x...>

Options:
  --og=<address>                 Optimistic Governor module address (fallback: OG_MODULE env)
  --proposal-hash=<0x...>        Proposal hash to execute (required)
  --rpc-url=<url>                RPC URL (fallback: RPC_URL env)
  --from-block=<number>          Lower bound for scanning TransactionsProposed logs
  --log-chunk-size=<number>      Chunk size for getLogs scans (fallback: LOG_CHUNK_SIZE env, default 5000)
  --wait-timeout-ms=<number>     Wait timeout for execution receipt (default 180000)
  --help                         Show this help
`);
}

async function resolveScanStartBlock({
    publicClient,
    ogModule,
    latestBlock,
    fromBlockArg,
}) {
    if (fromBlockArg !== null) {
        return parseNonNegativeBigInt(fromBlockArg, '--from-block');
    }
    if (process.env.START_BLOCK) {
        return parseNonNegativeBigInt(process.env.START_BLOCK, 'START_BLOCK');
    }

    const deploymentBlock = await findContractDeploymentBlock({
        publicClient,
        address: ogModule,
        latestBlock,
    });
    if (deploymentBlock === null) {
        throw new Error(`No contract code found for OG module ${ogModule} at latest block.`);
    }

    console.log(
        `[script] Auto-discovered scan start block from OG deployment: ${deploymentBlock.toString()}`
    );
    return deploymentBlock;
}

async function main() {
    if (hasFlag('--help') || hasFlag('-h')) {
        printUsage();
        return;
    }

    const ogRaw = getArgValue('--og=') ?? process.env.OG_MODULE;
    if (!ogRaw) {
        throw new Error('Missing --og=<address> (or OG_MODULE env).');
    }
    const ogModule = getAddress(ogRaw);

    const proposalHashRaw = getArgValue('--proposal-hash=');
    const proposalHash = normalizeHashOrNull(proposalHashRaw);
    if (!proposalHash) {
        throw new Error('Missing or invalid --proposal-hash=<0x...>.');
    }

    const rpcUrl = getArgValue('--rpc-url=') ?? process.env.RPC_URL;
    if (!rpcUrl) {
        throw new Error('Missing --rpc-url=<url> (or RPC_URL env).');
    }

    const chunkSizeRaw = getArgValue('--log-chunk-size=') ?? process.env.LOG_CHUNK_SIZE;
    const chunkSize = chunkSizeRaw
        ? parsePositiveBigInt(chunkSizeRaw, 'log chunk size')
        : DEFAULT_LOG_CHUNK_SIZE;

    const waitTimeoutRaw = getArgValue('--wait-timeout-ms=');
    const waitTimeoutMs = waitTimeoutRaw
        ? parsePositiveNumber(waitTimeoutRaw, '--wait-timeout-ms')
        : DEFAULT_WAIT_TIMEOUT_MS;

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const { account, walletClient } = await createSignerClient({ rpcUrl });

    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = await resolveScanStartBlock({
        publicClient,
        ogModule,
        latestBlock,
        fromBlockArg: getArgValue('--from-block='),
    });
    if (fromBlock > latestBlock) {
        throw new Error(
            `fromBlock ${fromBlock.toString()} is greater than latest block ${latestBlock.toString()}.`
        );
    }

    const [executedLogs, deletedLogs, proposedLogs] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalExecutedEvent,
            args: { proposalHash },
            fromBlock,
            toBlock: latestBlock,
            chunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalDeletedEvent,
            args: { proposalHash },
            fromBlock,
            toBlock: latestBlock,
            chunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize,
        }),
    ]);

    if (deletedLogs.length > 0) {
        console.log(`[script] Proposal ${proposalHash} has been deleted. Nothing to execute.`);
        return;
    }

    if (executedLogs.length > 0) {
        console.log(`[script] Proposal ${proposalHash} is already executed. Nothing to do.`);
        return;
    }

    const proposalMatches = proposedLogs.filter((log) => {
        const logHash = normalizeHashOrNull(log?.args?.proposalHash);
        return logHash === proposalHash;
    });
    if (proposalMatches.length === 0) {
        throw new Error(
            `Could not find TransactionsProposed log for proposalHash ${proposalHash} in [${fromBlock.toString()}, ${latestBlock.toString()}].`
        );
    }

    const sortedMatches = sortByChainPosition(proposalMatches);
    const proposalLog = sortedMatches[sortedMatches.length - 1];
    const proposal = proposalLog?.args?.proposal;
    const transactions = Array.isArray(proposal?.transactions) ? proposal.transactions : [];
    if (transactions.length === 0) {
        throw new Error(`Proposal ${proposalHash} has no executable transactions in log payload.`);
    }

    try {
        await publicClient.simulateContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'executeProposal',
            args: [transactions],
            account: account.address,
        });
    } catch (error) {
        const reason = error?.shortMessage ?? error?.message ?? String(error);
        throw new Error(`Execution simulation failed for proposal ${proposalHash}: ${reason}`);
    }

    console.log(
        `[script] Executing proposal ${proposalHash} on OG ${ogModule} as signer ${account.address}...`
    );
    const txHash = await walletClient.writeContract({
        address: ogModule,
        abi: optimisticGovernorAbi,
        functionName: 'executeProposal',
        args: [transactions],
    });
    console.log(`[script] executeProposal tx submitted: ${txHash}`);

    try {
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
            timeout: waitTimeoutMs,
        });
        console.log(
            `[script] Execution confirmed in block ${receipt.blockNumber.toString()} with status ${receipt.status}.`
        );
    } catch (error) {
        const reason = error?.shortMessage ?? error?.message ?? String(error);
        console.warn(
            `[script] Receipt wait timed out/failed after submit. Check tx status manually: ${txHash}. Reason: ${reason}`
        );
    }
}

main().catch((error) => {
    console.error(`[script] Failed: ${error?.message ?? error}`);
    process.exit(1);
});
