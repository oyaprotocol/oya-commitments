# Hormuz Copy Trader — Setup Guide

## What This Does

This bot watches a profitable Polymarket trader called **idfinsider0228** (who has $86K+ in profit) and automatically copies their BUY trades on the "Strait of Hormuz traffic returns to normal by end of April?" market.

Your funds are protected by a **Safe wallet** (a secure smart contract vault) with rules written in plain English that limit what the bot can do.

---

## Prerequisites

1. **Node.js** — Download from [nodejs.org](https://nodejs.org) (LTS version)
2. **Foundry** — Install by running in Terminal:
   ```
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```
3. **A Polygon wallet** with some MATIC (for gas) and USDC (for trading)
4. **The Oya Commitments repo** — Clone it:
   ```
   git clone https://github.com/oyaprotocol/oya-commitments.git
   cd oya-commitments
   ```

---

## Step 1: Deploy Your Safe Wallet

The Safe is the secure vault that holds your funds. The Optimistic Governor module lets the bot propose trades, but with a challenge period so bad trades can be blocked.

1. Copy the `.env.example` file in the repo root to `.env`
2. Fill in these values:
   ```
   DEPLOYER_PK=0xYOUR_PRIVATE_KEY
   OG_COLLATERAL=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
   OG_BOND_AMOUNT=250000000
   OG_RULES="This commitment accepts USDC deposits for copy-trading on the Strait of Hormuz Polymarket market. The agent copies BUY trades from idfinsider0228 at 99% of Safe balance. Maximum trade: $50. No other transfers allowed."
   ```
3. Deploy:
   ```
   forge script script/DeploySafeWithOptimisticGovernor.s.sol:DeploySafeWithOptimisticGovernor \
     --rpc-url https://polygon-rpc.com \
     --broadcast \
     --private-key YOUR_PRIVATE_KEY
   ```
4. The output will give you two addresses — save them:
   - **Safe address** — your vault
   - **OG Module address** — the governance module

---

## Step 2: Install This Agent

1. Copy the `oya-hormuz-copy-trader` folder into `oya-commitments/agent-library/agents/`:
   ```
   cp -r oya-hormuz-copy-trader oya-commitments/agent-library/agents/hormuz-copy-trader
   ```

2. Open `config.json` and fill in the addresses from Step 1:
   - `commitmentSafe` → your Safe address
   - `ogModule` → your OG Module address
   - `fundingWallet` → your personal wallet address (where the bot draws USDC from)

3. Set up the agent environment. Edit `oya-commitments/agent/.env`:
   ```
   SIGNER_TYPE=env
   PRIVATE_KEY=0xYOUR_PRIVATE_KEY
   RPC_URL=https://polygon-rpc.com
   AGENT_MODULE=hormuz-copy-trader

   # Polymarket CLOB API credentials (get these from Polymarket)
   POLYMARKET_CLOB_API_KEY=your_key
   POLYMARKET_CLOB_API_SECRET=your_secret
   POLYMARKET_CLOB_API_PASSPHRASE=your_passphrase
   ```

---

## Step 3: Fund Your Safe

Send USDC to your Safe address on Polygon. The bot will use 99% of whatever USDC is in the Safe for each copy trade (capped at $50).

Start small — even $10-20 is fine for testing.

---

## Step 4: Test It

Validate your agent module:
```
cd oya-commitments
node agent/scripts/validate-agent.mjs --module=hormuz-copy-trader
```

Run a smoke test:
```
node agent/scripts/testnet-harness.mjs smoke --module=hormuz-copy-trader --profile=local-mock
```

---

## Step 5: Run It

```
cd oya-commitments/agent
npm install
node src/index.js
```

The bot will:
1. Check every 30 seconds for new BUY trades from idfinsider0228
2. When it finds one, copy the trade at 99% of your Safe's USDC balance (max $50)
3. Deposit the outcome tokens (YES shares) into your Safe
4. Propose a USDC reimbursement transfer

---

## How Your Money Is Protected

- **Safe wallet** — Your funds live in a smart contract, not a regular wallet
- **Plain-English rules** — The commitment.txt file defines exactly what the bot can do
- **Challenge period** — After the bot proposes a trade, there's a window where it can be challenged if it violates the rules
- **$50 cap** — No single trade can exceed $50
- **One market only** — The bot can only trade on the Hormuz market

---

## Key Files

| File | What It Does |
|------|-------------|
| `commitment.txt` | Plain-English rules governing the bot |
| `agent.js` | The trading logic |
| `config.json` | Market addresses and settings |
| `agent.json` | Bot metadata |
