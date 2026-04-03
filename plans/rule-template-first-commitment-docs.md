# Rule Template First Commitment Documentation

This ExecPlan is a living document and must be maintained according to `PLANS.md`.

## Purpose / Big Picture

Update the repository documentation so that anyone creating a new agentic commitment is directed to `agent-library/RULE_TEMPLATES.md` before they draft `agent-library/agents/<agent-name>/commitment.txt`. After this change, the documented workflow should be: start from the shared rule templates, select and fill the applicable templates, add only the truly commitment-specific rules that are still missing, and note any reusable gaps as candidate additions to `agent-library/RULE_TEMPLATES.md`.

The user-visible outcome is a more consistent commitment-authoring process. A human contributor reading the repo docs or a coding agent following the machine-targeted instructions should arrive at the same workflow: `RULE_TEMPLATES.md` is the primary source for commitment-rule drafting, and new reusable rules should be suggested back into that template file instead of being rediscovered ad hoc in isolated commitment files.

## Progress

- [x] 2026-04-03 23:35Z: Reviewed `PLANS.md`, `AGENTS.md`, `agent-library/AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `agent-library/README.md`, `skills/add-agent-commitment/SKILL.md`, and `agent-library/RULE_TEMPLATES.md`.
- [x] 2026-04-03 23:35Z: Audited the current commitment-creation workflow and identified the main documentation gaps around template-first rule authoring and template maintenance.
- [x] 2026-04-03 23:39Z: Updated `agent-library/RULE_TEMPLATES.md` with a templates-first preamble and guidance for suggesting reusable new templates.
- [x] 2026-04-03 23:39Z: Updated human-facing workflow docs in `README.md`, `agent-library/README.md`, and `CONTRIBUTING.md` so new commitments route through `agent-library/RULE_TEMPLATES.md` before `commitment.txt`.
- [x] 2026-04-03 23:39Z: Updated machine-targeted workflow docs in `agent-library/AGENTS.md` and `skills/add-agent-commitment/SKILL.md` so future coding agents reuse templates first and report reusable template gaps.
- [x] 2026-04-03 23:39Z: Ran the planned wording sweep and reviewed the resulting documentation diff.

## Surprises & Discoveries

- Observation: The current repo-level onboarding still tells contributors to "write the commitment rules" directly in `agent-library/agents/<agent-name>/commitment.txt`, with no mention of the shared rule template catalog.
  Evidence: `README.md` section `Build An Agentic Commitment`, step 2.

- Observation: The detailed `agent-library/README.md` workflow also skips the template catalog and jumps straight from copying the default module to writing `commitment.txt`.
  Evidence: `agent-library/README.md` section `Building A New Agentic Commitment`, step 2.

- Observation: The `add-agent-commitment` skill currently asks for commitment text/rules as an input, but it does not instruct coding agents to consult `agent-library/RULE_TEMPLATES.md`, list which templates were reused, or suggest new template entries when a reusable gap appears.
  Evidence: `skills/add-agent-commitment/SKILL.md` sections `Required Inputs` and `Workflow`.

- Observation: `agent-library/RULE_TEMPLATES.md` currently contains the rule catalog itself, but not the workflow instructions that would make it a clear source of truth for future commitment authors.
  Evidence: the file begins immediately with a short format description and the list of templates.

- Observation: `agent-library/agents/default/commitment.txt` is a runnable example commitment, not a template-selection guide, so the surrounding docs must explicitly say that copied text should be replaced from `RULE_TEMPLATES.md` rather than treated as the intended starting rules.
  Evidence: `agent-library/agents/default/commitment.txt` currently contains a complete one-sentence commitment.

- Observation: `agent-library/RULE_TEMPLATES.md` is currently a fresh user-authored file in the working tree, so this documentation rollout should preserve the user's existing template entries and focus on framing, usage, and contribution guidance rather than rewriting the catalog itself.
  Evidence: `git status --short` shows `?? agent-library/RULE_TEMPLATES.md`.

## Decision Log

- Decision: Update both human-facing docs and machine-targeted instructions in the same pass.
  Rationale: A templates-first policy will drift quickly if `README.md` says one thing while `agent-library/AGENTS.md` and `skills/add-agent-commitment/SKILL.md` instruct agents differently.
  Date/Author: 2026-04-03 / Codex.

- Decision: Make `agent-library/RULE_TEMPLATES.md` the explicit workflow source of truth for rule drafting and template-gap contribution guidance.
  Rationale: The catalog itself is the most stable place to explain how templates should be selected, filled, and extended. Every other doc should point back to that file rather than duplicate the policy in full.
  Date/Author: 2026-04-03 / Codex.

- Decision: Keep `agent-library/agents/default/commitment.txt` as a runnable example during this documentation pass, and instead add explicit surrounding guidance that copied default rules must be replaced using `agent-library/RULE_TEMPLATES.md`.
  Rationale: Replacing the example text with instructions would reduce the utility of the default module as a working generic example. The immediate problem is workflow discoverability, which documentation can fix directly.
  Date/Author: 2026-04-03 / Codex.

- Decision: Do not restructure or rewrite the existing rule entries inside `agent-library/RULE_TEMPLATES.md` as part of this first rollout unless the user explicitly asks for template-library editing.
  Rationale: The file is newly added and user-authored. The safe first step is to make it discoverable and authoritative, then evolve individual templates separately if needed.
  Date/Author: 2026-04-03 / Codex.

## Outcomes & Retrospective

The documentation rollout is complete. The repo now points future commitment authors and coding agents to `agent-library/RULE_TEMPLATES.md` before they draft `commitment.txt`, and the reusable `add-agent-commitment` skill now requires template selection as part of its workflow.

What changed:

- `agent-library/RULE_TEMPLATES.md` now explains that it is the primary source for new commitment rules and tells contributors to suggest new template entries when a reusable pattern is missing.
- `README.md` and `agent-library/README.md` now route the new-commitment flow through `agent-library/RULE_TEMPLATES.md` before `commitment.txt`, and they explicitly say the copied default `commitment.txt` is not the intended final rule set.
- `CONTRIBUTING.md` now points commitment-rule drafting at `agent-library/RULE_TEMPLATES.md`.
- `agent-library/AGENTS.md` and `skills/add-agent-commitment/SKILL.md` now require coding agents to reuse existing templates first and suggest new shared templates when needed.

The main follow-up risk is not technical but editorial: if future workflow docs are added elsewhere, they should preserve the same templates-first ordering instead of reintroducing a "write rules from scratch" path.

## Context and Orientation

The affected workflow spans a small set of repository documents that play different roles:

- `agent-library/RULE_TEMPLATES.md` is the new shared catalog of reusable rule language for commitments. This file should become the primary source for authoring rules, and it also needs a short maintenance loop that tells future contributors when to suggest a new template.
- `README.md` is the repo-level entry point. It currently gives the fastest path to building a new agentic commitment, so it is one of the highest-leverage places to introduce the templates-first rule-writing flow.
- `agent-library/README.md` is the more detailed module-creation guide. It should expand the repo-level workflow and explain that `commitment.txt` is assembled from the shared templates plus any narrowly scoped custom rules.
- `agent-library/AGENTS.md` is the closest machine-readable instruction file for `agent-library/` work. It should state the normative behavior expected from coding agents when they draft commitment rules.
- `skills/add-agent-commitment/SKILL.md` is the reusable workflow that coding agents can invoke directly when asked to create a new agent/commitment pair. It must reflect the same templates-first process and explicitly require template-gap suggestions when reusable rules are missing.
- `CONTRIBUTING.md` is the shared repo-level contributor workflow. A short addition here can reinforce the policy for humans who start from contribution docs rather than the README.
- `agent-library/agents/default/commitment.txt` is the copied starter file for new modules. This plan assumes it remains a working example and that the docs around it tell authors to replace its contents when drafting a real commitment.

The main documentation problem today is not a lack of rule content. The new `RULE_TEMPLATES.md` already provides reusable rule language. The gap is that the current "create a new commitment" instructions do not route authors through that file, and the current agent-facing workflow does not say what to do when a new reusable rule shape is discovered.

## Plan of Work

First, add a short "how to use this file" framing section to `agent-library/RULE_TEMPLATES.md` without changing the existing rule templates themselves. That framing should say, in plain language, that future commitment authors should begin by selecting and filling applicable templates from this file, then write only the remaining commitment-specific rules that are not covered here. It should also explain what counts as a candidate new template: a reusable rule pattern that would likely appear again across commitments, not a one-off value substitution for a single deployment.

Second, update the human-facing new-commitment workflow in `README.md` and `agent-library/README.md`. The repo-level README should make the templates-first step visible in the fast path, while the `agent-library` README should spell out the expected drafting sequence more clearly: consult `RULE_TEMPLATES.md`, assemble the initial `commitment.txt` from matching templates, fill placeholders, then add any narrowly custom rules. The same docs should tell contributors that if they had to invent a reusable rule pattern, they should suggest a new entry for `RULE_TEMPLATES.md`.

Third, update machine-targeted instructions in `agent-library/AGENTS.md` and `skills/add-agent-commitment/SKILL.md`. The goal is that future coding agents behave the same way a careful human would. The skill should require agents to gather or identify the selected templates, note which parts of the final commitment are still custom, and surface candidate template additions in their summary or plan when recurring gaps appear. The `agent-library/AGENTS.md` file should encode the shorter normative version of that rule for any agent editing files in this area.

Fourth, add a brief reinforcement in `CONTRIBUTING.md` so the repo's generic contribution flow also points to the shared template catalog for commitment-rule drafting. Keep this addition short and cross-referential instead of repeating the full workflow.

Finally, run a consistency pass across the changed docs. The review should confirm that no primary workflow doc still tells contributors to draft commitment rules from scratch without first consulting `agent-library/RULE_TEMPLATES.md`, and that at least one human-facing document plus the machine-targeted skill both mention the expectation to suggest new reusable templates when needed.

## Concrete Steps

From `/Users/johnshutt/Code/oya-commitments`:

1. Re-open the relevant docs before editing to confirm the latest wording and avoid drifting from the current repo state:
   `sed -n '1,220p' README.md`
   `sed -n '1,220p' CONTRIBUTING.md`
   `sed -n '1,220p' agent-library/AGENTS.md`
   `sed -n '1,260p' agent-library/README.md`
   `sed -n '1,260p' agent-library/RULE_TEMPLATES.md`
   `sed -n '1,260p' skills/add-agent-commitment/SKILL.md`

2. Edit `agent-library/RULE_TEMPLATES.md` to add a short preamble or section that covers:
   - this file is the first stop for drafting new commitment rules
   - authors should compose `commitment.txt` from applicable templates before inventing fresh prose
   - placeholders in `[ ]` must be filled with commitment-specific values
   - when a reusable rule pattern is missing, contributors and coding agents should suggest a new template title plus body for later addition to this file

3. Edit `README.md` so the fast path for building a new agentic commitment explicitly says to start from `agent-library/RULE_TEMPLATES.md` before writing `agent-library/agents/<agent-name>/commitment.txt`. Add `agent-library/RULE_TEMPLATES.md` to the documentation index if that improves discoverability.

4. Edit `agent-library/README.md` so the detailed workflow instructs authors to:
   - consult `agent-library/RULE_TEMPLATES.md`
   - select and fill the relevant shared templates
   - replace the copied default `commitment.txt` with those assembled rules
   - add custom rules only for uncovered behavior
   - capture candidate reusable templates when new rule patterns are needed

5. Edit `agent-library/AGENTS.md` to add a concise normative rule for coding agents: when drafting or revising `commitment.txt` for a new agentic commitment, treat `agent-library/RULE_TEMPLATES.md` as the primary source and suggest additions when a reusable rule shape is missing.

6. Edit `skills/add-agent-commitment/SKILL.md` so it requires:
   - identifying which rule templates apply
   - using those templates as the starting point for `commitment.txt`
   - calling out custom rules that could merit a new shared template
   - reporting template-addition suggestions in the final summary when the module needs reusable new language

7. Edit `CONTRIBUTING.md` to add a short reminder that commitment-rule drafting should begin with `agent-library/RULE_TEMPLATES.md`, with detailed workflow delegated to the `agent-library` docs and skill.

8. Run a repo-local wording check to catch stale or conflicting instructions:
   `rg -n "RULE_TEMPLATES|Write the commitment rules|commitment.txt|template" README.md CONTRIBUTING.md agent-library skills -g '*.md'`

9. Review the exact documentation diff before closing the work:
   `git diff -- README.md CONTRIBUTING.md agent-library/AGENTS.md agent-library/README.md agent-library/RULE_TEMPLATES.md skills/add-agent-commitment/SKILL.md`

10. Update this ExecPlan's `Progress`, `Outcomes & Retrospective`, and `Artifacts and Notes` sections with what changed and any wording decisions made during implementation.

## Validation and Acceptance

This is a documentation-only change, so validation is based on consistency and workflow clarity rather than executable tests.

Required checks:

- `rg -n "RULE_TEMPLATES|Write the commitment rules|commitment.txt|template" README.md CONTRIBUTING.md agent-library skills -g '*.md'`
- `git diff -- README.md CONTRIBUTING.md agent-library/AGENTS.md agent-library/README.md agent-library/RULE_TEMPLATES.md skills/add-agent-commitment/SKILL.md`

Acceptance criteria:

- A contributor following `README.md` for a new agentic commitment reaches `agent-library/RULE_TEMPLATES.md` before drafting final rule text.
- `agent-library/README.md` explicitly describes `commitment.txt` as being assembled from the shared templates plus any necessary custom rules.
- `agent-library/AGENTS.md` and `skills/add-agent-commitment/SKILL.md` both tell coding agents to reuse existing templates first.
- At least one machine-targeted instruction and one human-facing doc both say that reusable missing rule patterns should be suggested back into `agent-library/RULE_TEMPLATES.md`.
- No major workflow doc still implies that commitment rules should usually be written from scratch without consulting the template catalog.

If any of these criteria are not met, keep the work open and update this plan with the mismatch instead of treating the rollout as complete.

## Idempotence and Recovery

The work is safe to retry because it only touches Markdown and instruction files in the repository. If interrupted, resume by reading this ExecPlan first, then re-running the file reads in `Concrete Steps`, then checking the current diff with `git diff --stat`.

Keep edits focused on documentation and instructions. Do not rewrite the existing template catalog body unless the user explicitly expands scope to template-library editing. If later review shows that the unchanged `agent-library/agents/default/commitment.txt` is still causing confusion, record that finding here and decide in a follow-up whether the scaffold itself needs a stronger placeholder mechanism.

## Artifacts and Notes

Current workflow audit notes:

- `README.md` fast path currently jumps from copying `agent-library/agents/default/` straight to writing `commitment.txt`.
- `agent-library/README.md` detailed workflow does the same.
- `skills/add-agent-commitment/SKILL.md` currently asks for commitment rules as an input but does not name `agent-library/RULE_TEMPLATES.md`.
- `agent-library/RULE_TEMPLATES.md` already contains reusable rule text for agent proxying, proposal delegation, fee structures, pause behavior, rule updates, and related constraints, so the rollout should focus on discoverability and contribution policy rather than inventing a new catalog.

Implementation notes:

- `README.md` now inserts `agent-library/RULE_TEMPLATES.md` between copying the default module and writing `commitment.txt`.
- `agent-library/README.md` now says `commitment.txt` should usually be assembled from shared templates and warns that the copied default `commitment.txt` is only a runnable example.
- `skills/add-agent-commitment/SKILL.md` now requires agents to identify applicable templates, build `commitment.txt` from them, and report suggested new templates when reusable gaps are found.

Validation evidence:

- Wording sweep command:
  `rg -n "RULE_TEMPLATES|Write the commitment rules|commitment.txt|template" README.md CONTRIBUTING.md agent-library skills -g '*.md'`
- Diff review command:
  `git diff -- README.md CONTRIBUTING.md agent-library/AGENTS.md agent-library/README.md agent-library/RULE_TEMPLATES.md skills/add-agent-commitment/SKILL.md`

## Interfaces and Dependencies

Primary files:

- `README.md`
- `CONTRIBUTING.md`
- `agent-library/AGENTS.md`
- `agent-library/README.md`
- `agent-library/RULE_TEMPLATES.md`
- `skills/add-agent-commitment/SKILL.md`

Related context files:

- `PLANS.md`
- `AGENTS.md`
- `agent-library/agents/default/commitment.txt`

Tools and commands:

- `sed`
- `rg`
- `git diff`
- `apply_patch`

No external services, secrets, RPC endpoints, or network access are required for this documentation rollout.
