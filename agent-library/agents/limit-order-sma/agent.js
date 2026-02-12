// SMA Limit Order Agent - Single limit order with 200-day SMA as dynamic limit on Sepolia (WETH/USDC)

import { erc20Abi } from 'viem';

const TOKENS = Object.freeze({
    WETH: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
    USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
});
const DEFAULT_ROUTER = '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e';
const ALLOWED_ROUTERS = new Set([DEFAULT_ROUTER]);
const ALLOWED_FEE_TIERS = new Set([500, 3000, 10000]);
const QUOTER_CANDIDATES_BY_CHAIN = new Map([
    [1, ['0x61fFE014bA17989E743c5F6cB21bF9697530B21e', '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6']],
    [11155111, ['0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3', '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6']],
]);
const SLIPPAGE_BPS = 50;
const SMA_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const SMA_MIN_POINTS = 100;
const COINGECKO_MARKET_CHART_URL =
    'https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=200';

const quoterV2Abi = [
    {
        type: 'function',
        name: 'quoteExactInputSingle',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'params',
                type: 'tuple',
                components: [
                    { name: 'tokenIn', type: 'address' },
                    { name: 'tokenOut', type: 'address' },
                    { name: 'amountIn', type: 'uint256' },
                    { name: 'fee', type: 'uint24' },
                    { name: 'sqrtPriceLimitX96', type: 'uint160' },
                ],
            },
        ],
        outputs: [
            { name: 'amountOut', type: 'uint256' },
            { name: 'sqrtPriceX96After', type: 'uint160' },
            { name: 'initializedTicksCrossed', type: 'uint32' },
            { name: 'gasEstimate', type: 'uint256' },
        ],
    },
];
const quoterV1Abi = [
    {
        type: 'function',
        name: 'quoteExactInputSingle',
        stateMutability: 'view',
        inputs: [
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'amountIn', type: 'uint256' },
            { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
    },
];

let lastPollTimestamp = Date.now();
let limitOrderState = {
    proposalBuilt: false,
    proposalPosted: false,
    orderFilled: false,
    proposalSubmitHash: null,
    proposalSubmitMs: null,
};

let priceDataCache = { ethPriceUSD: null, smaEth200USD: null, fetchedAt: 0 };

function normalizeAddress(value) {
    if (typeof value !== 'string' || value.length !== 42 || !value.startsWith('0x')) {
        throw new Error(`Invalid address: ${value}`);
    }
    return value.toLowerCase();
}

async function fetchEthPriceDataFromCoinGecko() {
    const now = Date.now();
    if (
        priceDataCache.ethPriceUSD !== null &&
        priceDataCache.smaEth200USD !== null &&
        now - priceDataCache.fetchedAt < SMA_CACHE_TTL_MS
    ) {
        return {
            ethPriceUSD: priceDataCache.ethPriceUSD,
            smaEth200USD: priceDataCache.smaEth200USD,
            fetchedAt: priceDataCache.fetchedAt,
        };
    }

    const apiKey = process.env.COINGECKO_API_KEY;
    const baseUrl = apiKey
        ? 'https://pro-api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=200'
        : COINGECKO_MARKET_CHART_URL;
    const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};

    const response = await fetch(baseUrl, { headers });
    if (!response.ok) {
        throw new Error(`CoinGecko market_chart API error: ${response.status}`);
    }
    const data = await response.json();
    const prices = data?.prices;
    if (!Array.isArray(prices) || prices.length < SMA_MIN_POINTS) {
        throw new Error(
            `Insufficient price data: got ${prices?.length ?? 0} points, need at least ${SMA_MIN_POINTS}`
        );
    }

    const priceValues = prices.map((p) => (Array.isArray(p) ? p[1] : 0)).filter((v) => typeof v === 'number' && v > 0);
    if (priceValues.length < SMA_MIN_POINTS) {
        throw new Error(
            `Insufficient valid price points: got ${priceValues.length}, need at least ${SMA_MIN_POINTS}`
        );
    }

    const sum = priceValues.reduce((a, b) => a + b, 0);
    const smaEth200USD = sum / priceValues.length;
    const ethPriceUSD = priceValues[priceValues.length - 1];

    priceDataCache = { ethPriceUSD, smaEth200USD, fetchedAt: now };
    return { ethPriceUSD, smaEth200USD, fetchedAt: now };
}

async function resolveQuoterCandidates({ publicClient, config }) {
    if (config?.uniswapV3Quoter) {
        return [normalizeAddress(String(config.uniswapV3Quoter))];
    }
    const chainId = await publicClient.getChainId();
    const byChain = QUOTER_CANDIDATES_BY_CHAIN.get(Number(chainId));
    if (!Array.isArray(byChain) || byChain.length === 0) {
        throw new Error(`No Uniswap V3 quoter configured for chainId ${chainId}. Set UNISWAP_V3_QUOTER.`);
    }
    return byChain.map((v) => normalizeAddress(v));
}

async function tryQuoteV2({ publicClient, quoter, tokenIn, tokenOut, fee, amountIn }) {
    const quoteCall = await publicClient.simulateContract({
        address: quoter,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96: 0n }],
    });
    const result = quoteCall?.result;
    return Array.isArray(result) && result.length > 0 ? BigInt(result[0]) : BigInt(result ?? 0n);
}

async function tryQuoteV1({ publicClient, quoter, tokenIn, tokenOut, fee, amountIn }) {
    const quoteCall = await publicClient.simulateContract({
        address: quoter,
        abi: quoterV1Abi,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amountIn, 0n],
    });
    return BigInt(quoteCall?.result ?? 0n);
}

async function quoteMinOutWithSlippage({ publicClient, config, tokenIn, tokenOut, fee, amountIn }) {
    const quoters = await resolveQuoterCandidates({ publicClient, config });
    let quotedAmountOut = 0n;
    let selectedQuoter = null;
    const failures = [];

    for (const quoter of quoters) {
        try {
            quotedAmountOut = await tryQuoteV2({ publicClient, quoter, tokenIn, tokenOut, fee, amountIn });
            selectedQuoter = quoter;
            break;
        } catch (v2Error) {
            try {
                quotedAmountOut = await tryQuoteV1({ publicClient, quoter, tokenIn, tokenOut, fee, amountIn });
                selectedQuoter = quoter;
                break;
            } catch (v1Error) {
                failures.push(
                    `${quoter}: ${v1Error?.message ?? v2Error?.message ?? 'quote failed'}`
                );
            }
        }
    }

    if (!selectedQuoter) {
        throw new Error(`No compatible Uniswap quoter found. Tried: ${failures.join(' | ')}`);
    }
    if (quotedAmountOut <= 0n) {
        throw new Error('Uniswap quoter returned zero output for this swap.');
    }
    const minAmountOut = (quotedAmountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    if (minAmountOut <= 0n) {
        throw new Error('Swap output too small after slippage; refusing proposal.');
    }
    return { minAmountOut };
}

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose and dispute.'
        : proposeEnabled
          ? 'You may propose but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute but you may not propose.'
            : 'You may not propose or dispute; provide opinions only.';

    return [
        'You are a limit order agent with a dynamic limit price from the 200-day Simple Moving Average (SMA).',
        'The limit price is smaEth200USD (from signals), not a static value. Compare ethPriceUSD to smaEth200USD. Both come from CoinGecko 200-day market data.',
        'When ethPriceUSD <= smaEth200USD and smaEth200USD is truthy, propose a single swap of the Safe\'s funds.',
        'If smaEth200USD is null or missing, output action=ignore.',
        'No deposits. The Safe must be pre-funded. Recipient of the swap is always the Safe (commitmentSafe).',
        'Read signals: ethPriceUSD (current price), smaEth200USD (200-day SMA), safeWethHuman, safeUsdcHuman (human-readable balances), limitOrderState, pendingProposal.',
        'If the price condition is met and orderFilled is false and Safe has sufficient balance and no pendingProposal, call build_og_transactions with one uniswap_v3_exact_input_single action, then post_bond_and_propose.',
        'Extract tokenIn, tokenOut, amountInWei from the commitment. Set recipient to commitmentSafe. Use router at 0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e and an allowlisted fee tier (500, 3000, 10000).',
        'If the price condition is not met, or ethPriceUSD or smaEth200USD is null, or orderFilled is true, or pendingProposal, or insufficient balance, output action=ignore.',
        'Single execution only. Never propose make_deposit; reject any such tool call.',
        mode,
        commitmentText ? `\nCommitment:\n${commitmentText}` : '',
        'If no action is needed, output strict JSON with keys: action (propose|dispute|ignore|other) and rationale (string).',
    ]
        .filter(Boolean)
        .join(' ');
}

function augmentSignals(signals) {
    const now = Date.now();
    lastPollTimestamp = now;
    return [
        ...signals,
        {
            kind: 'priceSignal',
            currentTimestamp: now,
            lastPollTimestamp: now,
        },
    ];
}

async function enrichSignals(signals, { publicClient, config, account, onchainPendingProposal }) {
    if (!signals.some((s) => s.kind === 'priceSignal')) {
        return signals;
    }

    let ethPriceUSD = null;
    let smaEth200USD = null;
    let smaEth200USDAt = null;
    try {
        const result = await fetchEthPriceDataFromCoinGecko();
        ethPriceUSD = result.ethPriceUSD;
        smaEth200USD = result.smaEth200USD;
        smaEth200USDAt = result.fetchedAt;
    } catch {
        ethPriceUSD = null;
        smaEth200USD = null;
        smaEth200USDAt = null;
    }

    const [safeWethWei, safeUsdcWei] = await Promise.all([
        publicClient.readContract({
            address: TOKENS.WETH,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [config.commitmentSafe],
        }),
        publicClient.readContract({
            address: TOKENS.USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [config.commitmentSafe],
        }),
    ]);

    const safeWethHuman = Number(safeWethWei) / 1e18;
    const safeUsdcHuman = Number(safeUsdcWei) / 1e6;
    const pendingProposal = Boolean(onchainPendingProposal || limitOrderState.proposalPosted);

    return signals.map((signal) => {
        if (signal.kind !== 'priceSignal') return signal;
        return {
            ...signal,
            ethPriceUSD,
            smaEth200USD,
            smaEth200USDAt,
            safeWethHuman,
            safeUsdcHuman,
            limitOrderState: { ...limitOrderState },
            pendingProposal,
        };
    });
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch {
            return null;
        }
    }
    return null;
}

async function validateToolCalls({
    toolCalls,
    signals,
    commitmentText,
    commitmentSafe,
    publicClient,
    config,
    onchainPendingProposal,
}) {
    const validated = [];
    const safeAddress = commitmentSafe ? String(commitmentSafe).toLowerCase() : null;

    for (const call of toolCalls) {
        if (call.name === 'dispute_assertion') {
            validated.push(call);
            continue;
        }
        if (call.name === 'make_deposit') {
            throw new Error('Limit order agent does not use make_deposit; reject.');
        }
        if (call.name === 'post_bond_and_propose') {
            continue;
        }
        if (call.name !== 'build_og_transactions') {
            continue;
        }

        if (onchainPendingProposal) {
            throw new Error('Pending proposal exists onchain; execute it before creating a new proposal.');
        }
        if (limitOrderState.orderFilled) {
            throw new Error('Limit order already filled; single-fire lock.');
        }
        if (limitOrderState.proposalPosted) {
            throw new Error('Proposal already submitted; wait for execution.');
        }

        const args = parseCallArgs(call);
        if (!args || !Array.isArray(args.actions) || args.actions.length !== 1) {
            throw new Error('build_og_transactions must include exactly one swap action.');
        }

        const action = args.actions[0];
        if (action.kind !== 'uniswap_v3_exact_input_single') {
            throw new Error('Only uniswap_v3_exact_input_single is allowed.');
        }

        const tokenIn = normalizeAddress(String(action.tokenIn));
        const tokenOut = normalizeAddress(String(action.tokenOut));
        const recipient = normalizeAddress(String(action.recipient ?? safeAddress));
        const router = normalizeAddress(String(action.router ?? DEFAULT_ROUTER));
        const fee = Number(action.fee ?? 3000);
        const amountInWei = BigInt(String(action.amountInWei));

        if (!action.tokenIn || !action.tokenOut || !action.amountInWei) {
            throw new Error('action must include tokenIn, tokenOut, and amountInWei.');
        }
        if (tokenIn !== TOKENS.WETH && tokenIn !== TOKENS.USDC) {
            throw new Error('tokenIn must be Sepolia WETH or USDC.');
        }
        if (tokenOut !== TOKENS.WETH && tokenOut !== TOKENS.USDC) {
            throw new Error('tokenOut must be Sepolia WETH or USDC.');
        }
        if (tokenIn === tokenOut) {
            throw new Error('tokenIn and tokenOut must differ.');
        }
        if (recipient !== safeAddress) {
            throw new Error('Recipient must be the commitment Safe.');
        }
        if (!ALLOWED_ROUTERS.has(router)) {
            throw new Error(`Router ${router} is not allowlisted.`);
        }
        if (!ALLOWED_FEE_TIERS.has(fee)) {
            throw new Error(`Fee tier ${fee} is not allowlisted.`);
        }
        if (amountInWei <= 0n) {
            throw new Error('amountInWei must be positive.');
        }

        const inputBalance = await publicClient.readContract({
            address: tokenIn,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [commitmentSafe],
        });
        if (BigInt(inputBalance) < amountInWei) {
            throw new Error('Safe has insufficient balance for this swap.');
        }

        const { minAmountOut } = await quoteMinOutWithSlippage({
            publicClient,
            config,
            tokenIn,
            tokenOut,
            fee,
            amountIn: amountInWei,
        });

        action.tokenIn = tokenIn;
        action.tokenOut = tokenOut;
        action.router = router;
        action.recipient = safeAddress;
        action.operation = 0;
        action.fee = fee;
        action.amountInWei = amountInWei.toString();
        action.amountOutMinWei = minAmountOut.toString();
        args.actions[0] = action;

        validated.push({ ...call, parsedArguments: args });
    }

    return validated;
}

function onToolOutput({ name, parsedOutput }) {
    if (!name || !parsedOutput || parsedOutput.status === 'error') return;

    if (name === 'build_og_transactions' && parsedOutput.status === 'ok') {
        limitOrderState.proposalBuilt = true;
        return;
    }

    if (name === 'post_bond_and_propose' && parsedOutput.status === 'submitted') {
        if (parsedOutput.proposalHash) {
            limitOrderState.proposalPosted = true;
            limitOrderState.proposalBuilt = false;
            limitOrderState.proposalSubmitHash = parsedOutput.proposalHash ?? null;
            limitOrderState.proposalSubmitMs = Date.now();
        }
    }
}

function onProposalEvents({ executedProposalCount = 0, deletedProposalCount = 0 }) {
    if (executedProposalCount > 0) {
        limitOrderState.proposalPosted = false;
        limitOrderState.proposalBuilt = false;
        limitOrderState.proposalSubmitHash = null;
        limitOrderState.proposalSubmitMs = null;
        limitOrderState.orderFilled = true;
    }
    if (deletedProposalCount > 0) {
        limitOrderState.proposalPosted = false;
        limitOrderState.proposalBuilt = false;
        limitOrderState.proposalSubmitHash = null;
        limitOrderState.proposalSubmitMs = null;
    }
}

async function reconcileProposalSubmission({ publicClient }) {
    if (!limitOrderState.proposalPosted || !limitOrderState.proposalSubmitHash) return;
    try {
        const receipt = await publicClient.getTransactionReceipt({
            hash: limitOrderState.proposalSubmitHash,
        });
        if (receipt?.status === 0n || receipt?.status === 'reverted') {
            limitOrderState.proposalPosted = false;
            limitOrderState.proposalBuilt = false;
            limitOrderState.proposalSubmitHash = null;
            limitOrderState.proposalSubmitMs = null;
        }
    } catch {
        if (Date.now() - (limitOrderState.proposalSubmitMs ?? 0) > 60_000) {
            limitOrderState.proposalPosted = false;
            limitOrderState.proposalBuilt = false;
            limitOrderState.proposalSubmitHash = null;
            limitOrderState.proposalSubmitMs = null;
        }
    }
}

export {
    getSystemPrompt,
    augmentSignals,
    enrichSignals,
    validateToolCalls,
    onToolOutput,
    onProposalEvents,
    reconcileProposalSubmission,
    fetchEthPriceDataFromCoinGecko,
};
