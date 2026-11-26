# Can this test pass for the wrong reason?

**Proposed — for human review.** Try one paired example when reviewing an AI-assisted regression test for input validation. Start from a known-good local fixture. Change only the input named by the rule and predict what should happen in both cases before looking at the test result. The question for the reviewer is whether the difference explains the outcome, not whether the suite is green.

## Why try it at Oya?

In [PR #197](https://github.com/oyaprotocol/oya-commitments/pull/197), an existing test saw the expected rejection, but an invalid signature caused it. The helper had actually supplied the credential the test meant to omit. The correction reused one valid message for both outcomes. This proposal borrows that reasoning for review of other tests. It does not reopen the fix or add a PR template.

For example, consider the duration limit in [PR #241](https://github.com/oyaprotocol/oya-commitments/pull/241). For an otherwise valid request with a stubbed, immediately resolving operation, predict that the largest supported timeout lets the operation start, while the next integer is rejected before it starts. A pair where neither operation starts tells us little about that boundary, even if one assertion reports the expected error. This is an illustration, not a finding against #241.

## Why one pair, not more generated tests?

Charoosaei and colleagues [1] introduced faults into changes from 145 PRs across three Python projects. They selected faults that survived existing tests but that a model could detect. When a model wrote regression tests with the faulty code in view, 8–17% of the selected test/fault pairs passed on the changed behavior and failed on the reference. These were artificial faults and one model, not a defect rate for Oya. The useful warning is that a passing assertion can preserve the very behavior a reviewer wants to question.

There is also evidence against dismissing generated assertions. Molinelli and colleagues [2] evaluated assertions for existing test setups from 135 Java projects, using test cases added after the models’ training cutoffs. In the four-project subset used for mutation testing, the suites with passing generated assertions achieved a 43% average mutation score versus 45% for developer assertions. The comparison excluded generated assertions that failed to compile or pass. Detecting artificial code changes is not the same as identifying the right requirement. Neither study tested paired review or measured reviewer time. The reason to try a pair here is Oya’s example, not an expectation of either paper’s effect size.

## Proposed pilot

On the next three willing, eligible reviews, the reviewer first inspects one new or changed validation test as usual and notes any concern. Then the author or reviewer takes at most five extra minutes to identify the rule in a public requirement or accepted example, predict both outcomes, and check the pair against the existing local fixture. Reuse an existing positive case if it differs only in the intended input. If the rule is unclear, record that instead of treating current output as the specification. Skip cases requiring live services or substantial setup.

Compare the paired check with the concern already noted on that same review. Record only what changed: a misleading assertion corrected, a requirement clarified, or no additional finding, plus approximate extra author and reviewer time. A second look alone could explain a discovery. Three cases can show whether the exercise earns another trial, not estimate a defect rate. Stop after three, or sooner if setup exceeds the time limit. Continue only by human choice if a pair changed a review decision at acceptable cost. No CI step, recurring job, or policy change follows from merging this note.

## References

1. Mohammadali Charoosaei, Cedric Richter and Mike Papadakis. [On the Risks of using LLM-Generated Tests for Regression Testing](https://arxiv.org/html/2610.11835v1). Preprint, October 8, 2026, v1. See §§4.2–4.3, Table 3 and §7.1 for the selection procedure and limits.
2. Davide Molinelli, Luca Di Grazia, Alberto Martin-Lopez, Michael D. Ernst and Mauro Pezzè. [Do LLMs Generate Useful Test Oracles? An Empirical Study with an Unbiased Dataset](https://homes.cs.washington.edu/~mernst/pubs/neurosymbolic-oracles-ase2025.pdf). ASE, November 2025, pp. 278–290. See RQ4 for the mutation experiment.
