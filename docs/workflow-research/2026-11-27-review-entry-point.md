# Link each important behavior change to its implementation

**Proposed — for human review.** On a PR that changes multiple lines, the author would describe each important behavior change and link it to the lines that implement it. Reviewers could jump directly to the behavior they want to inspect, even when all the changes are in one file.

For example, [PR #249](https://github.com/oyaprotocol/oya-commitments/pull/249) says an oversized range of candidate logs is rejected before any writes. Its eight changed files include a command, shared helpers, tests and operator docs. The sentence could link directly to [the 32-record check before the retention loop](https://github.com/oyagardener/oya-commitments/blob/c7c08f089c544118ec94692e975a2543442a57ca/node/production/src/retain-range.mjs#L36-L40). That shows the ordering at the call site. It does not establish that every called function is free of side effects. The link is a starting point, not proof or a reason to skip the rest of the diff.

[The maintainer closed #251](https://github.com/oyaprotocol/oya-commitments/pull/251#issuecomment-7223491517) because asking the human reviewer to do another check adds work at the bottleneck. This asks the author to do the locating instead. If a behavior depends on two locations, link both and say how they work together. Formatting changes and other edits that leave behavior unchanged need no entry.

## Why try it?

- Yinan Wu, Dominik Wermke, Ze Shi Li, Kathryn Thomasset Stolee and Bowen Xu, [*From Delegation to Action Approval: An Exploratory Study of Developers’ Practices in Collaborating with AI Coding Agents*](https://arxiv.org/html/2611.10058v1), preprint, November 6, 2026, methods and review-difficulty results. Of 201 respondents answering the review-difficulty question, 55% reported difficulty reviewing large or multi-file changes. This was a non-random survey about experience, not a timed review experiment.
- Abir Bouraffa, Carolin Brandt, Andy Zaidman and Walid Maalej, [*Not One to Rule Them All: Mining Meaningful Code Review Orders From GitHub*](https://carolin-brandt.de/publications/bouraffa-ease25.pdf), EASE 2025 ([preprint posted June 12, 2025](https://arxiv.org/abs/2506.10654)), §§2.3 and 3.1. Across 23,241 PRs in 100 Java and Python repositories, reviewers commented in non-alphabetical order in 44.6% of PRs. Comment order is not reading order, and reviews with fewer than two commented files were excluded. This argues against dictating a route. Neither study tested whether a link saves reviewer time.

## A pilot with no reviewer assignment

If adopted separately, the author would try this on the next three eligible node feature PRs. For each important behavior change, link the relevant phrase in the description to the implementation in the submitted commit. Open each link to check that the selected lines support the claim. Keep existing warnings and validation limits. After a revision, update links whose targets moved or whose behavior changed.

Before starting, the author would read the ordinary review threads on the preceding three comparable node features that changed multiple lines. Count human follow-ups asking *where* a stated behavior is implemented, separately from substantive disagreements about whether it is right. Compare with the pilot threads after ordinary review, noting changes in scope or reviewer participation. No timing diary, survey or acknowledgment from the reviewer. A reduction in locating questions with no misleading links would justify another small trial, not a claim about minutes saved. If the baseline already has no such questions, the comparison cannot show improvement: stop rather than standardize. Stop also for a misleading pointer, reviewer objection, or no observable benefit. Reversal means leaving the prose unlinked.

The pilot has not been run. Merging this document would not activate it.
