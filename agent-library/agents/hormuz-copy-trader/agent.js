// ---------------------------------------------------------------------------
// Oya Hormuz Copy Trader — Agent Logic
// ---------------------------------------------------------------------------
// Copies BUY trades from idfinsider0228 on the
// "Strait of Hormuz traffic returns to normal by end of April?" market.
//
// This file follows the Oya agent-library convention:
//   - getSignals()     → detect new trades from the source trader
//   - decide()         → determine whether to copy and build the transaction
//   - getSystemPrompt()→ provide LLM context (optional, for dispute resolution)
// ---------------------------------------------------------------------------

import { getClobTrades } from "../../../agent/src/lib/polymarket.js";
import {
  getAlwaysEmitBalanceSnapshotPollingOptions,
} from "../../../agent/src/lib/polling.js";
import {
  normalizeAddressOrNull,
} from "../../../agent/src/lib/utils.js";

// ---------------------------------------------------------------------------
// State: track which source trades we've already copied
// ---------------------------------------------------------------------------
const copiedTradeIds = new Set();

// ---------------------------------------------------------------------------
// getSignals — called each polling cycle by the runner
// ---------------------------------------------------------------------------
export async function getSignals(context) {
  const { config, safeBalance } = context;
  const cfg = config.byChain;

  // 1. Fetch recent trades from the source trader on this market
  const trades = await getClobTrades({
    host: cfg.clobHost,
    maker: cfg.sourceTraderAddress,
    market: cfg.polymarketYesTokenId, // filter to this token
  });

  // 2. Filter to only BUY trades we haven't copied yet
  const newBuys = (trades || []).filter(
    (t) => t.side === "BUY" && !copiedTradeIds.has(t.id)
  );

  // 3. Get Safe's current USDC balance
  const usdcBalance = safeBalance?.[cfg.usdcAddress] || 0;

  return {
    newBuys,
    usdcBalance,
    config: cfg,
  };
}

// ---------------------------------------------------------------------------
// decide — evaluate signals and return an action (or null to skip)
// ---------------------------------------------------------------------------
export async function decide(signals, context) {
  const { newBuys, usdcBalance, config: cfg } = signals;

  // Nothing to copy
  if (!newBuys || newBuys.length === 0) {
    return null;
  }

  // Not enough balance
  if (usdcBalance <= 0) {
    console.log("[hormuz-copy] No USDC balance in Safe — skipping.");
    return null;
  }

  // Copy the most recent BUY trade
  const trade = newBuys[0];

  // Calculate copy size: 99% of Safe balance, capped at maxTradeUsdc
  const rawSize = (usdcBalance * cfg.copyBps) / cfg.bpsDenominator;
  const size = Math.min(rawSize, cfg.maxTradeUsdc);

  if (size < 0.01) {
    console.log("[hormuz-copy] Calculated size too small — skipping.");
    return null;
  }

  // Mark as copied so we don't duplicate
  copiedTradeIds.add(trade.id);

  console.log(
    `[hormuz-copy] Copying BUY from ${cfg.sourceTraderAddress.slice(0, 10)}... ` +
    `| size: $${size.toFixed(2)} | source trade: ${trade.id}`
  );

  // Build the copy trade action
  return {
    action: "copy-buy",
    description:
      `Copy BUY trade from idfinsider0228 on Hormuz market. ` +
      `Source trade ID: ${trade.id}. ` +
      `Copy size: ${size.toFixed(2)} USDC (99% of Safe balance). ` +
      `Token: YES (${cfg.polymarketYesTokenId.slice(0, 16)}...).`,
    trade: {
      tokenId: cfg.polymarketYesTokenId,
      side: "BUY",
      size,
      sourceTradeId: trade.id,
    },
    // After the CLOB fill, the runner will:
    //   1. Deposit ERC-1155 outcome tokens into the Safe
    //   2. Propose a USDC reimbursement from Safe → funding wallet
    reimbursement: {
      to: cfg.fundingWallet,
      token: cfg.usdcAddress,
      amount: size,
      reason: `Reimbursement for copy-trade of source trade ${trade.id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// getSystemPrompt — context for LLM-based dispute resolution (optional)
// ---------------------------------------------------------------------------
export function getSystemPrompt() {
  return `You are evaluating whether a proposed transaction complies with the
commitment rules for the Hormuz Copy Trader agent.

The agent is ONLY allowed to:
1. Copy BUY trades from the source trader (idfinsider0228) on the
   "Strait of Hormuz traffic returns to normal" Polymarket market.
2. Size trades at exactly 99% of the Safe's USDC balance (1% fee).
3. Deposit received outcome tokens (ERC-1155) into the Safe.
4. Propose USDC reimbursement transfers to the funding wallet for
   the exact amount spent on filled orders.
5. Maximum single trade: $50 USDC.

The agent may NOT:
- Trade on any other market.
- Execute SELL trades.
- Transfer outcome tokens to anyone other than the depositor.
- Exceed the $50 per-trade cap.
- Propose transfers larger than the actual fill cost.`;
}

// ---------------------------------------------------------------------------
// getPollingOptions — configure how the runner polls for signals
// ---------------------------------------------------------------------------
export function getPollingOptions(config) {
  return {
    ...getAlwaysEmitBalanceSnapshotPollingOptions(config),
    intervalMs: 30_000, // check every 30 seconds
  };
}
