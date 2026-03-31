import { decodeEventLog, getAddress } from 'viem';
import {
    optimisticGovernorAbi,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
} from '../src/lib/og.js';
import { createValidatedReadWriteRuntime } from '../src/lib/chain-runtime.js';
import { getLogsChunked } from '../src/lib/chain-history.js';
import { normalizeHashOrNull } from '../src/lib/utils.js';
import {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';

loadScriptEnv();

const DEFAULT_LOG_CHUNK_SIZE = 5_000n;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;

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

function printUsage() {
    console.log(`Usage:
node agent/scripts/execute-og-proposal.mjs --og=<og-module-address> --proposal-tx-hash=<0x...>

Options:
  --og=<address>                 Optimistic Governor module address
  --proposal-tx-hash=<0x...>     Proposal submission transaction hash (required)
  --tx-hash=<0x...>              Alias for --proposal-tx-hash
  --rpc-url=<url>                RPC URL (fallback: RPC_URL env)
  --log-chunk-size=<number>      Chunk size for getLogs scans (default 5000)
  --wait-timeout-ms=<number>     Wait timeout for execution receipt (default 180000)
  --help                         Show this help
`);
}

async function main({
    argv = process.argv,
    env = process.env,
    createValidatedReadWriteRuntimeFn = createValidatedReadWriteRuntime,
} = {}) {
    if (hasFlag('--help', argv) || hasFlag('-h', argv)) {
        printUsage();
        return;
    }

    const ogRaw = getArgValue('--og=', argv);
    if (!ogRaw) {
        throw new Error('Missing --og=<address>.');
    }
    const ogModule = getAddress(ogRaw);

    const proposalTxHashRaw =
        getArgValue('--proposal-tx-hash=', argv) ?? getArgValue('--tx-hash=', argv);
    const proposalTxHash = normalizeHashOrNull(proposalTxHashRaw);
    if (!proposalTxHash) {
        throw new Error('Missing or invalid --proposal-tx-hash=<0x...>.');
    }

    const rpcUrl = getArgValue('--rpc-url=', argv) ?? env.RPC_URL;
    if (!rpcUrl) {
        throw new Error('Missing --rpc-url=<url> (or RPC_URL env).');
    }

    const chunkSizeRaw = getArgValue('--log-chunk-size=', argv);
    const chunkSize = chunkSizeRaw
        ? parsePositiveBigInt(chunkSizeRaw, 'log chunk size')
        : DEFAULT_LOG_CHUNK_SIZE;

    const waitTimeoutRaw = getArgValue('--wait-timeout-ms=', argv);
    const waitTimeoutMs = waitTimeoutRaw
        ? parsePositiveNumber(waitTimeoutRaw, '--wait-timeout-ms')
        : DEFAULT_WAIT_TIMEOUT_MS;

    const { publicClient, account, walletClient } = await createValidatedReadWriteRuntimeFn({
        rpcUrl,
        publicClientLabel: 'Execution rpcUrl',
        signerClientLabel: 'Execution signer',
    });

    const proposalReceipt = await publicClient.getTransactionReceipt({
        hash: proposalTxHash,
    });
    if (proposalReceipt.status !== 'success') {
        throw new Error(
            `Proposal submission transaction ${proposalTxHash} did not succeed (status=${proposalReceipt.status}).`
        );
    }

    let proposalHash = null;
    let transactions = null;
    for (const log of proposalReceipt.logs ?? []) {
        let logAddress;
        try {
            logAddress = getAddress(log.address);
        } catch (error) {
            continue;
        }
        if (logAddress !== ogModule) continue;

        try {
            const decoded = decodeEventLog({
                abi: [transactionsProposedEvent],
                data: log.data,
                topics: log.topics,
            });
            const decodedProposalHash = normalizeHashOrNull(decoded?.args?.proposalHash);
            const decodedTransactions = decoded?.args?.proposal?.transactions;
            if (decodedProposalHash && Array.isArray(decodedTransactions) && decodedTransactions.length > 0) {
                proposalHash = decodedProposalHash;
                transactions = decodedTransactions;
                break;
            }
        } catch (error) {
            // Ignore unrelated logs in the tx receipt.
        }
    }

    if (!proposalHash || !transactions) {
        throw new Error(
            `Could not decode TransactionsProposed from tx ${proposalTxHash} for OG ${ogModule}.`
        );
    }

    console.log(
        `[script] Decoded proposal from tx ${proposalTxHash}. proposalHash=${proposalHash}`
    );

    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = proposalReceipt.blockNumber;
    const [executedLogs, deletedLogs] = await Promise.all([
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
    ]);

    if (deletedLogs.length > 0) {
        console.log(`[script] Proposal ${proposalHash} has been deleted. Nothing to execute.`);
        return;
    }

    if (executedLogs.length > 0) {
        console.log(`[script] Proposal ${proposalHash} is already executed. Nothing to do.`);
        return;
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
        `[script] Executing proposal from tx ${proposalTxHash} on OG ${ogModule} as signer ${account.address}...`
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

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error(`[script] Failed: ${error?.message ?? error}`);
        process.exit(1);
    });
}

export { main };
