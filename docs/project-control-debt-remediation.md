# Project control-debt remediation

These broker operations repair legacy registry debt without deleting a job,
rewriting an authored workspace, or fabricating `failed_no_output` evidence.
They are preview-first and require an exact plan hash on confirmation.

## Evidence custody scope

Controllers that read or write terminal-output evidence declare an explicit,
narrow `projectAccessScope.consumedOutputEvidenceRoots` array. Each root must be
an existing canonical directory named `archives`; the lexical path must equal
its physical path, so leaf and ancestor symlinks are rejected. Do not grant a
cache parent such as `/root/.cache/subscription-runtime`.

Ledger readers and rejection/archive writers consume the same roots. Writers
revalidate every archive, status, patch, numstat, untracked archive, and
preexisting-patch path immediately before ledger publication. A missing field
falls back only to the configured ledger root, never to a derived grandparent.

`codex_goal_project_update_controller_scope` can append an evidence root. Use
`confirmUpdate:false` first and repeat the exact request with
`confirmUpdate:true`. Existing evidence roots cannot be removed by repair.

## Retire an unlaunched missing-workspace summary

`codex_goal_project_retire_legacy_job_summary` is only for a manifest-only
registration whose workspace is genuinely absent. Preview proves:

- exact manifest path and SHA-256 CAS;
- workspace `ENOENT` through a canonical ancestor;
- stopped/no live worker;
- no launch, handoff, result, output, progress, or log artifact;
- an exact, distinct, same-project sibling registration for the same workspace.

Confirmation requires `expectedRetirementPlanSha256` and writes a new,
fsynced, immutable receipt beneath
`.project-control/legacy-job-summary-retirements`. It never deletes or rewrites
the original manifest. Admission suppresses only the summary whose current
path, SHA-256, and workspace still match the receipt. The receipt remains in
the admission snapshot as `retiredLegacyJobSummaries`; a later manifest change
automatically restores that summary to active projection.

## Import immutable frozen output

`codex_goal_project_import_frozen_output` imports preservation evidence for
stopped dirty legacy registrations. The source patch and its source manifest
must be canonical, no-symlink files beneath a configured project `readRoots`
entry. The request binds source path, SHA-256, byte length, manifest SHA-256,
changed paths, base commit, head commit, and patch SHA-256. The destination
must be an exact configured `consumedOutputEvidenceRoots` entry, and the
registration destination must be an exact `consumedOutputLedgerRoots` entry.

The retained registration must belong to the same project and have a real,
nonempty output artifact whose SHA-256 is supplied. Every superseded legacy
summary must be stopped, dirty, output-free, present, canonical, and bound by
manifest path and SHA-256. Missing, clean, live, or output-bearing candidates
are refused.

Confirmation requires `expectedFrozenOutputImportPlanSha256`. The broker
reopens the sources with `O_NOFOLLOW`, verifies file identity before and after
reading, copies bytes into a plan-hash directory using exclusive fsynced files,
and publishes an exclusive fsynced receipt. Exact replay is idempotent.
Admission suppresses only exact superseded manifest identities and exposes the
receipts as `supersededFrozenOutputSummaries` for audit.

Frozen output remains authored preservation evidence. Import does not alter a
workspace and must never be represented as `failed_no_output`.
