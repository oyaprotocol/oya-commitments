# Gardener feedback

These records connect feedback on Oya Gardener's contributions to concrete changes in how future recurring work is done. Comment on a record's pull request to suggest a refinement, challenge an interpretation, or ask for a change to be reverted.

## Review cycle

At 08:00 and 20:00 Pacific time, the Gardener reviews recent PRs, public comments and reviews, and the overall flow of its contributions. It looks for useful patterns in clarity, scope, testing, collaboration, repeated rework and reviewer burden. More PRs, lines or activity are not success measures.

A worthwhile change gets a new `YYYY-MM-DD-short-topic.feedback.json` file and a PR marked `<!-- oya-gardener:feedback -->` with the `gardener:feedback` label. The Gardener verifies that public record before updating its job instructions. The PR description states whether application is pending, applied or blocked. An applied change affects future runs even while its record awaits human merge.

Reviews that find no justified change stay quiet. The next review evaluates previous changes rather than repeatedly adding the same advice. Published record payloads are append-only: corrections and reversals receive new records, while conflict repairs preserve the original payload exactly. The reviewer can repair an interrupted publication's application-status text after verifying its original run has stopped, the application evidence, and current public ownership.

## Reading a record

- `id` identifies the change and matches the filename.
- `summary` explains the adjustment and its intended benefit.
- `evidence` links public source material and distinguishes observations from interpretation.
- `evaluation` describes what future evidence would support keeping, revising or reversing the change.
- `changes` lists affected job roles, exact previous and replacement feedback guidance, and a checksum used to detect intervening edits.

The schema identifier is `oya-gardener-feedback/v1`. Job roles are `dependencies`, `small-improvement`, `feature`, `dialogue` and `response-worker`. Each change contains `target`, `before_sha256`, `before_guidance` and `after_guidance`. Guidance is a bounded section of the job's instructions, not a replacement for the whole job.

## Scope and activation

Automatic changes improve contribution style and technique within the jobs' existing authority. Schedules, capacity and size limits, permissions, security requirements, model and skill settings, and human-only merging remain operator-controlled. Evidence is assessed in context, not copied into instructions blindly. Private conversations, credentials and internal operational records stay private.

Each application preserves a private recovery snapshot and verifies the resulting instructions. If publication or verification fails, the failure is reported rather than presented as a successful update. A closed or merged PR is never silently rewritten. Merging a feedback PR incorporates its record into the repository. Closing one does not itself revert an already-applied change, so please state a requested correction or reversal in feedback.
