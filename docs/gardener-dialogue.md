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
| [Q002](#q002) | A first experience of Oya | accessibility, use cases, product direction | Awaiting answer |

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
- **Status:** Awaiting answer
- **Source PR:** Pending PR creation.

### Context

In [Q001](#q001), @pemulis described accessibility and empowerment through commitments expressed in plain language. A concrete first experience could help us choose examples and judge whether our onboarding communicates that promise.

### Question

What is one commitment you would want a nontechnical person to try first to experience what Oya makes possible?

### Answer

Pending an answer from `@pemulis` or `@nesseps` in the source PR.
