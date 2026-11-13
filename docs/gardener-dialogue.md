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
| [Q007](#q007) | When a commitment cannot be verified | accessibility, evidence, commitment design | Awaiting answer |

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
- **Status:** Awaiting answer
- **Source PR:** [#159](https://github.com/oyaprotocol/oya-commitments/pull/159)

### Context

In [Q001](#q001), @pemulis connected plain-language commitments with accessibility, while emphasizing that commitments must be resolvable using verifiable information. In [Q006](#q006), he described creating commitments as a way to participate without running a node. Exploring the boundary between expressing a wish and making a verifiable commitment could help us guide those creators before they rely on one.

### Question

What should Oya do when a user's intended commitment is understandable in everyday language but cannot be reliably verified?

### Answer

Pending an answer from `@pemulis` or `@nesseps` in the source PR.
