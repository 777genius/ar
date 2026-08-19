# Project control-debt remediation

These broker operations repair legacy registry debt without deleting a job,
rewriting an authored workspace, or fabricating `failed_no_output` evidence.
They are preview-first and require an exact plan hash on confirmation.

## Evidence custody scope

The local evidence-custody adapter is Linux-only. It requires procfs fd paths
to keep traversal and publication relative to held directory handles. On other
platforms, project-control operations that require evidence custody fail closed
with `project_control_evidence_custody_platform_unsupported`; ordinary runtime
operations that do not request this custody boundary remain available. A
lexical-path fallback is intentionally forbidden because it would weaken the
TOCTOU guarantees described below.

Controllers that read or write terminal-output evidence declare an explicit,
narrow `projectAccessScope.consumedOutputEvidenceRoots` array. Each root must be
an existing canonical directory named `archives`; the lexical path must equal
its physical path, so leaf and ancestor symlinks are rejected. Do not grant a
cache parent such as `/root/.cache/subscription-runtime`.

Evidence and ledger roots must also be descendants of an immutable project-owned
read, workspace, worktree, isolated-workspace, observed-workspace, or registry
root. A denied root may neither contain a custody root nor be contained by one.
These identities are revalidated whenever the controller is loaded and again
through directory-handle-relative, no-symlink writes during materialization.

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

Both registry jobs must match a controller-owned job prefix. A scoped legacy
manifest must name the same project. An older unscoped manifest is accepted only
when its exact manifest and job-root locations match the prefixed registry job;
the retained sibling must always carry the current project scope.

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

The source manifest is strict and contains only `schemaVersion`, `projectId`,
`controllerJobId`, `patch`, and `retainedOutput`. Its patch descriptor binds the
SHA-256, byte length, base and head commits, and changed paths. Its retained
descriptor binds the job, manifest SHA-256, and output SHA-256. The broker also
streams the format patch itself, derives its `From`, `base-commit`, and
`diff --git` identities, and requires them to equal the request and manifest.

Confirmation requires `expectedFrozenOutputImportPlanSha256`. Under the scope
lock the broker reloads and CAS-checks the controller, then reopens every source
with `O_NOFOLLOW`. A worker-local custody adapter streams copies through
directory handles, fsyncs each new directory entry, custody-copies the patch,
source manifest, retained manifest, and retained output, publishes the ledger
registration, and publishes the receipt last as the commit marker. Exact replay
and recovery from a prepared ledger registration are idempotent.
Admission suppresses only exact superseded manifest identities and exposes the
receipts as `supersededFrozenOutputSummaries` for audit.

Frozen output remains authored preservation evidence. Import does not alter a
workspace and must never be represented as `failed_no_output`.
