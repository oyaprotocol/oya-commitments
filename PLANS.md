# Execution Plans (ExecPlans)

This file defines how to write and maintain a long-running execution plan ("ExecPlan") for this repository. An ExecPlan is the document an agent follows when a task is large enough that it may take hours of research, implementation, testing, and iteration. The plan must be detailed enough that a new contributor can pick it up cold, with only the current working tree and the plan file, and still finish the work correctly.

## How To Use This File

When authoring an ExecPlan, reread this file first. Do not rely on memory. Research the current repository state before writing the plan, then keep the plan synchronized with what you learn.

When executing an ExecPlan, continue from milestone to milestone without asking the user for routine next steps. Update the plan as you go. Stop only when you hit a real blocker such as missing credentials, missing access, an irreversible production risk, or a product decision that cannot be resolved safely from repo context.

When discussing or revising an ExecPlan, treat it as a living record of the work. Record decisions, unexpected findings, validation evidence, and remaining work so the next person does not need prior chat context.

## Non-Negotiable Requirements

Every ExecPlan must be self-contained. It must include all context, assumptions, paths, commands, and success criteria needed to complete the task.

Every ExecPlan must be written for a novice to this repository. Define terms of art in plain language the first time they appear, and tie them to the actual files, commands, or services used in this repo.

Every ExecPlan must aim at observable, working behavior. "Code compiles" is not enough. The plan must explain what a user, operator, or reviewer can do after the change and how to observe that the change works.

Every ExecPlan must remain current. If implementation uncovers new facts, the plan must be revised so it still reflects reality. A stale plan is a broken plan.

Every ExecPlan must embed required knowledge directly in the document. Do not depend on blog posts, prior chats, or external design docs for core instructions. If external behavior matters, summarize it inside the plan in your own words.

## When To Create An ExecPlan

Use an ExecPlan when the work is substantial enough that ad hoc execution is likely to lose context or drift. In this repository that usually means one or more of the following:

1. A feature or refactor that touches multiple directories such as `src/`, `script/`, `test/`, `agent/`, or `agent-library/`.
2. An agent buildout that requires research, scaffolding, lifecycle work, tests, and review iteration.
3. A migration, deployment flow change, or stateful system change that needs careful rollback and validation steps.
4. A long bug hunt or reliability effort where multiple findings and attempted fixes must be tracked over time.
5. Any task the user explicitly asks to run for a long time, iterate deeply, or carry from design through implementation.

Small, local edits do not need an ExecPlan unless the user asks for one.

## Repository-Specific Expectations

The plan must obey the instruction hierarchy in `AGENTS.md` and any closer `AGENTS.md` file in the affected area.

If the work touches `agent-library/agents/<name>/`, keep agent-specific behavior local to that agent unless the change is clearly shared infrastructure. If shared files under `agent/src/lib/` or `agent/src/index.js` must change, the plan must explain why the change is cross-agent rather than one-off behavior.

If the work touches Solidity contracts or deployment scripts, the plan must call out the exact Foundry commands to run, the expected environment variables, and whether validation happens against Anvil, a testnet, or a live chain.

If the work touches agent modules, the plan must name the module-specific tests or simulations to run, plus `node agent/scripts/validate-agent.mjs --module=<name>` when applicable.

If the work depends on secrets, API keys, RPC endpoints, or geographic constraints, the plan must say so explicitly and provide a safe non-production validation path where possible.

## Required Structure

Each ExecPlan must include all of the following sections. These section names are mandatory so progress stays easy to scan and recover:

1. `Purpose / Big Picture`
2. `Progress`
3. `Surprises & Discoveries`
4. `Decision Log`
5. `Outcomes & Retrospective`
6. `Context and Orientation`
7. `Plan of Work`
8. `Concrete Steps`
9. `Validation and Acceptance`
10. `Idempotence and Recovery`
11. `Artifacts and Notes`
12. `Interfaces and Dependencies`

The `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` sections are required living sections. They must be updated as the work progresses.

## Formatting Rules

If you are presenting an ExecPlan inline in chat, the entire plan must be one fenced Markdown block labeled `md`. Do not nest additional triple-backtick fences inside it. Use indentation for commands, snippets, and example output.

If the plan is stored in its own Markdown file in this repository, omit the outer fence and make the file contents the plan itself.

Use normal Markdown headings with blank lines after each heading. Write mainly in prose. Use lists only where they make the document clearer. Checklists are mandatory only in the `Progress` section.

## Writing Guidance

Start with user value. Explain what becomes possible after the change and how to observe it working.

Be explicit about repository context. Name full repository-relative paths, concrete functions or modules, and how the touched areas relate to one another.

Prefer precise commands over vague instructions. For every command, state the working directory and the exact command line. If the result matters, describe the expected output or behavior.

Resolve ambiguity in the document. Do not outsource core design choices to the future implementer. If there are tradeoffs, choose a path and explain why.

Keep steps safe and repeatable. If a step can be retried safely, say so. If a step is risky or destructive, explain rollback or recovery first.

Include evidence. Short transcripts, diff excerpts, or logs are encouraged when they prove the feature works or explain a discovery.

## Milestones

Milestones should tell a story, not just act as bureaucracy. Each milestone should explain:

- what will exist after the milestone that does not exist before
- which files or modules will change
- what commands to run
- what acceptance evidence should appear

Each milestone should be independently testable and should advance the work toward a working end-to-end result.

Prototyping milestones are encouraged when they reduce risk. If a prototype is included, label it clearly, explain how to run it, define what question it answers, and define the condition for promoting or discarding it.

## Validation Is Mandatory

Every ExecPlan must include validation steps that go beyond compilation when possible.

For Solidity work, use the appropriate subset of:

- `forge fmt`
- `forge build`
- `forge test`
- `forge snapshot`

For agent and Node.js work, use the exact module-specific test commands plus any shared validation commands that prove the module still loads and behaves correctly.

For end-to-end flows, include the setup assumptions, the commands to exercise the flow, and the specific behavior to observe.

If a validation step cannot be run in the current environment, the plan must say what is missing and how a future contributor should run it.

## Progress Tracking Rules

The `Progress` section must always reflect current reality. Use checkboxes with timestamps. If a task is partially complete, split it into completed and remaining pieces rather than leaving stale text.

Example format:

- [x] 2026-03-23 14:10Z: Audited current agent lifecycle and identified restart-recovery gaps.
- [ ] Add reimbursement backfill reconciliation for deleted and executed proposals.
- [ ] Re-run module tests and update outcomes with the final evidence.

## Decision Log Rules

Each decision entry must include:

- the decision
- the rationale
- the date and author

Short format is fine as long as it is specific.

## Surprises & Discoveries Rules

Use this section for facts learned during implementation that changed the approach, such as:

- hidden state or lifecycle coupling
- unexpected tool behavior
- production constraints
- test failures that exposed a deeper issue
- performance or safety tradeoffs

Include concise evidence such as a failing test name, an error string, or a command result.

## Outcomes & Retrospective Rules

At the end of a major milestone or at completion, summarize what changed, what remains, and what was learned. Compare the outcome against the original purpose so the next reader can tell whether the work succeeded.

## Skeleton

Use this skeleton as the starting point for a task-specific ExecPlan:

    # <Short, action-oriented title>

    This ExecPlan is a living document and must be maintained according to `PLANS.md`.

    ## Purpose / Big Picture

    Explain what new behavior or capability will exist after this change, who benefits, and how to observe it working.

    ## Progress

    - [ ] Example task.

    ## Surprises & Discoveries

    - Observation: None yet.
      Evidence: N/A.

    ## Decision Log

    - Decision: Initial plan created.
      Rationale: Large task requires a recoverable working document.
      Date/Author: 2026-03-23 / Codex.

    ## Outcomes & Retrospective

    Record milestone outcomes and final lessons here.

    ## Context and Orientation

    Describe the relevant code paths, modules, contracts, scripts, tests, and runtime assumptions in plain language.

    ## Plan of Work

    Describe the sequence of changes in prose, naming exact files and functions.

    ## Concrete Steps

    State exact commands, working directories, and expected outputs.

    ## Validation and Acceptance

    Describe how to prove the change works with tests and observable behavior.

    ## Idempotence and Recovery

    Explain how to retry, recover, or roll back risky steps safely.

    ## Artifacts and Notes

    Include short transcripts, snippets, or other evidence.

    ## Interfaces and Dependencies

    Name the functions, contracts, modules, tools, services, and environment variables that must exist or be used.

## Practical Notes For This Repository

For contract work, make sure the plan states which test files under `test/` will prove the behavior and which deployment scripts under `script/` are affected.

For agent work, make sure the plan states which files under `agent-library/agents/<name>/` own the new behavior and whether any shared files under `agent/src/lib/` are intentionally changed.

For long-running agent buildouts, plans should explicitly include:

- research and design milestones
- implementation milestones
- review-and-fix loops
- module validation commands
- end-to-end dry-run or simulation steps

That is the standard for autonomous, multi-hour work in this repository: the plan must be complete enough that progress can continue safely even after interruption, compaction, or handoff.
