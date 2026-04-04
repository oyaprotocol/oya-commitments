# Copy-Trading Agent: Position Management Module Proposal

## Problem

The current copy-trading agent only copies BUY trades. If the source trader flips their position (e.g., sells YES, buys NO), the agent ignores the SELL and ends up holding conflicting positions instead of cleanly switching. Once tokens are deposited into the Safe, getting them back out requires an OG proposal + challenge period — too slow for reacting to a source trader's exit.

## Assumptions

- The Safe has **one user** (the depositor/owner)
- Two modules on the Safe: the **OG module** (reimbursement + redemption/distribution) and the **Position Management (PM) module** (agent trading within a single market)

## Current Lifecycle (BUY Only)

```
Source trader BUYs YES
  → Agent BUYs YES immediately (CLOB, agent wallet)
  → Agent deposits YES tokens into Safe
  → Agent proposes reimbursement (OG proposal, challenge period)
  → Reimbursement executes → cycle complete
```

## Proposed Design: Position Management (PM) Module

### Overview

A purpose-built **Position Management (PM) module** on the Safe handles all agent trading activity within a single market. The PM module is NOT an OG — it has its own rules that restrict the agent to buying and selling YES/NO tokens in the same market only. The existing OG module remains unchanged and handles the reimbursement and redemption/distribution proposals after market resolution.

### Full Lifecycle

```
Source trader BUYs YES (or any trade the agent copies)
  │
  │  ── AGENT TRADE ──
  │
  → Agent BUYs/SELLs tokens immediately (CLOB, agent wallet)
  → Agent deposits tokens into PM Module on Safe
  → PM Module returns equivalent USDC to agent minus 1% fee
  │
  │  ── ACTIVE POSITION MANAGEMENT PHASE ──
  │
  │  PM Module rules allow the agent to:
  │    • SELL YES tokens (same market only)
  │    • BUY NO tokens (same market only)
  │    • SELL NO tokens (same market only)
  │    • BUY YES tokens (same market only)
  │
  │  Agent follows source trader's moves freely:
  │    Source SELLs YES → Agent SELLs YES through PM Module
  │    Source BUYs NO   → Agent SELLs YES, BUYs NO through PM Module
  │    (any combination, as long as it's the same market)
  │
  │  ── MARKET RESOLVES ON UMA's OPTIMISTIC ORACLE ──
  │
  │  Positions can no longer change.
  │
  │  ── POST-RESOLUTION: REIMBURSEMENT ──
  │
  │  Agent sends reimbursement proposal to node proposer
  │  → Proposer posts proposal + bond (250 USDC) through OG Module
  │  → OG Module submits to UMA's OO for verification
  │  → Challenge period runs
  │  → If not disputed: agent collects their 1% fee
  │
  │  ── POST-RESOLUTION: REDEMPTION + DISTRIBUTION ──
  │
  │  Anyone can propose redemption + distribution
  │  → Proposer posts proposal + bond (250 USDC) through OG Module
  │  → OG Module submits to UMA's OO for verification
  │  → Challenge period runs
  │  → If not disputed: winning YES/NO tokens redeemed for USDC
  │  → USDC distributed to Safe user
  │
  └─ CYCLE COMPLETE — agent earns reputation based on outcome
```

### How the Modules Work Together

```
┌──────────────────────────────────────────────────────┐
│                  COMMITMENT SAFE                      │
│                  (1 user / depositor)                 │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │       Position Management (PM) Module            │  │
│  │       (purpose-built, NOT an OG)                 │  │
│  │                                                  │  │
│  │  What it does:                                   │  │
│  │  • Holds agent's YES/NO tokens                   │  │
│  │  • Returns USDC to agent minus 1% fee on deposit │  │
│  │  • Allows agent to BUY/SELL within SAME market   │  │
│  │  • Active until market resolves on UMA's OO      │  │
│  │                                                  │  │
│  │  What it prevents:                               │  │
│  │  • Agent trading in a different market            │  │
│  │  • Agent withdrawing tokens to their wallet       │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │       OG Module (existing, unchanged)            │  │
│  │                                                  │  │
│  │  What it does:                                   │  │
│  │  • Receives proposals from node proposer         │  │
│  │  • Submits proposals + bond to UMA's OO          │  │
│  │  • After verification:                           │  │
│  │    - Reimbursement: agent gets their 1% fee      │  │
│  │    - Redemption: tokens redeemed for USDC        │  │
│  │    - Distribution: USDC sent to Safe user        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Capital Flow Example

```
Safe user deposits 100 USDC into Safe
  │
  ▼ Source trader BUYs YES
  ▼ Agent BUYs 100 YES tokens on CLOB
  │
  ▼ Agent deposits 100 YES tokens into PM Module
  ▼ PM Module returns 99 USDC to agent (100 - 1% fee)
  │   └─ 1 USDC (agent fee) held until reimbursement
  │
  │  ... source trader sells YES, buys NO ...
  │
  ▼ Agent SELLs YES through PM Module
  ▼ Agent BUYs NO through PM Module
  │
  │  ... market resolves to NO ...
  │
  ▼ Agent sends reimbursement proposal to node proposer
  ▼ Proposer posts proposal + 250 USDC bond through OG Module → UMA's OO
  ▼ Verified → agent collects 1 USDC fee
  │
  ▼ Anyone proposes redemption + distribution through OG Module
  ▼ Proposer posts proposal + 250 USDC bond → UMA's OO
  ▼ Verified → NO tokens redeemed → USDC distributed to Safe user
```

### Why This Design Works

1. **Non-custodial**: Tokens are always in the PM Module on the Safe, never in the agent's personal wallet. The Safe user doesn't need to trust the agent.

2. **No time limit**: The agent can manage the position for the entire life of the market until it resolves on UMA's OO. This matches how real traders operate.

3. **Rule-enforced**: The PM Module's smart contract rules ensure the agent can ONLY trade within the same market. They can't move tokens elsewhere.

4. **Clean fee model**: The 1% fee is deducted on deposit, but the agent doesn't collect it until after market resolution + reimbursement verification through the OG Module. This ties the agent's pay to completing the full cycle.

5. **Clear separation of concerns**: PM Module handles trading. OG Module handles verification and fund movement. Each does one job.

### Agent Reputation

After each market cycle completes, the agent earns a reputation score based on their outcome. Did the agent's final position match the winning resolution? Win/loss records are visible onchain. Over time, agents with strong track records attract more users and can justify higher fees.

### Code Changes Required

#### 1. fetchLatestSourceTrade — Accept BUY and SELL trades

Current:
```javascript
if (parsed.side !== 'BUY') continue;
```

Proposed:
```javascript
// Accept both BUY and SELL trades for position tracking
if (parsed.side !== 'BUY' && parsed.side !== 'SELL') continue;
return parsed;
```

#### 2. enrichSignals — Position management awareness

After a trade fills, deposit to PM Module instead of directly to Safe:

```javascript
if (copyOrderFilled && pmModuleEnabled) {
    // Deposit tokens to PM Module
    // PM Module returns USDC minus fee to agent
    // Enter active position management phase

    // Continue monitoring source trader
    if (latestTrade && latestTrade.side === 'SELL' &&
        latestTrade.outcome === activeOutcome) {
        // Source trader exited → sell through PM Module
        exitReason = 'source_sold';
    }

    if (latestTrade && latestTrade.side === 'BUY' &&
        latestTrade.outcome !== activeOutcome) {
        // Source trader flipped → sell current, buy opposite through PM Module
        exitReason = 'source_flipped';
    }
}
```

#### 3. New PM Module interaction functions

```javascript
// Deposit tokens into PM Module
async function depositToPMModule(tokenId, amount) {
    // Transfer YES/NO tokens to PM Module
    // Module validates: same market only
    // Module returns USDC minus 1% fee
}

// Execute trade through PM Module
async function tradeViaPMModule(side, tokenId, amount) {
    // Module validates: same market only
    // Module executes trade on CLOB
}

// Check if market has resolved on UMA's OO
async function checkMarketResolved(conditionId) {
    // Query UMA Optimistic Oracle
    // Returns true if resolved
}

// Request reimbursement after market resolves
async function requestReimbursement(conditionId, feeAmount) {
    // Send reimbursement proposal to node proposer
    // Proposer posts through OG Module with bond
}
```

### Config Fields

```json
{
  "copyTrading": {
    "pmModuleAddress": "0x...",
    "positionManagementEnabled": true,
    "feeBps": 100
  }
}
```

- `pmModuleAddress`: Address of the PM Module on the Safe
- `positionManagementEnabled`: Toggle for the feature (default: false)
- `feeBps`: Agent fee in basis points (100 = 1%)

### Edge Cases

1. **Market resolves while agent has losing position**: Agent still collects their 1% fee via reimbursement proposal, but the losing tokens have no redemption value. Safe user bears the loss.

2. **Source trader makes many rapid trades**: PM Module allows all of them as long as they're in the same market. Agent follows each one.

3. **Agent goes offline**: Position stays in PM Module. Agent resumes when back online. If market resolved while offline, agent proceeds to reimbursement phase.

4. **Source trader never trades again after initial buy**: Position sits in PM Module until market resolution — agent still gets fee, user gets redemption outcome.

5. **USDC.e → native USDC migration**: PM Module needs to support whichever USDC variant Polymarket uses. Currently USDC.e, migrating to native USDC (~May 2026).

### What This Does NOT Change

- The OG module for proposal verification (unchanged)
- The node proposer infrastructure (unchanged)
- The 250 USDC bond mechanics for proposals (unchanged)
- How the CLOB API works for order placement (unchanged)

### Open Questions for John

1. **PM Module contract design**: What's the best pattern for a restricted module that allows trading within a single market only? New Solidity contract or adapting existing Safe module patterns?

2. **CLOB interaction**: Does the PM Module itself interact with the CLOB, or does the agent sign orders and the PM Module approves token transfers?

3. **Fee holding**: Where does the 1% fee sit between deposit and reimbursement? In the PM Module or in the Safe's general balance?

4. **Reputation tracking**: Onchain registry contract or offchain indexing from transaction history?
