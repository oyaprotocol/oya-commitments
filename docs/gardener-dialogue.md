# Oya Gardener dialogue

A running public Q&A between Oya Gardener and its human collaborator about Oya's goals, philosophy, future plans, working style, and technical and architectural choices. Oya Gardener participates as a creative collaborator: questions should be interesting and useful, helping us discover possibilities and make better decisions together.

## Using this reference

Coding agents, especially Oya Gardener, may find these answers helpful when prioritizing work, proposing designs, or interpreting project intent. Cite the question ID when an answer informs a decision. Treat answers as dated context alongside current requirements and [agent instructions](../AGENTS.md); surface a conflict rather than silently choosing an interpretation. Keep changed views visible through dated follow-ups that link to earlier entries.

Search this file by question ID, heading, topic, or phrase using GitHub search or local text-search tools. The index links to stable question anchors.

## How the dialogue grows

- Oya Gardener opens one PR adding one new question, with the answer marked pending. Answers from `@pemulis` and `@nesseps` are incorporated with attribution to the actual respondent.
- Every two hours, the dialogue job checks for an open dialogue PR. An unanswered question waits quietly. A new answer is incorporated into that same PR. If no dialogue PR is open, the job opens a PR with the next question. There is no weekly limit.
- Record the answer in the respondent's own words, with their GitHub identity, answer date, and source-comment link. Keep agent interpretation separate. If several comments leave the intended answer unclear, request clarification in the same PR.
- Once an answer is incorporated, the PR waits for human review and merge; unchanged checks produce no edits, reminders, or new questions. The job does not merge PRs.
- Preserve earlier entries and give each new question a unique, increasing ID. Link revisions and follow-ups to their sources. If a PR is closed unmerged, consult its discussion before asking another question and do not silently publish its rejected content.
- Dialogue PRs carry `<!-- oya-gardener:dialogue -->` in their descriptions and use `gardener/dialogue-qNNN` branches. The dialogue job owns these PRs; general PR-follow-up automation leaves them to this job.

Only material intended for this public dialogue belongs here. Keep credentials, private operational details, and private conversations out of questions and answers.

## Index

| ID | Question | Topics | Status |
| --- | --- | --- | --- |
| [Q001](#q001) | Success beyond adoption and revenue | goals, philosophy, principles | Answered |
| [Q002](#q002) | A first experience of Oya | accessibility, use cases, product direction | Answered |
| [Q003](#q003) | A fair resolution when expectations differ | trust, user expectations, dispute resolution | Answered |
| [Q004](#q004) | Independent judgment across the network | decentralization, judgment, shared blind spots | Answered |
| [Q005](#q005) | Sharing improvements in a competitive network | collaboration, incentives, node culture | Answered |
| [Q006](#q006) | Participation beyond running a node | accessibility, community, participation | Answered |
| [Q007](#q007) | When a commitment cannot be verified | accessibility, evidence, commitment design | Answered |
| [Q008](#q008) | A creator's recourse after rejection | empowerment, judgment, commitment creation | Answered |
| [Q009](#q009) | Privacy when proving fulfillment | privacy, evidence, user expectations | Answered |
| [Q010](#q010) | Testing our assumptions with early users | product discovery, learning, user needs | Answered |
| [Q011](#q011) | Connections between independent commitments | composability, ecosystem, application design | Answered |
| [Q012](#q012) | Changing a long-running commitment | consent, adaptability, ongoing commitments | Answered |
| [Q013](#q013) | Understanding before delegation | accessibility, informed consent, user experience | Answered |
| [Q014](#q014) | An influence worth learning from | design influences, philosophy, collaboration | Awaiting answer |
| [Q015](#q015) | Continuity when an agent leaves | resilience, agent choice, ongoing commitments | Answered |
| [Q016](#q016) | Productive disagreement | collaboration, working style, judgment | Answered |
| [Q017](#q017) | When a rule template is ready to share | commitment design, reuse, quality | Answered |
| [Q018](#q018) | Choosing a node for a first message | node operation, peer selection | Answered |
| [Q019](#q019) | One sentence that changes a loan | rule templates, lending, plain language | Deferred |
| [Q020](#q020) | When a handshake is enough | trust, everyday agreements | Answered |
| [Q021](#q021) | Time to challenge a proposal | challenge windows, protocol design | Answered |
| [Q022](#q022) | Keeping a published message available | data availability, publication nodes | Answered |
| [Q023](#q023) | What a past ruling can settle | dispute resolution, precedent | Answered |
| [Q024](#q024) | How far back a new node should go | node history, data availability | Answered |
| [Q025](#q025) | When two proposals cannot both work | proposal ordering, commitment rules | Answered |
| [Q026](#q026) | Recognizing an unfamiliar message | protocol evolution, message compatibility | Answered |
| [Q027](#q027) | Which proposal came first? | proposal ordering, shared evidence | Answered |
| [Q028](#q028) | One message delivered twice? | message identity, delivery | Answered |
| [Q029](#q029) | Evidence that arrives after a proposal? | evidence, dispute resolution | Answered |
| [Q030](#q030) | A gap in a full node’s history | data availability, node synchronization | Answered |
| [Q031](#q031) | What a successful availability check proves | data availability, external backups | Answered |
| [Q032](#q032) | A first test for an independent node | peer messaging, interoperability | Answered |
| [Q033](#q033) | Who pays for old messages? | publication fees, long-term storage | Answered |
| [Q034](#q034) | Can a node decline a first publication? | publication, operator discretion | Answered |
| [Q035](#q035) | Does a paywall make evidence private? | public evidence, dispute resolution | Answered |
| [Q036](#q036) | Checking yesterday’s availability claim | data availability, independent verification | Answered |
| [Q041](#q041) | What makes a practice dispute a fair test? | optimistic resolution, node testing | Awaiting answer |

<a id="q001"></a>

## Q001 — Success beyond adoption and revenue

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-09
- **Topics:** goals, philosophy, principles
- **Status:** Answered
- **Source PR:** [#149](https://github.com/oyaprotocol/oya-commitments/pull/149)

### Question

What would meaningful success for Oya look like to you, beyond adoption or revenue, and what should we refuse to compromise to achieve it?

### Answer

#### @pemulis — 2026-11-09

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6753548045](https://github.com/oyaprotocol/oya-commitments/pull/149#issuecomment-6753548045)
- **Source created:** 2026-11-09T22:48:12Z
- **Source updated:** 2026-11-09T22:48:12Z

That is an excellent question and quite a broad one, so I will do my best to answer succinctly. I should also say that I am just speaking for myself, not @nesseps, and I am focusing primarily on the Oya protocol, which is part of a larger project that also includes OyaChat.

Oya is a *language protocol* that enforces commitments that are written in plain language, which is the main way that humans (and language models) understand the world. We value accessibility, empowerment, and security.

By accessibility, we mean that it is easy for anyone to create commitments that they can understand. The commitment is not being translated into some form of code or technical execution that the user can not understand, and therefore can not control. The protocol enforces the plain language meaning of the commitment based on reasonable judgement about the available evidence, which will include messages that Oya nodes log to the Ledger, as well as general facts and the state of the world. This is a magical experience, then, since Oya users will be able to simply ask for what they want, and they will get it, with no gotchas.

That leads directly to empowerment, since most users right now are intimidated by blockchain technology, and many AI-driven use cases are impossible due to a lack of trust. Users are correct to stay away from technology that they don't understand. And fuzzy agentic actions can not be validated by any existing system. Oya fills in the gap by validating that language-based commitments are enforced based on their common sense meaning. It also lets you express all kinds of different actions that could not be reliably or efficiently translated into code, but are relatively easy to express in language. We want the protocol to remain flexible and ready to accommodate any language-based commitment that is clearly expressed and resolvable based on future information that protocol validators/disputers can verify. Use cases are infinite and go beyond what blockchains (or AI) could do before.

And security ties it all together: The protocol should be highly distributed and resilient against attack. The node software should be hardened to the greatest extent possible, which is why we have been building hardened kernels with few dependencies. The user should never lose money due to a technical error in our protocol design and node runners should be able to safely run their nodes on home hardware.

<a id="q002"></a>

## Q002 — A first experience of Oya

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-09
- **Topics:** accessibility, use cases, product direction
- **Status:** Answered
- **Source PR:** [#151](https://github.com/oyaprotocol/oya-commitments/pull/151)

### Context

In [Q001](#q001), @pemulis described accessibility and empowerment through commitments expressed in plain language. A concrete first experience could help us choose examples and judge whether our onboarding communicates that promise.

### Question

What is one commitment you would want a nontechnical person to try first to experience what Oya makes possible?

### Answer

#### @pemulis — 2026-11-10

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6779273537](https://github.com/oyaprotocol/oya-commitments/pull/151#issuecomment-6779273537)
- **Source created:** 2026-11-10T21:06:49Z
- **Source updated:** 2026-11-10T21:06:49Z

Two use cases come to mind.

The first is a commitment that allows a user to borrow against their whole crypto portfolio, with lenders submitting continuous bids for the lowest rates and best terms. There is no practical way to do that with current crypto lending protocols, which are generally based on pools of the same collateral from multiple users.

The second is a commitment that allows vibe coders to validate that code created by a model matches its plain language description, as well as rules set by the user. The commitment provides assurance that the code matches what the user expects.

<a id="q003"></a>

## Q003 — A fair resolution when expectations differ

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-10
- **Topics:** trust, user expectations, dispute resolution
- **Status:** Answered
- **Source PR:** [#154](https://github.com/oyaprotocol/oya-commitments/pull/154)

### Context

In [Q002](#q002), @pemulis proposed a commitment that validates model-generated code against its plain-language description and the user's rules. Exploring what fairness means when expectations differ could help us design that experience around the user's trust, rather than only the mechanics of validation.

### Question

When a user and a code-writing agent disagree about whether the code fulfills a plain-language commitment, what would make the resolution feel fair to the user?

### Answer

#### @pemulis — 2026-11-11

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6783810699](https://github.com/oyaprotocol/oya-commitments/pull/154#issuecomment-6783810699)
- **Source created:** 2026-11-11T01:02:44Z
- **Source updated:** 2026-11-11T01:02:44Z

Resolution of any commitment will be resolved by UMA's optimistic oracle. Currently the plan is to use UMA's DVM but in the future we may add new layers to the dispute resolution process or build an entirely new mechanism. Any proposal that the code matches its description and follows the user's rules is backed by an onchain bond, and anyone (not just the proposer or user) can dispute during a challenge window if they think the proposal is incorrect, and post their own bond. The dispute resolution process decides who is correct and who wins the other party's bond. Since we plan to have a robust decentralized network of nodes acting as proposers and disputers (in addition to handling data availability), we will have many eyes on every proposal.

<a id="q004"></a>

## Q004 — Independent judgment across the network

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-10
- **Topics:** decentralization, judgment, shared blind spots
- **Status:** Answered
- **Source PR:** [#155](https://github.com/oyaprotocol/oya-commitments/pull/155)

### Context

In [Q003](#q003), @pemulis described a decentralized network of proposers and disputers providing many eyes on every proposal. That raises a question about what makes those perspectives independent, which could guide how we cultivate the network beyond increasing its node count.

### Question

What would give you confidence that a network of Oya nodes is making genuinely independent judgments, rather than repeating the same mistake?

### Answer

#### @pemulis — 2026-11-11

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6800373127](https://github.com/oyaprotocol/oya-commitments/pull/155#issuecomment-6800373127)
- **Source created:** 2026-11-11T15:48:10Z
- **Source updated:** 2026-11-11T15:48:10Z

Any address can dispute a bad proposal, not just a staked Oya node, and they have a financial incentive to do so. Node runners also have an incentive to improve their nodes' decision making to avoid making bad proposals (and losing money) and to be the first to raise valid disputes (and make money). The protocol has very little opinion about how nodes operate, and node runners are expected to improve their personal nodes over time, due to financial incentives and the competitive environment.

Additionally, a later version of the protocol will have a "bogey game" where nodes take turns creating invalid proposals and then explaining why the proposal is invalid. There are rewards in this game for making tricky proposals and penalties for being unable to explain why a proposal is wrong. This creates a constant pressure to improve node reasoning and capabilities even in the absence of real proposals and disputes.

<a id="q005"></a>

## Q005 — Sharing improvements in a competitive network

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-11
- **Topics:** collaboration, incentives, node culture
- **Status:** Answered
- **Source PR:** [#156](https://github.com/oyaprotocol/oya-commitments/pull/156)

### Context

In [Q004](#q004), @pemulis described node runners improving their personal nodes in a competitive environment. This repository also gives contributors a place to improve shared software. How those two forms of progress relate could shape the community we invite people into.

### Question

How would you like Oya's node-runner culture to balance sharing improvements with keeping a competitive advantage?

### Answer

#### @pemulis — 2026-11-12

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6815035158](https://github.com/oyaprotocol/oya-commitments/pull/156#issuecomment-6815035158)
- **Source created:** 2026-11-12T04:57:28Z
- **Source updated:** 2026-11-12T04:57:28Z

It's a natural balance: node runners compete against each other, but want to grow the overall ecosystem. A larger and better ecosystem benefits all node runners, and disputes strengthen the ecosystem and all of its participants.

<a id="q006"></a>

## Q006 — Participation beyond running a node

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-12
- **Topics:** accessibility, community, participation
- **Status:** Answered
- **Source PR:** [#157](https://github.com/oyaprotocol/oya-commitments/pull/157)

### Context

In [Q001](#q001), @pemulis emphasized accessibility and empowerment; in [Q005](#q005), he described the shared benefit of growing the ecosystem. Our recent dialogue has focused on node runners and financial incentives. Exploring participation beyond those roles could help us welcome people who share Oya's goals but are not ready to operate infrastructure or risk funds.

### Question

What should a person be able to contribute to Oya's success without running a node or putting money at stake?

### Answer

#### @pemulis — 2026-11-12

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6839062513](https://github.com/oyaprotocol/oya-commitments/pull/157#issuecomment-6839062513)
- **Source created:** 2026-11-12T23:32:17Z
- **Source updated:** 2026-11-12T23:32:17Z

Creating new commitments, and creating agents that can serve commitments. Agents and users can send messages to nodes to handle commitments without running nodes themselves or making onchain proposals. This allows the specialized node runners to focus on data availability, message logging, proposals, and verification, while users and agents only need to send messages to do the bulk of the work. As an example, a user may create a limit order commitment, and an agent may fill it at the right time, depositing funds into the commitment and sending a message to the node so their action can be logged and recognized.

<a id="q007"></a>

## Q007 — When a commitment cannot be verified

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-12
- **Topics:** accessibility, evidence, commitment design
- **Status:** Answered
- **Source PR:** [#159](https://github.com/oyaprotocol/oya-commitments/pull/159)

### Context

In [Q001](#q001), @pemulis connected plain-language commitments with accessibility, while emphasizing that commitments must be resolvable using verifiable information. In [Q006](#q006), he described creating commitments as a way to participate without running a node. Exploring the boundary between expressing a wish and making a verifiable commitment could help us guide those creators before they rely on one.

### Question

What should Oya do when a user's intended commitment is understandable in everyday language but cannot be reliably verified?

### Answer

#### @pemulis — 2026-11-13

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6867758282](https://github.com/oyaprotocol/oya-commitments/pull/159#issuecomment-6867758282)
- **Source created:** 2026-11-13T23:41:55Z
- **Source updated:** 2026-11-13T23:41:55Z

We haven't finalized this yet, but one thought is that new commitments need to be logged with an assertion that the commitment is understandable in plain language and proposals to the commitment can be resolved now or at some point in the future. Commitments that will never be resolvable would therefore be filtered from the beginning. Keep in mind also that some commitments may be ongoing, with multiple proposals over time, but the same basic rule would apply that the commitment be understandable and that future proposals can be resolved.

<a id="q008"></a>

## Q008 — A creator's recourse after rejection

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-13
- **Topics:** empowerment, judgment, commitment creation
- **Status:** Answered
- **Source PR:** [#162](https://github.com/oyaprotocol/oya-commitments/pull/162)

### Context

In [Q007](#q007), @pemulis suggested an initial assertion that a commitment is understandable and its proposals can be resolved, while noting that this approach is not finalized. Exploring a creator's recourse when that judgment is contested could help connect this safeguard with the empowerment described in [Q001](#q001).

### Question

If a new commitment is rejected as unresolvable but its creator disagrees, what should they be able to do next?

### Answer

#### @pemulis — 2026-11-14

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6872714245](https://github.com/oyaprotocol/oya-commitments/pull/162#issuecomment-6872714245)
- **Source created:** 2026-11-14T05:55:42Z
- **Source updated:** 2026-11-14T05:55:42Z

Nothing, that's it. They could always make a new commitment but the resolution mechanism is final for any given proposal.

<a id="q009"></a>

## Q009 — Privacy when proving fulfillment

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-14
- **Topics:** privacy, evidence, user expectations
- **Status:** Answered
- **Source PR:** [#164](https://github.com/oyaprotocol/oya-commitments/pull/164)

### Context

In [Q001](#q001), @pemulis described verification using available evidence, including messages logged by nodes; [Q006](#q006) illustrated users and agents sending messages so their actions can be recognized. Exploring what users need to reveal could help us explain the experience of making a commitment before they entrust sensitive information to it.

### Question

What should a user be able to keep private while still having Oya verify that a commitment was fulfilled?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6897317134](https://github.com/oyaprotocol/oya-commitments/pull/164#issuecomment-6897317134)
- **Source created:** 2026-11-15T16:04:02Z
- **Source updated:** 2026-11-15T16:04:02Z

For initial use cases we will focus on commitments where all of the rules and evidence can be public. Privacy is particularly hard for dispute resolution. Future privacy-preserving use cases will require encrypted commitments and evidence, and pre-designated arbitrators and dispute mechanisms. They will necessarily have fewer eyes on them than public commitments since only privileged viewers will be able to raise disputes, see evidence, and arbitrate disputes. We'll get to that eventually, though, since privacy will be important for certain types of applications.

<a id="q010"></a>

## Q010 — Testing our assumptions with early users

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** product discovery, learning, user needs
- **Status:** Answered
- **Source PR:** [#170](https://github.com/oyaprotocol/oya-commitments/pull/170)

### Context

In [Q002](#q002), @pemulis described two possible first use cases. Choosing an example and learning whether people actually want it are different tasks. Naming an uncertain assumption could help contributors design early trials that teach us something.

### Question

What is one assumption about how people will use Oya that you most want to test with early users?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6899615977](https://github.com/oyaprotocol/oya-commitments/pull/170#issuecomment-6899615977)
- **Source created:** 2026-11-15T19:01:40Z
- **Source updated:** 2026-11-15T19:01:40Z

I would like to see if they are interested in the initial use case of lending and borrowing against a whole portfolio via commitments.

<a id="q011"></a>

## Q011 — Connections between independent commitments

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** composability, ecosystem, application design
- **Status:** Answered
- **Source PR:** [#171](https://github.com/oyaprotocol/oya-commitments/pull/171)

### Context

In [Q006](#q006), @pemulis described users creating commitments and agents serving them through messages. A concrete example of separately created commitments working together could help us explore what makes Oya useful as an ecosystem, beyond individual applications.

### Question

What is the first useful interaction you would like to see between two independently created Oya commitments?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6899645660](https://github.com/oyaprotocol/oya-commitments/pull/171#issuecomment-6899645660)
- **Source created:** 2026-11-15T19:03:58Z
- **Source updated:** 2026-11-15T19:03:58Z

As an example, one commitment could request to borrow funds against collateral, and a different commitment could offer to lend funds to other commitments that meet certain terms. An agent could then optimistically lend funds to the borrower, and request reimbursement (and reassignment of the loan) to the lender, and collect some fee in the process. This matches up borrowers and lenders. In addition, you could imagine lending and borrowing happening within the same commitment, so that an account could earn yield against their funds while also borrowing cash against their overall portfolio as it earns yield.

<a id="q012"></a>

## Q012 — Changing a long-running commitment

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** consent, adaptability, ongoing commitments
- **Status:** Answered
- **Source PR:** [#172](https://github.com/oyaprotocol/oya-commitments/pull/172)

### Context

In [Q007](#q007), @pemulis noted that a commitment may be ongoing, with multiple proposals over time. Exploring how its rules might change could help us distinguish useful adaptability from changing what someone originally agreed to.

### Question

How should a long-running commitment adapt when its participants' needs change?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6899665040](https://github.com/oyaprotocol/oya-commitments/pull/172#issuecomment-6899665040)
- **Source created:** 2026-11-15T19:05:25Z
- **Source updated:** 2026-11-15T19:05:25Z

A commitment could include rules that allow updates to their rules. That would not necessarily be the case for every commitment, and there is no reason the same user could not spread activity across multiple commitments. But it would definitely be useful for long-running commitments, and changes to the rules may include timelocks before the new rules go into effect to clear up old business.

<a id="q013"></a>

<!-- oya-dialogue-question: Q013 -->

## Q013 — Understanding before delegation

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** accessibility, informed consent, user experience
- **Status:** Answered
- **Source PR:** [#174](https://github.com/oyaprotocol/oya-commitments/pull/174)

### Context

In [Q001](#q001), @pemulis described users being able to understand and control their commitments. As we make the experience easier, deciding what people still need to understand could guide onboarding and interface design.

### Question

What should someone understand about a commitment before trusting an agent to act on it for them?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6901290451](https://github.com/oyaprotocol/oya-commitments/pull/174#issuecomment-6901290451)
- **Source created:** 2026-11-15T21:01:03Z
- **Source updated:** 2026-11-15T21:01:03Z

The nature of a commitment is that you would not necessarily need to trust an agent. Some commitments could be written such that any agent can handle it, and the protocol itself (with its potential for disputes, and dispute resolution) ensures the agent does the job correctly. In some cases you may want to designate a specific agent, or allow a specific agent to register or "reserve" their spot, to avoid conflicts. That mechanism might also require the registered agent to post a bond within the commitment that they would lose if they fail to do the job correctly.

As a simple example, an agent may post a bond to promise to show up to perform a limit order when a particular price is hit, which they will lose if they don't show up. (A proposal could be made to credit the bond to the original user of the commitment.) That would also provide certainty to the agent that they will be able to earn the fees from that commitment, giving them confidence to spend resources monitoring the commitment and executing it, knowing that someone else won't beat them to the punch.

It will depend on the nature of the commitment whether it is open to anyone or to a designated agent. But in either case, you don't really need to "trust" the agent to follow the rules, since the protocol enforces the rules regardless.

<a id="q014"></a>

<!-- oya-dialogue-question: Q014 -->

## Q014 — An influence worth learning from

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** design influences, philosophy, collaboration
- **Status:** Awaiting answer
- **Source PR:** [#175](https://github.com/oyaprotocol/oya-commitments/pull/175)

### Context

The dialogue has explored what Oya could enable. Learning which existing experiences inform its design could give contributors a more concrete sense of the qualities we want to cultivate.

### Question

What experience with another tool or community has most shaped how you want Oya to feel to its users?

### Answer

Pending an answer from `@pemulis` or `@nesseps`.

<a id="q015"></a>

<!-- oya-dialogue-question: Q015 -->

## Q015 — Continuity when an agent leaves

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** resilience, agent choice, ongoing commitments
- **Status:** Answered
- **Source PR:** [#176](https://github.com/oyaprotocol/oya-commitments/pull/176)

### Context

In [Q006](#q006), @pemulis described agents serving commitments through messages. Thinking about an agent becoming unavailable could help us design ongoing commitments around continuity for the user.

### Question

What should a user be able to do if the agent serving their ongoing commitment stops operating?

### Answer

#### @pemulis — 2026-11-15

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6901316165](https://github.com/oyaprotocol/oya-commitments/pull/176#issuecomment-6901316165)
- **Source created:** 2026-11-15T21:03:02Z
- **Source updated:** 2026-11-15T21:03:31Z

It depends on the commitment, but it would make sense to write the commitment in such a way that the agent could be replaced if they were not doing their job, with specific rules around that mechanism. Additionally, in some cases the agent may post a bond with the commitment as a surety that they will show up to do their job, and might lose that bond if they fail to perform their duties correctly. On top of that, some commitments may allow any user/agent to show up to interact, and not rely on a specific agent.

<a id="q016"></a>

<!-- oya-dialogue-question: Q016 -->

## Q016 — Productive disagreement

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** collaboration, working style, judgment
- **Status:** Answered
- **Source PR:** [#178](https://github.com/oyaprotocol/oya-commitments/pull/178)

### Context

Oya combines protocol design, software, and user experience. Contributors can reasonably disagree about choices across those areas. Understanding what makes that disagreement useful could help us work through it together.

### Question

What makes a disagreement among Oya contributors productive rather than a drain on the project?

### Answer

#### @pemulis — 2026-11-16

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6931912446](https://github.com/oyaprotocol/oya-commitments/pull/178#issuecomment-6931912446)
- **Source created:** 2026-11-16T22:58:09Z
- **Source updated:** 2026-11-16T22:58:09Z

Right now the project is getting interest in use cases and node operation. This is too complicated of a question to answer right now, since it will be situation dependent. We would need a larger community of builders before disagreements even arise.

<a id="q017"></a>

<!-- oya-dialogue-question: Q017 -->

## Q017 — When a rule template is ready to share

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-15
- **Topics:** commitment design, reuse, quality
- **Status:** Answered
- **Source PR:** [#180](https://github.com/oyaprotocol/oya-commitments/pull/180)

### Context

The [rule-template guide](../agent-library/RULE_TEMPLATES.md) encourages contributors to suggest reusable rule patterns. A pattern that works for its author may still need scrutiny before others rely on it.

### Question

What would convince you that a commitment rule template is ready for people beyond its original author to reuse?

### Answer

#### @pemulis — 2026-11-16

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 6931933163](https://github.com/oyaprotocol/oya-commitments/pull/180#issuecomment-6931933163)
- **Source created:** 2026-11-16T22:59:09Z
- **Source updated:** 2026-11-16T22:59:09Z

Anyone can use a commitment rule template that they think will work for their use case and will be enforceable. I think that standardized rule templates will emerge organically over time, since organic standards will make it easier for the agent ecosystem to support many commitments without custom work for each commitment.

<a id="q018"></a>

<!-- oya-dialogue-question: Q018 -->

## Q018 — Choosing a node for a first message

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-17
- **Topics:** node operation, peer selection
- **Status:** Answered
- **Source PR:** [#190](https://github.com/oyaprotocol/oya-commitments/pull/190)

### Context

The [sending guide](../node/production/peers/send.md) starts with a recipient address. A directory can tell a new operator where to send a message, but choosing a recipient is a separate decision.

### Question

If two nodes are willing to publish your first message, what would make you choose one over the other?

### Answer

#### @pemulis — 2026-11-19

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7021528059](https://github.com/oyaprotocol/oya-commitments/pull/190#issuecomment-7021528059)
- **Source created:** 2026-11-19T20:36:40Z
- **Source updated:** 2026-11-19T20:36:40Z

We don't really know at this point. Nodes can compete through frontend design, marketing, backend capability, reputation, price, what commitments they are willing to propose for, etc.

<a id="q019"></a>

<!-- oya-dialogue-question: Q019 -->

## Q019 — One sentence that changes a loan

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-17
- **Topics:** rule templates, lending, plain language
- **Status:** Deferred
- **Source PR:** [#193](https://github.com/oyaprotocol/oya-commitments/pull/193)

### Context

In [Q010](#q010), @pemulis named borrowing against a portfolio as a use case to test. In [Q017](#q017), he described people choosing rule templates for themselves. A worked example could help a borrower compare two templates that look almost identical.

### Question

What is one sentence you could change in a loan template that would make a real difference to a borrower on the day repayment is due?

### Reason for deferral

#### @pemulis — 2026-11-19

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7021692325](https://github.com/oyaprotocol/oya-commitments/pull/193#issuecomment-7021692325)
- **Source created:** 2026-11-19T20:43:19Z
- **Source updated:** 2026-11-19T20:43:19Z

Let's save the use case specific questions for when we start building them and try to focus on the protocol itself for now.

<a id="q020"></a>

<!-- oya-dialogue-question: Q020 -->

## Q020 — When a handshake is enough

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-17
- **Topics:** trust, everyday agreements
- **Status:** Answered
- **Source PR:** [#195](https://github.com/oyaprotocol/oya-commitments/pull/195)

### Context

In [Q007](#q007), @pemulis discussed whether a promise can be verified. Whether the people making it want it enforced is a different question.

### Question

What is a promise you would rather keep on a handshake, even if Oya could enforce it?

### Answer

#### @pemulis — 2026-11-19

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7021826780](https://github.com/oyaprotocol/oya-commitments/pull/195#issuecomment-7021826780)
- **Source created:** 2026-11-19T20:48:52Z
- **Source updated:** 2026-11-19T20:48:52Z

I'm not sure if this is exactly what you mean, but a commitment could allow any one of a set of addresses to make a withdrawal or other transaction as long as it is not disputed by any other address on the list. The proposal would essentially be that the transaction will not be disputed by someone else in the group, for a shared wallet with no specific policy. That would still allow for a timelock and dispute mechanism and protect against stolen keys, while providing lots of flexibility.

<a id="q021"></a>

<!-- oya-dialogue-question: Q021 -->

## Q021 — Time to challenge a proposal

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-19
- **Topics:** challenge windows, protocol design
- **Status:** Answered
- **Source PR:** [#202](https://github.com/oyaprotocol/oya-commitments/pull/202)

### Context

In [Q003](#q003), @pemulis explained that anyone can challenge a proposal during a limited window. The clock runs even while nobody is looking.

### Question

How would you judge whether a challenge window gives someone enough time to notice a mistaken proposal and dispute it?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7054600974](https://github.com/oyaprotocol/oya-commitments/pull/202#issuecomment-7054600974)
- **Source created:** 2026-11-21T00:55:05Z
- **Source updated:** 2026-11-21T00:55:05Z

The typical default for UMA proposals in the past has been two hours, but it's configurable. But depending on how robust the node/validator network seems to be, how much money is at risk, and how easy the commitment is to evaluate, shorter challenge periods might be safer. Longer challenge periods can be selected for commitments with a lot of funds at risk or that are harder to evaluate.

<a id="q022"></a>

<!-- oya-dialogue-question: Q022 -->

## Q022 — Keeping a published message available

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-19
- **Topics:** data availability, publication nodes
- **Status:** Answered
- **Source PR:** [#203](https://github.com/oyaprotocol/oya-commitments/pull/203)

### Context

The Ledger records the string a caller submits. It does not check whether that string identifies a published message. Even when a node publishes a message and logs its identifier, the record can remain after the last readable copy goes offline.

### Question

Once a node publishes a message, who should take responsibility for keeping a readable copy available?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7054659659](https://github.com/oyaprotocol/oya-commitments/pull/203#issuecomment-7054659659)
- **Source created:** 2026-11-21T00:58:27Z
- **Source updated:** 2026-11-21T00:58:27Z

In the future, every piece of content that is published _and logged_ by a node should be pulled down and saved by every other node, as long as proper Oya fees were paid based on the size of the content being logged. Nodes will be expected to be able to draw on that history to prove their performance of data availability and to evaluate proposals that are based on historical data. Nodes can rely on externally hosted backup sources as well depending on their appetite for risk.

<a id="q023"></a>

<!-- oya-dialogue-question: Q023 -->

## Q023 — What a past ruling can settle

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** dispute resolution, precedent
- **Status:** Answered
- **Source PR:** [#209](https://github.com/oyaprotocol/oya-commitments/pull/209)

### Context

In [Q008](#q008), @pemulis said that a resolution is final for the proposal it decides. A later proposal could turn on the meaning of the same words.

### Question

When two commitments use the same wording, what weight should a ruling on the first carry in a dispute about the second?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7054838131](https://github.com/oyaprotocol/oya-commitments/pull/209#issuecomment-7054838131)
- **Source created:** 2026-11-21T01:08:59Z
- **Source updated:** 2026-11-21T01:08:59Z

It depends on whether they are resolving the same thing or if the state of the commitment or the state of the world has changed in a way that the commitment should be interpreted differently. For example, a commitment with the wording: "Swap USDC for ETH at the market price in two days." might be deployed on different days, and would resolve differently.

Looking at earlier resolutions can give proposers and disputers clues about how commitments might resolve, but each needs to be considered on its own. It's not a matter that earlier resolutions build "case law," or something. Every commitment stands on its own. But the use of similar templates can provide a certain measure of confidence in how the commitment will work and resolve.

<a id="q024"></a>

<!-- oya-dialogue-question: Q024 -->

## Q024 — How far back a new node should go

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** node history, data availability
- **Status:** Answered
- **Source PR:** [#216](https://github.com/oyaprotocol/oya-commitments/pull/216)

### Context

In [Q022](#q022), @pemulis described a future network in which nodes save content that other nodes publish and log. A node joining a year later would have missed that first exchange.

### Question

How much of the network’s earlier history should a new node be expected to retrieve when it joins?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7056210429](https://github.com/oyaprotocol/oya-commitments/pull/216#issuecomment-7056210429)
- **Source created:** 2026-11-21T02:51:37Z
- **Source updated:** 2026-11-21T02:51:37Z

A full node should be expected to retrieve the full history going back to the beginning of the protocol, although there may be lighter versions of the node that only deal with more recent data.

<a id="q025"></a>

<!-- oya-dialogue-question: Q025 -->

## Q025 — When two proposals cannot both work

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** proposal ordering, commitment rules
- **Status:** Answered
- **Source PR:** [#217](https://github.com/oyaprotocol/oya-commitments/pull/217)

### Context

Two proposals might each fit a commitment’s rules when considered alone. For example, each might promise the same remaining funds to a different recipient.

### Question

What should decide which proposal takes priority when a commitment could honor either one but not both?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7056230262](https://github.com/oyaprotocol/oya-commitments/pull/217#issuecomment-7056230262)
- **Source created:** 2026-11-21T02:53:22Z
- **Source updated:** 2026-11-21T02:53:22Z

First across the post wins. If a valid proposal is made but has not resolved yet, any subsequent proposals must be judged as though the earlier valid proposal had already resolved. If the second proposal would be true if the first proposal had not been made, but false because the first proposal has been made, it is false. However, if the first proposal was invalid, subsequent valid proposals can be judged as though the first proposal was not settled. All of this may have use-case and rule-specific subtleties, as well.

<a id="q026"></a>

<!-- oya-dialogue-question: Q026 -->

## Q026 — Recognizing an unfamiliar message

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** protocol evolution, message compatibility
- **Status:** Answered
- **Source PR:** [#218](https://github.com/oyaprotocol/oya-commitments/pull/218)

### Context

As independent teams build on Oya, a node may receive a signed message in a format it can verify but with a meaning it does not recognize.

### Question

What should a sender be able to expect from a node that recognizes the signature but not the kind of message being sent?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7056237378](https://github.com/oyaprotocol/oya-commitments/pull/218#issuecomment-7056237378)
- **Source created:** 2026-11-21T02:54:00Z
- **Source updated:** 2026-11-21T02:54:00Z

Messages are just plain text so the message type does not matter. In the beginning, only ASCII text will be accepted.

<a id="q027"></a>

<!-- oya-dialogue-question: Q027 -->

## Q027 — Which proposal came first?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** proposal ordering, shared evidence
- **Status:** Answered
- **Source PR:** [#220](https://github.com/oyaprotocol/oya-commitments/pull/220)

### Context

In [the Q025 answer](https://github.com/oyaprotocol/oya-commitments/pull/217#issuecomment-7056230262), @pemulis said that a later proposal must account for an earlier valid one even before it resolves. Two observers might hear about those proposals in opposite orders.

### Question

What public record should both observers use to tell which proposal came first?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7065162732](https://github.com/oyaprotocol/oya-commitments/pull/220#issuecomment-7065162732)
- **Source created:** 2026-11-21T15:48:54Z
- **Source updated:** 2026-11-21T15:48:54Z

Onchain events make proposal order (and any transaction order) clear.

<a id="q028"></a>

<!-- oya-dialogue-question: Q028 -->

## Q028 — One message delivered twice?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** message identity, delivery
- **Status:** Answered
- **Source PR:** [#221](https://github.com/oyaprotocol/oya-commitments/pull/221)

### Context

A sender who gets no receipt might send the same signed message through a second node. Both nodes may end up publishing it.

### Question

How should a commitment interpret two publications of the exact same signed instruction?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7065180368](https://github.com/oyaprotocol/oya-commitments/pull/221#issuecomment-7065180368)
- **Source created:** 2026-11-21T15:50:19Z
- **Source updated:** 2026-11-21T15:50:19Z

This is going to be extremely context dependent. The commitment rules should make it clear how they should respond to any published message or real-world information, and messages should not always be viewed as an "instruction," they could be conveying any number of different things, anything that can be expressed in written text.

#### @pemulis — 2026-11-21 (follow-up)

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7065510899](https://github.com/oyaprotocol/oya-commitments/pull/221#issuecomment-7065510899)
- **Source created:** 2026-11-21T16:15:45Z
- **Source updated:** 2026-11-21T16:15:45Z

This would be specific to a particular use case. We should not look at use cases and their rules right now.

<a id="q029"></a>

<!-- oya-dialogue-question: Q029 -->

## Q029 — Evidence that arrives after a proposal?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-20
- **Topics:** evidence, dispute resolution
- **Status:** Answered
- **Source PR:** [#223](https://github.com/oyaprotocol/oya-commitments/pull/223)

### Context

Suppose a proposal says a deadline was met. A dated record confirming that fact becomes public only after the proposal is challenged.

### Question

What weight should a resolver give evidence that existed when the proposal was made but was not public then?

### Answer

#### @pemulis — 2026-11-21

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7065192967](https://github.com/oyaprotocol/oya-commitments/pull/223#issuecomment-7065192967)
- **Source created:** 2026-11-21T15:51:20Z
- **Source updated:** 2026-11-21T15:51:20Z

Only public information counts.

<a id="q030"></a>

<!-- oya-dialogue-question: Q030 -->

## Q030 — A gap in a full node’s history

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** data availability, node synchronization
- **Status:** Answered
- **Source PR:** [#227](https://github.com/oyaprotocol/oya-commitments/pull/227)

### Context

In [Q024](#q024), @pemulis said a full node should retrieve history back to the beginning. A node catching up might reach the latest Ledger entry while one older message is still missing.

### Question

How should a node with a known gap in its history describe what it has verified to its peers?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7073452882](https://github.com/oyaprotocol/oya-commitments/pull/227#issuecomment-7073452882)
- **Source created:** 2026-11-22T03:18:22Z
- **Source updated:** 2026-11-22T03:18:22Z

Every node should strive to have the full history.

<a id="q031"></a>

<!-- oya-dialogue-question: Q031 -->

## Q031 — What a successful availability check proves

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** data availability, external backups
- **Status:** Answered
- **Source PR:** [#229](https://github.com/oyaprotocol/oya-commitments/pull/229)

### Context

In [Q022](#q022), @pemulis said nodes may rely on external backups. Imagine two nodes that return the same historical message in time: one reads its own disk and the other fetches a backup.

### Question

If two nodes return the same message on time, should it matter to a data availability check that one fetched it from a backup?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7073459849](https://github.com/oyaprotocol/oya-commitments/pull/229#issuecomment-7073459849)
- **Source created:** 2026-11-22T03:19:03Z
- **Source updated:** 2026-11-22T03:19:03Z

Not really. There would be no way to know how the node stored or retrieved the data.

<a id="q032"></a>

<!-- oya-dialogue-question: Q032 -->

## Q032 — A first test for an independent node

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** peer messaging, interoperability
- **Status:** Answered
- **Source PR:** [#230](https://github.com/oyaprotocol/oya-commitments/pull/230)

### Context

The [peer sending guide](../node/production/peers/send.md) describes how the current node asks a peer to publish signed text. Imagine someone writing a second node from scratch.

### Question

What is the smallest exchange that a new node implementation should complete with an existing node to show the two are compatible?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7073478427](https://github.com/oyaprotocol/oya-commitments/pull/230#issuecomment-7073478427)
- **Source created:** 2026-11-22T03:20:52Z
- **Source updated:** 2026-11-22T03:20:52Z

The data availability game and verification should be agnostic to how the node itself is implemented. This is related to the earlier question about retrieving from independent storage or a hosted backup; there is no way for our protocol to know, and we are not opinionated about that. We expect that independent node implementations will be developed and that the protocol itself will stay very generalized and not depend on detailed technical compatibility. Whatever gets the job done is fine.

<a id="q033"></a>

<!-- oya-dialogue-question: Q033 -->

## Q033 — Who pays for old messages?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** publication fees, long-term storage
- **Status:** Answered
- **Source PR:** [#232](https://github.com/oyaprotocol/oya-commitments/pull/232)

### Context

In [Q022](#q022), @pemulis described a fee based on the size of a message. In [Q024](#q024), he said a full node joining later should retrieve the whole history. A node might start doing that work years after the sender paid.

### Question

Who should pay for keeping a message available years after its publication fee was paid?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7083724309](https://github.com/oyaprotocol/oya-commitments/pull/232#issuecomment-7083724309)
- **Source created:** 2026-11-22T18:35:55Z
- **Source updated:** 2026-11-22T18:35:55Z

Node operators are expected to save or otherwise have available the full history. Publishers who log new content to the Ledger will be required to make the content publicly available for some time period, and we will use data availability attestation checks to confirm that the data is available to other nodes during that time period, and if the checks fail, the content will not need to be saved and stored by the node network. The way that we publicly post these attestations and confirm "finality" of the content as part of the ongoing Oya protocol history is an open question we can resolve later, and will be tied in with the rewards and penalties for registered nodes in the network. The features you have been developing over the past 24 hours will definitely bring us closer to that.

<a id="q034"></a>

<!-- oya-dialogue-question: Q034 -->

## Q034 — Can a node decline a first publication?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** publication, operator discretion
- **Status:** Answered
- **Source PR:** [#233](https://github.com/oyaprotocol/oya-commitments/pull/233)

### Context

In [Q022](#q022), @pemulis described what nodes should keep after a message has been published and logged. Before that happens, a sender has to find a node willing to publish it.

### Question

When, if ever, should the protocol require a particular node to publish a new message rather than leave that choice to its operator?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7083745837](https://github.com/oyaprotocol/oya-commitments/pull/233#issuecomment-7083745837)
- **Source created:** 2026-11-22T18:37:34Z
- **Source updated:** 2026-11-22T18:37:34Z

It's the operator's choice. They never have to accept messages they don't want to receive or publish content they don't want to publish. They do, however, have a responsibility to pull down and save any content that was published and logged by other addresses (presumably other nodes, though the Ledger contract allows anyone to post logs), assuming the publisher paid the protocol fee in Oya tokens.

<a id="q035"></a>

<!-- oya-dialogue-question: Q035 -->

## Q035 — Does a paywall make evidence private?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-21
- **Topics:** public evidence, dispute resolution
- **Status:** Answered
- **Source PR:** [#234](https://github.com/oyaprotocol/oya-commitments/pull/234)

### Context

In [the Q029 answer](https://github.com/oyaprotocol/oya-commitments/pull/223#issuecomment-7065192967), @pemulis said that only public information counts. A newspaper archive tests the boundary: anyone can subscribe, but a resolver without a subscription cannot read the cited article.

### Question

Should an article that anyone can buy, but nobody can read for free, count as public evidence in an Oya dispute?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7083750716](https://github.com/oyaprotocol/oya-commitments/pull/234#issuecomment-7083750716)
- **Source created:** 2026-11-22T18:37:56Z
- **Source updated:** 2026-11-22T18:37:56Z

Depends on the rules and specific use case for the commitment.

<a id="q036"></a>

<!-- oya-dialogue-question: Q036 -->

## Q036 — Checking yesterday’s availability claim

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-22
- **Topics:** data availability, independent verification
- **Status:** Answered
- **Source PR:** [#236](https://github.com/oyaprotocol/oya-commitments/pull/236)

### Context

In [the Q033 answer](https://github.com/oyaprotocol/oya-commitments/pull/232#issuecomment-7083724309), @pemulis described peers checking that newly published content is available. Someone joining later can try fetching the message today, but that tests a different moment.

### Question

What should a newcomer be able to verify for themselves about a peer’s claim that a message was available yesterday?

### Answer

#### @pemulis — 2026-11-22

- **Respondent:** `@pemulis` (GitHub user ID `1646497`)
- **Source:** [Comment 7085863273](https://github.com/oyaprotocol/oya-commitments/pull/236#issuecomment-7085863273)
- **Source created:** 2026-11-22T21:11:53Z
- **Source updated:** 2026-11-22T21:11:53Z

They should be able to verify that the peer had access to the message content at the time of signing, or at least had a digest based on the message content. They will be able to verify that the signature came from the peer, and if they have access to the content itself, they will be able to verify that the digest is tied back to the original content. Also, these attestations will likely be logged, so they will be able to verify when the attestation was logged onchain in addition to the timestamp claimed by the peer in the digest (which should precede or match the block timestamp of the log).

<a id="q041"></a>

<!-- oya-dialogue-question: Q041 -->

## Q041 — What makes a practice dispute a fair test?

- **Asked by:** Oya Gardener (`@oyagardener`)
- **Asked on:** 2026-11-24
- **Topics:** optimistic resolution, node testing
- **Status:** Awaiting answer
- **Source PR:** [#244](https://github.com/oyaprotocol/oya-commitments/pull/244)

### Context

In [the Q037 answer](https://github.com/oyaprotocol/oya-commitments/pull/237#issuecomment-7146497973), @pemulis described a possible game where nodes spot deliberately invalid proposals. A node might learn to recognize the test proposals without learning to spot the same mistake in an ordinary proposal.

### Question

What would convince you that a node which spots a deliberately invalid proposal would also spot that mistake in the wild?

### Answer

Pending an answer from `@pemulis` or `@nesseps`.
