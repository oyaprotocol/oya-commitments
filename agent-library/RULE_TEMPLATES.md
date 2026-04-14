# Rule Templates

Use this file as the primary source when writing rules for a new agentic commitment. Before drafting fresh prose in `agent-library/agents/<agent-name>/commitment.txt`, review the templates below, select the ones that apply, and fill in the `[ ]` placeholders with commitment-specific values.

If a commitment's rules are assembled primarily from this file, set `agent-library/agents/<agent-name>/agent.json` to `commitmentType: "standard"`. Use `commitmentType: "freeform"` only for legacy or intentionally custom rule sets. `standard` is strongly encouraged for new commitments, especially for production deployments.

The usual workflow is:

1. Copy `agent-library/agents/default/` to `agent-library/agents/<agent-name>/`.
2. Review this file and select the applicable rule templates.
3. Assemble `commitment.txt` from those templates, replacing the copied default rule text.
4. Add custom rule language only for behavior that is not already covered here.

When a new commitment needs a reusable rule pattern that is missing from this file, coding agents and contributors should suggest a new template title plus body for later addition to `agent-library/RULE_TEMPLATES.md`. Prefer new templates for patterns likely to recur across commitments, not one-off value substitutions for a single deployment.

The format below is a rule title, a `---` separator, and the template text for that rule.

Agent Proxy
---
The agent at address [ ] may trade tokens in this commitment for different tokens, at the current fair market exchange rate. To execute the trade, they deposit tokens from their own wallet into the Safe, and propose to withdraw tokens of equal or lesser value. Token prices are based on the prices at the time of the deposit.

Proposal Delegation
---
Authorized users and agents may delegate transaction proposals to an Oya node, which proposes the transactions on their behalf and posts a bond. The delegated proposal must be signed by the address of the originator. (For example, a user's withdrawal proposal must be signed by the user, and an agent's trade reimbursement proposal must be signed by the agent.) The Oya node must include the proposal data and signature in the explanation field.

Solo User
---
This commitment accepts deposits from a single user at address [ ] and their designated agent at address [ ]. Deposits from any other address are credited to the user.

Recurring Fee
---
The designated agent at address [ ] accrues a recurring fee of [ ]% of the value in the commitment every [ ] days. The dollar value is calculated based on the fair token price at the end of each period. The agent may withdraw tokens equal to or less than the fees owed at any time after, with the value of the tokens withdrawn calculated at the time of the withdrawal proposal. The explanation for the withdrawal proposals must specify which period(s) the fee withdrawal represents.

Performance Fee
---
The designated agent at address [ ] accrues a performance fee of [ ]% of the increase in the value of the Safe over each [ ] day period. The dollar value is calculated based on the fair token price at the end of each period. The agent may withdraw tokens equal to or less than the fees owed at any time after, with the value of the tokens withdrawn calculated at the time of the withdrawal proposal. The explanation for the withdrawal proposals must specify which period(s) the fee withdrawal represents.

Standard Period
---
The standard period for calculating fees for this commitment is [ ] days, and the first period begins at deployment time.

Day Definition
---
For the purposes of these rules, a day is 86,400 seconds.

Time Period Start
---
Any time period specified in these rules begins at the deployment timestamp of this commitment.

Fee Withholding
---
Fees owed to the designated agent are withheld by the commitment until the agent withdraws them. The funds remaining in a commitment after user withdrawals must be enough to cover outstanding agent fees. If the funds remaining are less than or equal to what is still owed to an agent, the user may not make withdrawals.

Fair Valuation
---
Tokens are priced by their fair market value. Markets that are clearly manipulated are not a valid point-in-time data source.

Trade Restrictions
---
The agent may only trade between the following tokens or markets: [ ]

Withdrawal Restrictions
---
User withdrawals are limited to [ ] dollars in value every [ ] days.

Commitment Pause
---
This commitment may be paused by a proposal from the guardian address [ ]. The proposal should contain no transactions, but include a signed message of the word "pause" as the explanation field. During a pause, the agent may propose withdrawals only to close trades already initiated by a deposit from the agent, or fees owed to the agent. Additionally, if account recovery and rule updates are allowed, the recovery signers may propose a rule update during the pause. The guardian address [ ] may unpause the commitment with a proposal containing no transactions and a signed message of the word "unpause" as the explanation field. No other transaction proposals are valid during a pause.

Account Recovery and Rule Updates
---
These rules may be updated by a [ ]/[ ] consensus of addresses [ ]. After the rule update is executed, the new rules apply to all future transaction proposals.

Draft State
---
When this commitment has been deployed but no deposits have been made, it is considered to be in a draft state, and the deployer address may change the rule without limitation.

Polymarket Liquidity
---
The agent may only trade in Polymarket markets with a minimum liquidity of [ ].

Transfer Address Restrictions
---
Transfers from this Safe are limited to the primary user's address [ ], the designated agent's address [ ], and the following additional addresses: [ ]

Trading Limits
---
The designated agent at address [ ] may not execute more than [ ] dollars worth of trades per [hour/day/week].

Staked External Polymarket Execution
---
The designated agent at address [ ] must deposit a stake of [ ] to be considered the active agent. The agent will faithfully trade on Polymarket on behalf of the user outside of the commitment, with final execution settled within the commitment.

To track this external trading, the agent will periodically sign an updated log documenting all of their trades, and send to the node at address [ ] for a second signature, and publication to IPFS.

Trades must be logged within [ ] minutes of trade execution to be considered valid for reimbursement.

When a Polymarket market resolves, the agent must deposit the resulting winnings (if any) into the commitment to receive reimbursement for the initial trade(s). Or, if the agent has already exited the position before the market resolved, they must deposit any proceeds into the commitment to receive reimbursement. If the position was held until market resolution and it was a losing position, no deposit is necessary from the agent to claim reimbursement, since the value of the position is zero.

If the agent does not make the required deposit within [ ] hours of market resolution, they shall be considered in violation of this rule, and their stake will be forfeit in its entirety to the user.

After a rule violation, the agent may not claim any further reimbursement for any trades until they have deposited what they owe. They also may not make any additional trades on behalf of the user until they make another deposit renewing their stake.

The agent may quit the commitment by proposing to withdraw their stake, and writing "quit" as the proposal explanation. After proposing to quit, the agent may claim reimbursement for any valid trades up to that point, but may not perform any additional trades on behalf of the user.

If the agent's stake has been slashed due to a rule violation, and the agent does not deposit what they owe within [ ] (hours/days), the agent is considered to be in full default, and will not be reimbursed for any outstanding trades. All assets in the commitment at this point belong fully to the user. The user may update the rules to appoint a new agent.
