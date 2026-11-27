# Link one behavior claim to the code that decides it

**Proposed — for human review.** On a multi-file, AI-assisted feature PR, the author could turn an existing sentence about an important behavior into a link to the changed lines that decide it. The reviewer gets a place to start without a longer description, a prescribed reading order, or a new task.

For example, [PR #249](https://github.com/oyaprotocol/oya-commitments/pull/249) says an oversized range of candidate logs is rejected before any writes. Its eight changed files include a command, shared helpers, tests and operator docs. The sentence could link directly to [the 32-record check before the retention loop](https://github.com/oyagardener/oya-commitments/blob/c7c08f089c544118ec94692e975a2543442a57ca/node/production/src/retain-range.mjs#L36-L40). That shows the ordering at the call site. It does not establish that every called function is free of side effects. The link is a starting point, not proof or a reason to skip the rest of the diff.

[The maintainer closed #251](https://github.com/oyaprotocol/oya-commitments/pull/251#issuecomment-7223491517) because asking the human reviewer to do another check adds work at the bottleneck. This asks the author to do the locating instead. Skip it for an obvious one-file change or when no single location helps explain the claim.

## Why try it?

- Yinan Wu, Dominik Wermke, Ze Shi Li, Kathryn Thomasset Stolee and Bowen Xu, [*From Delegation to Action Approval: An Exploratory Study of Developers’ Practices in Collaborating with AI Coding Agents*](https://arxiv.org/html/2611.10058v1), preprint, November 6, 2026, methods and review-difficulty results. Of 201 respondents answering the review-difficulty question, 55% reported difficulty reviewing large or multi-file changes. This was a non-random survey about experience, not a timed review experiment.
- Abir Bouraffa, Carolin Brandt, Andy Zaidman and Walid Maalej, [*Not One to Rule Them All: Mining Meaningful Code Review Orders From GitHub*](https://carolin-brandt.de/publications/bouraffa-ease25.pdf), EASE 2025 ([preprint posted June 12, 2025](https://arxiv.org/abs/2506.10654)), §§2.3 and 3.1. Across 23,241 PRs in 100 Java and Python repositories, reviewers commented in non-alphabetical order in 44.6% of PRs. Comment order is not reading order, and reviews with fewer than two commented files were excluded. This argues against dictating a route. Neither study tested whether a link saves reviewer time.

## A pilot with no reviewer assignment

If adopted separately, the author would try this on the next three eligible node feature PRs. Pick one consequential claim already in the opening, link its words to the submitted commit, and open the link once to check what the reader will see. Spend at most two minutes per PR. Keep existing warnings and validation limits. If the check moves in a revision, repair the link or remove it.

Before starting, the author would read the ordinary review threads on the preceding three comparable multi-file node features. Count human follow-ups asking *where* a stated behavior is implemented, separately from substantive disagreements about whether it is right. Compare with the pilot threads after ordinary review, noting changes in scope or reviewer participation. No timing diary, survey or acknowledgment from the reviewer. A reduction in locating questions with no misleading links would justify another small trial, not a claim about minutes saved. If the baseline already has no such questions, the comparison cannot show improvement: stop rather than standardize. Stop also for a misleading pointer, reviewer objection, or no observable benefit. Reversal means leaving the prose unlinked.

The pilot has not been run. Merging this document would not activate it.
