import {
    decodeEventLog,
    encodeFunctionData,
    erc20Abi,
    getAddress,
    parseAbi,
    stringToHex,
    zeroAddress,
} from 'viem';
import {
    optimisticGovernorAbi,
    optimisticOracleAbi,
    transactionsProposedEvent,
} from './og.js';
import { normalizeAssertion } from './og.js';
import { normalizeHashOrNull, summarizeViemError } from './utils.js';

const conditionalTokensAbi = parseAbi([
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

const erc1155TransferAbi = parseAbi([
    'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

function extractProposalHashFromReceipt({ receipt, ogModule }) {
    if (!receipt?.logs || !Array.isArray(receipt.logs)) return null;
    let normalizedOgModule;
    try {
        normalizedOgModule = getAddress(ogModule);
    } catch (error) {
        return null;
    }

    for (const log of receipt.logs) {
        let logAddress;
        try {
            logAddress = getAddress(log.address);
        } catch (error) {
            continue;
        }
        if (logAddress !== normalizedOgModule) continue;

        try {
            const decoded = decodeEventLog({
                abi: [transactionsProposedEvent],
                data: log.data,
                topics: log.topics,
            });
            const hash = normalizeHashOrNull(decoded?.args?.proposalHash);
            if (hash) return hash;
        } catch (error) {
            // Ignore non-matching logs.
        }
    }

    return null;
}

async function postBondAndPropose({
    publicClient,
    walletClient,
    account,
    config,
    ogModule,
    transactions,
}) {
    if (!config.proposeEnabled) {
        throw new Error('Proposals disabled via PROPOSE_ENABLED.');
    }

    const normalizedTransactions = normalizeOgTransactions(transactions);
    const proposerBalance = await publicClient.getBalance({ address: account.address });
    const [collateral, bondAmount, optimisticOracle] = await Promise.all([
        publicClient.readContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'collateral',
        }),
        publicClient.readContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'bondAmount',
        }),
        publicClient.readContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'optimisticOracleV3',
        }),
    ]);
    let minimumBond = 0n;
    try {
        minimumBond = await publicClient.readContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'getMinimumBond',
            args: [collateral],
        });
    } catch (error) {
        console.warn('[agent] Failed to fetch minimum bond from optimistic oracle:', error);
    }

    const requiredBond = bondAmount > minimumBond ? bondAmount : minimumBond;

    if (requiredBond > 0n) {
        const collateralBalance = await publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        if (collateralBalance < requiredBond) {
            throw new Error(
                `Insufficient bond collateral balance: need ${requiredBond.toString()} wei, have ${collateralBalance.toString()}.`
            );
        }
        const spenders = [];
        if (config.bondSpender === 'og' || config.bondSpender === 'both') {
            spenders.push(ogModule);
        }
        if (config.bondSpender === 'oo' || config.bondSpender === 'both') {
            spenders.push(optimisticOracle);
        }

        for (const spender of spenders) {
            const approveHash = await walletClient.writeContract({
                address: collateral,
                abi: erc20Abi,
                functionName: 'approve',
                args: [spender, requiredBond],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            const allowance = await publicClient.readContract({
                address: collateral,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [account.address, spender],
            });
            if (allowance < requiredBond) {
                throw new Error(
                    `Insufficient bond allowance: need ${requiredBond.toString()} wei, have ${allowance.toString()} for spender ${spender}.`
                );
            }
        }
    }

    if (proposerBalance === 0n) {
        throw new Error(
            `Proposer ${account.address} has 0 native balance; cannot pay gas to propose.`
        );
    }

    let proposalTxHash;
    let proposalHash;
    const explanation = 'Agent serving Oya commitment.';
    const explanationBytes = stringToHex(explanation);
    const proposalData = encodeFunctionData({
        abi: optimisticGovernorAbi,
        functionName: 'proposeTransactions',
        args: [normalizedTransactions, explanationBytes],
    });
    let simulationError;
    let submissionError;
    try {
        await publicClient.simulateContract({
            address: ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'proposeTransactions',
            args: [normalizedTransactions, explanationBytes],
            account: account.address,
        });
    } catch (error) {
        simulationError = error;
        const simulationMessage =
            error?.shortMessage ?? error?.message ?? summarizeViemError(error)?.message ?? String(error);
        console.warn('[agent] Proposal simulation failed:', simulationMessage);
        if (!config.allowProposeOnSimulationFail) {
            throw error;
        }
        console.warn('[agent] Simulation failed; attempting to propose anyway.');
    }

    try {
        if (simulationError) {
            proposalTxHash = await walletClient.sendTransaction({
                account,
                to: ogModule,
                data: proposalData,
                value: 0n,
                gas: config.proposeGasLimit,
            });
        } else {
            proposalTxHash = await walletClient.writeContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'proposeTransactions',
                args: [normalizedTransactions, explanationBytes],
            });
        }
    } catch (error) {
        submissionError = error;
        const message =
            error?.shortMessage ??
            error?.message ??
            simulationError?.shortMessage ??
            simulationError?.message ??
            String(error ?? simulationError);
        console.warn('[agent] Propose submission failed:', message);
    }

    if (proposalTxHash) {
        console.log('[agent] Proposal submitted tx:', proposalTxHash);
        try {
            const receipt = await publicClient.waitForTransactionReceipt({
                hash: proposalTxHash,
            });
            proposalHash = extractProposalHashFromReceipt({
                receipt,
                ogModule,
            });
        } catch (error) {
            const reason = error?.shortMessage ?? error?.message ?? String(error);
            console.warn('[agent] Failed to resolve OG proposalHash from receipt:', reason);
        }
    }

    if (proposalHash) {
        console.log('[agent] OG proposal hash:', proposalHash);
    }

    return {
        transactionHash: proposalTxHash,
        // Backward-compatible alias: legacy agents read `proposalHash` as submission tx hash.
        proposalHash: proposalTxHash,
        // New explicit OG proposal hash extracted from TransactionsProposed logs.
        ogProposalHash: proposalHash,
        bondAmount,
        collateral,
        optimisticOracle,
        submissionError: submissionError ? summarizeViemError(submissionError) : null,
    };
}

async function postBondAndDispute({
    publicClient,
    walletClient,
    account,
    config,
    ogContext,
    assertionId,
    explanation,
}) {
    if (!config.disputeEnabled) {
        throw new Error('Disputes disabled via DISPUTE_ENABLED.');
    }

    const proposerBalance = await publicClient.getBalance({ address: account.address });
    if (proposerBalance === 0n) {
        throw new Error(
            `Disputer ${account.address} has 0 native balance; cannot pay gas to dispute.`
        );
    }

    const optimisticOracle = ogContext?.optimisticOracle;
    if (!optimisticOracle) {
        throw new Error('Missing optimistic oracle address.');
    }

    const assertionRaw = await publicClient.readContract({
        address: optimisticOracle,
        abi: optimisticOracleAbi,
        functionName: 'getAssertion',
        args: [assertionId],
    });
    const assertion = normalizeAssertion(assertionRaw);

    const nowBlock = await publicClient.getBlock();
    const now = BigInt(nowBlock.timestamp);
    const expirationTime = BigInt(assertion.expirationTime ?? 0);
    const disputer = assertion.disputer ? getAddress(assertion.disputer) : zeroAddress;
    const settled = Boolean(assertion.settled);
    if (settled) {
        throw new Error(`Assertion ${assertionId} already settled.`);
    }
    if (expirationTime !== 0n && now >= expirationTime) {
        throw new Error(`Assertion ${assertionId} expired at ${expirationTime}.`);
    }
    if (disputer !== zeroAddress) {
        throw new Error(`Assertion ${assertionId} already disputed by ${disputer}.`);
    }

    const bond = BigInt(assertion.bond ?? 0);
    const currency = assertion.currency ? getAddress(assertion.currency) : zeroAddress;
    if (currency === zeroAddress) {
        throw new Error('Assertion currency is zero address; cannot post bond.');
    }

    if (bond > 0n) {
        const collateralBalance = await publicClient.readContract({
            address: currency,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        if (collateralBalance < bond) {
            throw new Error(
                `Insufficient dispute bond balance: need ${bond.toString()} wei, have ${collateralBalance.toString()}.`
            );
        }

        const approveHash = await walletClient.writeContract({
            address: currency,
            abi: erc20Abi,
            functionName: 'approve',
            args: [optimisticOracle, bond],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    let disputeHash;
    try {
        await publicClient.simulateContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'disputeAssertion',
            args: [assertionId, account.address],
            account: account.address,
        });
        disputeHash = await walletClient.writeContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'disputeAssertion',
            args: [assertionId, account.address],
        });
    } catch (error) {
        const message = error?.shortMessage ?? error?.message ?? String(error);
        throw new Error(`Dispute submission failed: ${message}`);
    }

    if (explanation) {
        console.log(`[agent] Dispute rationale: ${explanation}`);
    }

    console.log('[agent] Dispute submitted:', disputeHash);

    return {
        disputeHash,
        bondAmount: bond,
        collateral: currency,
        optimisticOracle,
    };
}

function normalizeOgTransactions(transactions) {
    if (!Array.isArray(transactions)) {
        throw new Error('transactions must be an array');
    }

    return transactions.map((tx, index) => {
        if (!tx || !tx.to) {
            throw new Error(`transactions[${index}] missing to`);
        }

        return {
            to: getAddress(tx.to),
            value: BigInt(tx.value ?? 0),
            data: tx.data ?? '0x',
            operation: Number(tx.operation ?? 0),
        };
    });
}

function buildOgTransactions(actions, options = {}) {
    if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error('actions must be a non-empty array');
    }

    const config = options.config ?? {};

    const transactions = [];

    for (const action of actions) {
        const operation = action.operation !== undefined ? Number(action.operation) : 0;

        if (action.kind === 'erc20_transfer') {
            if (!action.token || !action.to || action.amountWei === undefined) {
                throw new Error('erc20_transfer requires token, to, amountWei');
            }

            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [getAddress(action.to), BigInt(action.amountWei)],
            });

            transactions.push({
                to: getAddress(action.token),
                value: '0',
                data,
                operation,
            });
            continue;
        }

        if (action.kind === 'native_transfer') {
            if (!action.to || action.amountWei === undefined) {
                throw new Error('native_transfer requires to, amountWei');
            }

            transactions.push({
                to: getAddress(action.to),
                value: BigInt(action.amountWei).toString(),
                data: '0x',
                operation,
            });
            continue;
        }

        if (action.kind === 'contract_call') {
            if (!action.to || !action.abi) {
                throw new Error('contract_call requires to, abi');
            }

            const abi = parseAbi([`function ${action.abi}`]);
            const args = Array.isArray(action.args) ? action.args : [];
            const data = encodeFunctionData({
                abi,
                functionName: action.abi.split('(')[0],
                args,
            });
            const value = action.valueWei !== undefined ? BigInt(action.valueWei).toString() : '0';

            transactions.push({
                to: getAddress(action.to),
                value,
                data,
                operation,
            });
            continue;
        }

        if (action.kind === 'uniswap_v3_exact_input_single') {
            if (
                !action.router ||
                !action.tokenIn ||
                !action.tokenOut ||
                action.fee === undefined ||
                !action.recipient ||
                action.amountInWei === undefined ||
                action.amountOutMinWei === undefined
            ) {
                throw new Error(
                    'uniswap_v3_exact_input_single requires router, tokenIn, tokenOut, fee, recipient, amountInWei, amountOutMinWei'
                );
            }

            const router = getAddress(action.router);
            const tokenIn = getAddress(action.tokenIn);
            const tokenOut = getAddress(action.tokenOut);
            const recipient = getAddress(action.recipient);
            const fee = Number(action.fee);

            const approveData = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [router, BigInt(action.amountInWei)],
            });
            transactions.push({
                to: tokenIn,
                value: '0',
                data: approveData,
                operation,
            });

            const swapAbi = parseAbi([
                'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
            ]);
            const swapData = encodeFunctionData({
                abi: swapAbi,
                functionName: 'exactInputSingle',
                args: [
                    {
                        tokenIn,
                        tokenOut,
                        fee,
                        recipient,
                        amountIn: BigInt(action.amountInWei),
                        amountOutMinimum: BigInt(action.amountOutMinWei),
                        sqrtPriceLimitX96: BigInt(action.sqrtPriceLimitX96 ?? 0),
                    },
                ],
            });
            transactions.push({
                to: router,
                value: '0',
                data: swapData,
                operation,
            });
            continue;
        }

        if (action.kind === 'ctf_split' || action.kind === 'ctf_merge') {
            if (!action.collateralToken || !action.conditionId || action.amount === undefined) {
                throw new Error(`${action.kind} requires collateralToken, conditionId, amount`);
            }
            const collateralToken = getAddress(action.collateralToken);
            const ctfContract = action.ctfContract
                ? getAddress(action.ctfContract)
                : config.polymarketConditionalTokens;
            if (!ctfContract) {
                throw new Error(`${action.kind} requires ctfContract or POLYMARKET_CONDITIONAL_TOKENS`);
            }
            const parentCollectionId = action.parentCollectionId ?? ZERO_BYTES32;
            const partition = Array.isArray(action.partition) && action.partition.length > 0
                ? action.partition.map((value) => BigInt(value))
                : [1n, 2n];
            const amount = BigInt(action.amount);
            if (amount <= 0n) {
                throw new Error(`${action.kind} amount must be > 0`);
            }

            if (action.kind === 'ctf_split') {
                // Use zero-first approval for compatibility with ERC20 tokens that
                // require allowance reset before setting a new non-zero allowance.
                const resetApproveData = encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [ctfContract, 0n],
                });
                transactions.push({
                    to: collateralToken,
                    value: '0',
                    data: resetApproveData,
                    operation: 0,
                });

                const approveData = encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [ctfContract, amount],
                });
                transactions.push({
                    to: collateralToken,
                    value: '0',
                    data: approveData,
                    operation: 0,
                });
            }

            const functionName = action.kind === 'ctf_split' ? 'splitPosition' : 'mergePositions';
            const data = encodeFunctionData({
                abi: conditionalTokensAbi,
                functionName,
                args: [
                    collateralToken,
                    parentCollectionId,
                    action.conditionId,
                    partition,
                    amount,
                ],
            });

            transactions.push({
                to: ctfContract,
                value: '0',
                data,
                operation: 0,
            });
            continue;
        }

        if (action.kind === 'ctf_redeem') {
            if (!action.collateralToken || !action.conditionId) {
                throw new Error('ctf_redeem requires collateralToken and conditionId');
            }
            const ctfContract = action.ctfContract
                ? getAddress(action.ctfContract)
                : config.polymarketConditionalTokens;
            if (!ctfContract) {
                throw new Error('ctf_redeem requires ctfContract or POLYMARKET_CONDITIONAL_TOKENS');
            }
            const parentCollectionId = action.parentCollectionId ?? ZERO_BYTES32;
            const indexSets = Array.isArray(action.indexSets) && action.indexSets.length > 0
                ? action.indexSets.map((value) => BigInt(value))
                : [1n, 2n];

            const data = encodeFunctionData({
                abi: conditionalTokensAbi,
                functionName: 'redeemPositions',
                args: [
                    getAddress(action.collateralToken),
                    parentCollectionId,
                    action.conditionId,
                    indexSets,
                ],
            });

            transactions.push({
                to: ctfContract,
                value: '0',
                data,
                operation: 0,
            });
            continue;
        }

        throw new Error(`Unknown action kind: ${action.kind}`);
    }

    return transactions;
}

async function makeDeposit({
    walletClient,
    account,
    config,
    asset,
    amountWei,
}) {
    const depositAsset = asset ? getAddress(asset) : config.defaultDepositAsset;
    const depositAmount =
        amountWei !== undefined ? amountWei : config.defaultDepositAmountWei;

    if (!depositAsset || depositAmount === undefined) {
        throw new Error('Deposit requires asset and amount (wei).');
    }

    if (depositAsset === zeroAddress) {
        return walletClient.sendTransaction({
            account,
            to: config.commitmentSafe,
            value: BigInt(depositAmount),
        });
    }

    return walletClient.writeContract({
        address: depositAsset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [config.commitmentSafe, BigInt(depositAmount)],
    });
}

async function makeErc1155Deposit({
    walletClient,
    account,
    config,
    token,
    tokenId,
    amount,
    data,
}) {
    if (!token || tokenId === undefined || amount === undefined) {
        throw new Error('ERC1155 deposit requires token, tokenId, and amount.');
    }

    const normalizedToken = getAddress(token);
    const normalizedTokenId = BigInt(tokenId);
    const normalizedAmount = BigInt(amount);
    if (normalizedAmount <= 0n) {
        throw new Error('ERC1155 deposit amount must be > 0.');
    }

    const transferData = data ?? '0x';

    return walletClient.writeContract({
        address: normalizedToken,
        abi: erc1155TransferAbi,
        functionName: 'safeTransferFrom',
        args: [
            account.address,
            config.commitmentSafe,
            normalizedTokenId,
            normalizedAmount,
            transferData,
        ],
    });
}

export {
    buildOgTransactions,
    makeErc1155Deposit,
    makeDeposit,
    normalizeOgTransactions,
    postBondAndDispute,
    postBondAndPropose,
};
