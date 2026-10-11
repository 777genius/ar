# Retained nonqualified original attempt

Source implementation of the narrow operation described in the Runtime retained
attempt contract. Status: **implemented in source, not accepted, not deployed,
not run on any original job.** Independent review, exact-current-code CI, an
installed-artifact check and a separate TEST exercise against the exact retained
evidence are still required before the operation may touch the original attempts.

## What it is

`codex_goal_project_retain_nonqualified_attempt` is a root-admin Project Control
adapter. It records a native terminal ledger decision with status
`retained_nonqualified` for a stopped original attempt whose terminal result is
**absent** (`original_result_missing`) or a genuine **failed** result
(`original_failed_checkpoint`). It retains custody of the exact bytes and nothing
else. It manufactures no stop event, DONE result, no-output claim, approval,
admitted patch or qualification, and it authorizes no replay. The receipt and the
ledger record say so explicitly: `sourceQualification: "not_assessed"`,
`replayAuthorized: false`. Technical review decisions (for example
REQUEST_CHANGES) are separate and untouched.

Existing routes are unchanged and still reject these input classes:
`archive_reviewed_output` needs an approved output and a literal DONE result,
`record_failed_no_output` needs a clean (or exact pre-existing patch) workspace,
and `retire_legacy_job_summary` needs an absent workspace. Generic `archived` is
not loosened: an input-only backup is still invalid as `archived`
(`terminal output status archived has no authored output evidence`), which is why
a dedicated discriminated status exists (`retained-nonqualified-attempt.test.ts`
asserts both sides on the identical backup).

## Placement (shared-first decision, as accepted)

Runtime Host owns the retained-data policy, broker authorization, file custody
and ledger/admission integration. It reuses the existing terminal-output decision
contract and native ledger writer, evidence custody (`publishImmutableBytes`,
no-follow reads), canonical workspace lock, secure root permit, recovery
directory identities, the legacy-attempt process inventory, the raw-patch capture
and the USTAR builder used by handoff. A small deterministic receipt
discriminator and validator live next to the terminal-output contract in
`worker-core/project-control/domain/retained-nonqualified-attempt.ts`; dependency
direction is admission reader -> immutable retained receipt, and execution policy
never names product-specific jobs. No `@get-modular` runtime manager, new SPI,
Core/Assembly handle or new broad contract is introduced. The two secure-permit
reads are now one shared helper (`codex-goal-mcp-project-control-root-permit.ts`,
used by the approved-archive and this operation) and the one-disposition-per-job
guard is shared (`codex-goal-terminal-disposition-guard.ts`); both keep the
archive's error codes. Other root-admin permit readers (published adoption and
reconciliation) were not touched and still carry their own copy.

## Operation

Arguments: `registryRootDir`, `controllerJobId`, `workerJobId`, `permitFile`,
`expectedPermitSha256`, optional `expectedPlanSha256`, optional
`confirmRetention`. Omit `confirmRetention` for the **preview**.

The permit is a root-owned regular non-symlink `0600` file of at most 128 KiB
(same checks as the approved archive). Its strict schema
(`retainedNonqualifiedPermitSchema`) binds the controller, project, worker, task,
registry, worker job root, source workspace, both raw job-manifest SHA-256 values,
the expected base commit, the original kind, the exact archive path
(`<evidenceRoot>/nonqualified-retention-<workerJobId>`) and the evidence and
ledger root device/inode, plus owner, reason and requested time.

Preview, under the existing canonical workspace lock, rechecks project/controller/
job manifest CAS, the live writer absence, the stable closed inventory and the
original result state, then returns a hash-bound plan: `planSha256` (the SHA-256
of the exact receipt bytes), `headCommit`, `inventoryDigest`, entry and byte
counts, the per-file backup hashes and the **measured** capacity. Preview publishes
nothing. Confirm requires `confirmRetention: true` and `expectedPlanSha256` equal
to a freshly recomputed plan; any changed byte yields
`retained_nonqualified_plan_mismatch`.

Writer absence is checked three ways: native status (tmux, liveness, progress PID
and a present progress record must be consistent; a stale `running` record with
no live process is the expected shape), the Linux process inventory
(`captureLegacyAttemptProcessEvidence`) over the workspace and job root (cwd, argv
and open descriptors; any holder refuses with its PID; an unavailable inventory
refuses), and an unexpired account lease refuses. Nothing is stopped or released.

The inventory (`codex-goal-retained-nonqualified-inventory.ts`) hashes every
tracked change relative to HEAD (staged or not) and every untracked file, with mode
and size, and binds each tracked entry's **independent stage-zero index entry** (git
mode and object id) next to the two-character status. Index-only drift (staged blob
A replaced by C while HEAD, worktree bytes and the `MM` status are unchanged) therefore
changes the digest. Staged blobs that differ from HEAD are archived as raw bytes in
`staged.tar` (binary-safe, via `git cat-file`), so the index and the worktree can be
rebuilt as distinct states from custody alone; `tracked.diff` carries the worktree
side. Symlink/special-file aliases, escaping or aliased parents, nested repositories,
gitlinks, unmerged entries, untracked symlinks, an empty inventory, more than 20,000
entries or the policy's combined worktree+staged byte cap (64 MiB under `default_v1`, 384 MiB
under `expanded_v1`; see "Finite resource policy"), any Git conversion (`core.autocrlf`, filters, attributes) and a tree
that changes while read all refuse.

Ignored files are never silently omitted. Each one must be named in the permit's
`ignoredRetain` (exact relative paths; the bytes go into `untracked.tar` and the
digest) or lie under a rebuildable dependency/cache directory (`node_modules`,
`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.venv`), which is recorded by name in
`ignored.disposableListing` and never copied. Anything else (`ignored_unclassified`), a
retain path that is not an ignored file, and any credential/auth/session-looking path
(`.env*`, `.npmrc`, `.ssh`, `.codex`, `.claude`, key/cert files, `auth`, `credentials`,
`sessions`) refuse; nothing credential-like is ever archived. There is no manual
"complete" declaration: the operator can only retain more or the operation refuses.

Lifecycle originals (`codex-goal-retained-nonqualified-lifecycle.ts`): the result,
progress, runtime events, stop-event marker, account reservation, the registry job
manifest, the job log and the prompt are located from the job manifest by one shared
function (producer and admission), and the exact bytes and mode of every present one
are archived in `lifecycle.tar` (absent ones stay absent and are not synthesized),
with their state, hash, size and mode in the receipt. The failed result, its events and
the job metadata are therefore recoverable even if the job directory is lost.

Capacity is measured with `statfs` on both the durable evidence root and scratch
and must hold the complete backup (all seven payloads) plus a 4 MiB margin
(`retained_nonqualified_capacity_insufficient`; no guard is bypassed). The plan refuses
rather than truncates when the tree, lifecycle (64 MiB) or entry limits of the permit's
resource policy are exceeded.

Publication order, all through immutable custody: `owner-intent.json`, then the
preparation anchor `<evidenceRoot>/nonqualified-retention-<job>.preparation.json`
(binds permit, receipt hash and archive directory device/inode), then
`git-status.txt`, `tracked.diff` (HEAD-to-worktree TRACKED binary-safe diff only; untracked
files are NOT in it),
`tracked.numstat`, `untracked.tar` (raw bytes and modes, including retained ignored
inputs), `staged.tar` (staged blobs), `lifecycle.tar` (original lifecycle bytes), then the receipt
`retained-nonqualified-attempt.json` **last**, then the native ledger decision
under the existing ledger mutation locks. Directory identities are rechecked
around every step, and the publication boundary re-verifies manifests, the absence of any
other disposition, every backup hash and (first consumption only) quiescence, the
complete lifecycle state (result, progress, events, stop event, reservation,
manifest, log, prompt) and the inventory digest including the index.

Idempotence and partial publication: publishing identical immutable bytes is a
no-op, so a rerun under the same permit completes the same attempt (interrupted
backup, receipt without ledger record). A changed source, a different owner or a
different preparation anchor refuses (`retained_nonqualified_preparation_conflict`,
immutable conflict) and leaves the evidence in place; there is no automatic
cleanup. A committed record replays without recapturing the (legitimately
changing) workspace, after verifying receipt, preparation anchor and backup hashes.

## Records

Ledger record (`items/<jobId>.json`): `status: "retained_nonqualified"`,
`archivePath`, a `backup` with status, patch, numstat and untracked archive paths,
and `retention: { schemaVersion, kind, receiptPath, receiptSha256,
sourceQualification: "not_assessed", replayAuthorized: false }`. No commit,
failure, output, attempt, patch or publication field is allowed
(`assertTerminalOutputDecision`), and `retention` is forbidden on every other
status, so a forged field cannot turn an ordinary disposition into this one.

Receipt (`retained-nonqualified-attempt.json`, validated by
`assertRetainedNonqualifiedReceipt`): permit hash, identities, workspace, HEAD,
both manifest hashes, the original result/progress/events/stop-event/account
reservation/job manifest/log/prompt as `absent` or `present` with SHA-256, size and mode, `resultStatus: "failed"`
only for `original_failed_checkpoint` (the kind must match the preserved facts),
the ignored-file classification, the complete inventory (each tracked entry with its
independent index mode and object id) with digest, the hashes of all seven archival payloads and `retainedAt`
(the permit's `requestedAt`, so the plan is deterministic).

## Admission

The shared reader (`consumed-output-ledger.ts`) accepts `retained_nonqualified`
only when the discriminator is valid, the receipt lies in the backup root and its
bytes hash to `receiptSha256`, and every backup payload still exists; otherwise it
is blocking `IncompleteConsumedOutputRecord` debt (never "pruned retention"). It
is deliberately **not** registered by workspace, so it cannot consume another
job's debt. Generic `hasAuthoredOutput` is neither required nor claimed.

Admission (`codex-goal-project-retained-nonqualified-admission.ts`) lets the record
consume a stopped dirty workspace only after re-verifying, against the present disk, the
receipt, every lifecycle path derived from the manifest (path, present/absent, hash,
size, mode, including stop event, account reservation, log and prompt), a fresh
reservation that is unexpired or malformed (refused), every archival payload hash, HEAD,
the full inventory digest with the independent index and the ignored-file
classification, `workerAlive === false`, no conflicting risk, and the same fail-closed
Linux custody-path process inventory the producer uses (a holder with a new PID that
native flags cannot see restores debt; an unavailable inventory refuses). A skipped fast
path (`debtFromConsumedJobSummary`) forces the fresh live read. Any change restores
blocking debt. `workerExplicitlyStopped` in this source is derived from the live
observation (`workerAlive === false`), so no historical stop event is needed or faked.
Downstream, `assertCodexGoalProjectJobNotTerminal` already refuses to start a job
that has any valid terminal record other than the rejected/no-output exceptions,
so a retained job cannot be started or continued through the normal routes.

## Compare retained 6b31 with current d6127e2d (Consumer Module Standard)

Document `docs/architecture/common-assembly.md` in `agent-teams-ai/get-modular`.
Both Git blob ids and SHA-256 values below were verified against the supplied
bytes and the GitHub contents API.

| Identity | Retained | Current |
| --- | --- | --- |
| Commit | `6b31f20fe3e5fb8324812aa2ee907905751cde71` (2026-09-22) | `d6127e2d3f499b91b220a222fc3672d29dff1ab2` (2026-10-10) |
| Git blob | `93e743d9f833b698fc3106054aafc449c6d9f8f9` | `bb36631c0ba14ad24521a8b675a5047e07b72580` |
| SHA-256 | `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f` | `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7` |
| Size / lines | 22337 B / 363 | 47402 B / 796 |

The current bytes are identical at `81063add7de50ffe2b91cc74bf7271b298624c21`
(blob `bb36631c...`), which several existing docs already pin. Exact delta:
`diff retained current` has 489 changed lines (461 insertions, 28 deletions),
SHA-256 of that normal-diff output
`7c6bb96a0732f42fd0057adee56671b342a70bfdcaeea026767a37c3444432f1`; the
unified form (`diff -u`, 616 lines) hashes to
`275e71d685dea085c6856ef4544b63e4d81d6ad9c505b3b1d5dbf72c9af344d8`. Reproduce
with the two commits' bytes from the GitHub contents API.

Section delta: the front matter adds ADR-0029..0033. Authority adds the capability
descriptors (ADR-0032) and moves cleanup authority wording ("modules register their
own cleanup through the optional resources package"). New sections: *Optional
dynamic Host lifecycle candidate* (ADR-0029, candidate only), *Module resource
scopes* (ADR-0030, optional `@get-modular/resources`), *Dynamic instances*
(ADR-0031, per-run scope and declared inputs), *Module packages and contracts*
(ADR-0032 builder, descriptors, peer-dependency rules), *Identity and namespaces*
and *Testing modules* (ADR-0033 conformance kit). *Executable examples* adds the
new test paths and commands; the Agent Runtime paragraph no longer pins its
standard revision in this document; API/preparation/execution/outcome sections add
`scope`, `inputs` and input handles; the definition of done adds builder and
fragment fixtures; historical admission adds ADR-0027/0031.

Effect on this feature: none that changes behavior. This feature is a cohesive
Host-owned module using static imports and typed factories, creates no Core or
Assembly handle, module, contract descriptor, resource scope or dynamic instance,
and registers nothing for lifecycle. The "fixed library dependencies and private
helpers inside a cohesive feature remain static imports" rule is unchanged
(present in both). **Adoption remains pending:** this is a classification
reference, not an accepted consumer adoption pin, and no Assembly adoption,
consumer profile, new FMS activation or repository-wide conformance is claimed.
ADR bytes are not replaced or edited. Documents updated to the current identity:
`private-cold-maintenance.md`, `terminal-attempt-checkpoint.md`,
`hosted-custody-test-observations.md`; `hosted-readonly-inputs-implementation.md`
keeps its historical `03a7df64` checkpoint with a pointer here. Documents already
pinned to `81063add`/`49d08b6d` (published-output-reconciliation,
published-integration-commit-adoption, hosted-public-research) are byte-identical
to the current document and were left as they are.

## Verification record

All commands ran in this checkout (or a disposable container with the source
mounted read-only) with output captured to
`.tmp-retention-worker-a2/` and the real exit code recorded. Nothing was staged,
committed, pushed, deployed or run against an original host, provider or job.

Changed paths: `docs/architecture.md`, `docs/hosted-custody-test-observations.md`,
`docs/hosted-readonly-inputs-implementation.md`, `docs/private-cold-maintenance.md`,
`docs/published-output-reconciliation.md`, `docs/terminal-attempt-checkpoint.md`,
`docs/retained-nonqualified-attempt.md` (new); `worker-core/project-control`:
`application/consumed-output-ledger.ts`, `domain/terminal-output-decision.ts`,
`index.ts`, `domain/retained-nonqualified-attempt.ts` (new),
`tests/retained-nonqualified-attempt.test.ts` (new); `worker-codex`:
`codex-goal-project-admission.ts`, `codex-goal-project-terminal-consumption.ts`,
`codex-goal-mcp-project-control-admin-tool-registration.ts`,
`codex-goal-mcp-project-control-reviewed-archive.ts` (shared permit/guard refactor),
new `codex-goal-mcp-project-control-retained-nonqualified.ts`,
`codex-goal-mcp-project-control-root-permit.ts`,
`application/project-control/codex-goal-retained-nonqualified-inventory.ts`,
`codex-goal-project-retained-nonqualified-admission.ts`,
`codex-goal-terminal-disposition-guard.ts`, and tests
`codex-goal-mcp-project-retained-nonqualified.test.ts` and
`codex-goal-project-retained-nonqualified-admission.test.ts`.

| Check | Command | Result |
| --- | --- | --- |
| Strict typecheck | `npm run build:packages` then `npx tsc --noEmit -p tsconfig.json` (TypeScript 6.0.3; the global `tsc7` rejects this repo's `baseUrl`, so the local compiler is used) | exit 0, empty output |
| Boundaries | `node scripts/check-boundaries.mjs`, `check-architecture-guardrails.mjs`, `check-managed-launch-boundary.mjs`, `check-git-diff.mjs` | OK / exit 0. The first guardrail run failed (`codex-goal-project-admission.ts` 1061 lines, cap 1051); the admission wiring moved into the new module, now 1045 |
| macOS non-root focused | `vitest run` the domain, admission and operation test files, `TMPDIR` in scratch | exit 0, 3 files, 56 tests (57 after the inner-guard test was added and run in the mutation script) |
| Linux root container, focused | `docker run` node:24-bookworm (amd64, emulated), uid 0, source read-only, container-private `npm ci`: operation (31), admission (34), domain (20), `failed-no-output`, `reviewed-archive`, `project-admission` test files | `vitest-exit=0`, 6 files, 166 tests passed |
| Linux root container, broad regression (earlier snapshot) | 33 admission/ledger/archive/failed-no-output/published/terminal files | 665 passed, 1 skipped, summary line only (see limitations); taken before the admission-wiring refactor |

The operation suite's lane (Linux, root, custody) is the one that exercises the
real producer: preview without effects, plan-hash confirm, retention of both
kinds, admission read through the real MCP snapshot tool (blocked before,
allowed after, restored when bytes change), no original byte moved and no stop
event created, idempotent replay, wrong scope/manifest/base/path/kind, forged DONE,
live writer / descendant / unexpired lease / live progress PID, untracked symlink,
nested repository, empty inventory, change between preview and confirm, interrupted
backup, failure after the receipt, competing disposition, tampered backup, and the
old `record_failed_no_output` route still refusing the same workspace.

Old RED / new PASS. The new status does not exist at the canonical commit, so a
HEAD run of the new tests fails on the missing symbols and is not a meaningful
RED; the HEAD comparison started in a generic temp directory was interrupted and
is not claimed. The meaningful pair is inside the suite: the identical input-only
backup is invalid as `archived` (old route, unchanged) and valid as
`retained_nonqualified` (`retained-nonqualified-attempt.test.ts`). Real REDs seen
while building: the reader accepted a record with one missing backup payload (the
generic check passes if any one payload exists), fixed by requiring all four; an
inventory path ending in `/` (nested repository) refused with the wrong code;
the process-evidence contract needs sorted custody paths.

Guard mutations (rule 31: assert applied, observe failure, restore, observe green;
files restored byte-identical). `mutation.log`, `mutation-m2.log`:

| Mutation | Applied | Mutated run | Restored |
| --- | --- | --- | --- |
| M1 admission verifier skips the inventory comparison | 1 | 12 of 34 fail | 34 pass |
| M2 terminal consumption stops requiring the verified flag | 1 | first run survived (the later unverified-debt guard also blocks); after adding the inner-guard test, 1 fails | 35 pass |
| M3 reader skips the receipt hash check | 1 | 1 of 20 fails | 20 pass |
| M4 writer allows retention on other statuses | 1 | 1 of 20 fails | 20 pass |
| M5 admission fast path trusts the record without a live read | 1 | 26 of 34 fail | 34 pass |
| M6 reader accepts any one backup payload | 1 | 2 of 20 fail | 20 pass |
| M7 operation skips the live-writer/descendant check (Linux root, 31 tests) | 1 | 1 fails | 31 pass |
| M8 operation accepts a non-failed original result | 1 | 1 fails | 31 pass |
| M9 confirm no longer requires the plan hash | 1 | 3 fail | 31 pass |
| M10 operation ignores an unexpired account lease | 1 | 1 fails | 31 pass |

M7 to M10 ran in a container-private copy (`linux-root-mutation.log`). Other
operation guards (capacity, directory identity drift, base commit) rely on their
direct tests but were not individually mutated.

### macOS failures in the earlier broad run (171 failed, 366 passed, 46 skipped)

The preserved log (`.tmp-retention-operator-custody-a1/a1-regression-mac.log`)
shows environment classes, not this change: `git commit` rejected by the host's
identity hook (author must be the owner; 25 of the failures, fixtures commit as a
test user), `project_control_evidence_custody_platform_unsupported` (custody is
Linux-only), `unregistered registry directory` and `consumed_output_ledger_root_alias_denied`
(macOS `/var` to `/private/var` aliasing of temp paths). The same files passed on
Linux root (665 passed). No identical-set macOS baseline at the canonical commit
was completed, so "pre-existing on macOS" is inferred from the error classes, not
measured. The broad run was not repeated.

### Controlled interrupt and temporary-file custody (historical, not compliant)

The operator interrupted the session once with SIGINT (process 16467, terminal
exit 0) and the same session resumed; no replacement writer was started and no tool
was replayed. Earlier in this session, against the instruction to use own scratch,
this worker wrote generic system-temp artifacts and background shell jobs. The
operator preserved exact copies of the five originals with hashes, modes and
ownership in `.tmp-retention-operator-custody-a1/historical-temp-violation-custody.json`:
`npm-ci-a1.log`, `run-a1-linux.sh`, `a1-regression-files.txt`, `a1-regression-mac.log`,
`a1-regression-linux-root.log` (originals left in place). The same session also wrote
further generic files the operator list did not include: `/tmp/a1-linux-root-run1.log`,
`run2.log`, `run3.log`, `/tmp/build-pkg.log`, `/tmp/cms-delta.diff`,
`/tmp/a1-failing-files.txt`, `/tmp/a1-head-fail.json`, `/tmp/a1-head-run.log`,
`/tmp/a1-mine-run.log` and a `git archive` copy at `/tmp/a1-head/`. None was cleaned;
this is not historical compliance. The leftover container
`sr-a1-retain-linux-root-31576` ran to completion (665 passed, 1 skipped) and
exited; its container-private paths died with it. All later runner scripts, logs and
fixtures are under `.tmp-retention-worker-a2/` with `TMPDIR` set there and each
command run in the foreground with its real exit code.

Limitations of the historical evidence: the three `a1-linux-root-run*.log` files and
the broad regression summary were produced through `head`/`grep`/`tail` pipelines, so
their printed `exit` values are the pipeline tail's, not vitest's, and the logs are
truncated; only the vitest summary lines inside them are evidence. The focused
post-refactor runs above record `vitest-exit` directly.


## Limitations and remaining work

- Not run on any original job and not accepted. Remaining before use: independent
  source review, exact-current-code CI (including the root Linux lane), installed
  artifact qualification and rollback pins, and a separate TEST exercise of
  preview, confirm, idempotence and partial reconciliation against the exact
  retained evidence. The existing admission gate still applies to any producer
  implementation; this change retires nothing by itself.
- The operation tests need Linux, effective UID 0 and custody (same lane as the
  approved archive). They do not run on macOS or as a non-root user; those lanes
  run the capacity guard, the non-root refusal and the reader/admission suites.
  The operation tests added in the review-correction round were typechecked but
  **not executed by this worker**; the operator's root lane must run them.
  The operation suite is enforced by the existing `archive-root-tests` job in
  `.github/workflows/ci.yml` (fixed disposable root Vitest file list beside the approved
  archive; Node 22, unchanged privilege, triggers and limits). Normal unit CI is
  non-root and skips it. Node 22 is the only root CI baseline here; Node 24/26
  qualification is separate and not claimed.
- A workspace with ignored files that are neither named in `ignoredRetain` nor under a
  dependency/cache directory (or that look like credentials) is refused, not
  approximated; untracked symlinks, nested repositories and trees over 20,000 entries or
  the policy's combined byte cap (64 MiB `default_v1`, 384 MiB `expanded_v1`) are refused too. Whether the original13 contain such files is unknown here:
  an exact complete useful-input inventory for them is still required before use.
- Admission re-hashes the lifecycle, inventory, backup and rescans the Linux process
  table on each evaluation (bounded by the limits above); the existing short admission
  cache TTL knob applies. On non-Linux hosts retained admission therefore refuses.
- A source that changes after a partial publication cannot be reconciled
  automatically; the immutable partial evidence stays and the owner decides.
- The process inventory is Linux `/proc`; elsewhere the operation refuses.
- The approved-archive, published-adoption and published-reconciliation permit
  readers remain separate beyond the shared pieces named above.
- Observer and public-fixture correction work is out of scope here.

## Independent review correction round (REQUEST_CHANGES, 2026-10-10)

The sealed candidate (`.tmp-retention-review-seal-a1`, manifest
`23f1ee6777df26356ae9b7b796ea20fa3fb9082d06d90bb476972b79236fa803`) was left untouched.
Four findings were corrected in the same ownership slice:

1. Lifecycle originals are archived as exact bytes and mode (`lifecycle.tar`), bound in the
   receipt, rechecked at the publication boundary and verified by the reader, replay and
   admission.
2. The independent stage-zero index entry is part of every tracked inventory entry and
   staged blobs are archived (`staged.tar`); index-only drift is rejected.
3. Ignored files are retained when named, classified disposable only for dependency/cache
   directories, and otherwise refuse; credentials are never archived.
4. Admission and the publication CAS compare the complete manifest-derived lifecycle,
   including stop event and account reservation, refuse an active or malformed fresh
   lease, and reuse the producer's custody-path process inventory.

Observed in this round (all output under `.tmp-retention-worker-a3/`, `TMPDIR` set there,
foreground commands, real exit codes, no staging, commit, deployment or original-host use):

| Check | Result |
| --- | --- |
| RED, old sealed candidate copy (`old-candidate-red.log`): lease created after retention must restore debt; staged blob A to C with HEAD, worktree and `MM` status constant must change the inventory | both fail on the old candidate (admission allowed after the lease; identical digest) |
| PASS, corrected tree, same two scenarios inside the admission suite | pass (`only the staged blob changes (MM status, HEAD and worktree constant)`, `an unexpired account lease is created after retention`) |
| Domain + reader + admission + non-root operation file (macOS, `final-local.log`) | `vitest-exit=0`, 3 files, 92 tests |
| Admission suite alone (`admission.log`) | 67 passed, including log/stop-event/reservation/prompt/mode drift, holder with a new PID, ignored-file edit/newcomer, missing or corrupt `lifecycle.tar` / `staged.tar`, and raw-git staged-blob recovery |
| Strict typecheck (`npx tsc --noEmit -p tsconfig.json`, `tsc.log`) | exit 0, empty output |
| `check-boundaries`, `check-architecture-guardrails`, `check-git-diff` | OK, OK, exit 0 |

Not executed by this worker: the root/Linux operation suite (new cases: exact lifecycle
bytes and staged/worktree reconstruction from custody, ignored classification refusals,
index-only drift between preview and confirm, publication-CAS drift of stop event,
reservation and staged blob, lease/holder/missing payload after retention). No broad
regression, no repeated 665/166 runs and no further mutation campaign were run, as
instructed. The process inventory is mocked only in the macOS admission suite to control
its verdict; the real scanner runs in the operator's Linux lane.

## Path reader contract (a2 review P1 correction)

Every byte this feature reads from a path it did not create (workspace files, every
lifecycle original, the receipt and every archival payload on admission) goes through
the existing `LocalProjectControlEvidenceCustody` held-parent mechanism, not through
`lstat` + `open(O_NOFOLLOW)`, which protects only the final name. A parent symlink such
as `<jobRoot>/logs -> external` passed that old check and the external bytes were copied.

- **Held, component-safe.** Each ancestor is opened one component at a time with
  `O_NOFOLLOW|O_DIRECTORY` and held; the file is opened relative to the held parent; the
  canonical `/proc/self/fd` path must equal the lexical path. Any aliased, non-canonical
  or replaced ancestor refuses (`evidence_custody_file_noncanonical`).
- **One descriptor.** Bytes and permission bits come from the same held file descriptor
  (`ImmutableEvidenceFile.mode`, `mode & 0o777`); mode is never recovered by a separate
  path `stat`.
- **Cap during the read.** The byte limit is enforced while reading, not after.
- **Revalidated binding.** After the read the lexical file and its held parent are
  reopened and compared (device, inode, canonical parent); a parent or leaf replaced at
  the read boundary refuses (`evidence_custody_file_changed_during_read`), covered by the
  existing custody race hook.
- **Absence.** `readOptionalImmutableFile` returns undefined only after one held canonical
  parent descriptor proves it (`proveLeafAbsentUnderHeldParent`): the parent is opened
  component by component without following symlinks and kept open, the leaf is probed with
  `lstat` relative to that descriptor (never followed), and before returning the held parent
  must still equal a fresh no-follow open of the lexical parent (same device and inode,
  unchanged canonical `/proc` path) with the leaf still absent. A missing, dangling or aliased
  parent, a symlink or newly appeared leaf, and a parent substituted at that boundary all
  refuse (`evidence_custody_absence_unproven` or the open error). The earlier a4 form
  (`canonicalDirectory`, `pathKind`, `canonicalDirectory`) closed its descriptor each time, so
  a parent substituted between the separate path checks could evade it; its "held parent"
  comment was false and the code was replaced, not patched.
- **Unsupported hosts fail closed.** Custody is Linux-only; elsewhere production refuses.
- **Retained guards.** The workspace ancestry prechecks (`insideWorkspace`), the
  symlink-leaf checks, producer and admission call sites, and the lifecycle path
  derivation are unchanged; the held read is added beneath them.

Port impact: `ImmutableEvidenceFile` gains `mode`; `ProjectControlEvidenceCustodyPort`
gains `readOptionalImmutableFile`; `ImmutablePatchEvidence` omits `mode` and is unchanged
for its consumers. The local adapter is the only implementation; existing callers that
read `bytes`, `sha256`, `length` or `canonicalPath` are unaffected (typecheck-verified).
The adapter's error-code helpers moved to `project-control-evidence-custody-errors.ts` and the
absence proof lives in `project-control-evidence-custody-absence.ts` so the adapter stays under
its 1000-line architecture cap (997). This is a private Host custody
extension: no Core/Assembly handle, general SPI or consumer adoption is introduced, and
the Consumer Module Standard classification above is unchanged (adoption pending).

Observed in this round (all output under `.tmp-retention-worker-a4/`, `TMPDIR` set
there, foreground commands, real exit codes):

| Check | Result |
| --- | --- |
| RED on the sealed a2 source (`old-candidate-red.log`): lifecycle capture of a path whose parent is a symlink to an external directory | vitest-exit=1, "promise resolved ... instead of rejecting" (external bytes read) |
| macOS: admission, domain, non-root operation and custody-adapter files | `vitest-exit=0`, 4 files, 93 passed, 41 skipped |
| Strict typecheck | `tsc --noEmit` exit 0, empty output |
| `check-boundaries`, `check-architecture-guardrails` (adapter 998 lines, cap 1000), `check-managed-launch-boundary`, `check-git-diff` | OK, OK, OK, exit 0 |

**UNRUN here, Linux-only custody:** the new custody-adapter cases (mode from the held
descriptor, absence only under a certified parent, aliased/dangling/missing ancestors,
symlink leaf, ancestor replacement after the held read), the two Linux-only admission
cases (aliased receipt/backup parent; aliased job-root parent) and the root operation
case (custom lifecycle path under a symlinked parent copies no external bytes and
publishes nothing). The 41 skipped tests are exactly those lanes. On macOS the admission
suite runs against a plain-filesystem double of the custody port, which exercises the
verifier's decisions but not the alias protection. The custody-adapter and
admission cases need Linux but not root, so ordinary Linux unit CI runs them; the root
operation case runs in the qualified root CI job (`archive-root-tests`, Node 22; Node
24/26 qualification is separate). Neither has been run by this worker.
No Docker, broad regression or mutation campaign was run.

### a5 absence-boundary correction

Only `readOptionalImmutableFile` and its nearest regression changed (all output under
`.tmp-retention-worker-a5/`, `TMPDIR` there, foreground, real exit codes; no Docker, root
suite, broad regression or mutation run).

| Check | Result |
| --- | --- |
| `tsc --noEmit -p tsconfig.json` | exit 0, empty output |
| macOS: custody-adapter, admission and domain files | `vitest-exit=0`, 3 files, 91 passed, 46 skipped |
| `check-boundaries`, `check-architecture-guardrails` (adapter 997 lines), `check-managed-launch-boundary`, `check-git-diff` | OK, exit 0, OK, exit 0 |

The macOS run exposed a test defect, fixed in the same round: the events-file mode case used
`chmod 0600`, a no-op under the shell's `umask 077`; it now toggles to a mode different from the
current one.

**UNRUN (Linux-only custody; the 46 skipped tests include them):** the new custody-adapter cases
that replace the parent at the held absence boundary (by a new directory, by a symlink to an
external directory, by moving it away) or create the leaf there, each expecting
`evidence_custody_absence_unproven`, and the positive case that proves absence through the
boundary; plus all earlier Linux-only cases. They use the existing
`after_immutable_read_before_lexical_reopen` crash hook, which for an absent leaf fires only
inside the absence proof. They have not been executed by this worker and nothing here claims
they pass; ordinary Linux unit CI must run them. A replacement that restores the original
directory inode (true ABA) is indistinguishable from no change and is accepted by design.

## Finite resource policy (capacity source, base 58851cee)

Scope: `retained_nonqualified` ONLY. The ordinary policy and the accepted 30-path source semantics
and strict old routes (approved-archive/DONE, failed_no_output, retire_legacy_summary) are unchanged.
There is no public SPI, general resource manager or new module node: the Runtime Host owns resource
IO, admission and orchestration; core (`retained-nonqualified-attempt.ts`) holds only the nominal
finite schema and checks.

### Policies (strict dispatch; no unlimited value, env waiver or caller multiplier)

| Limit | `default_v1` (ordinary) | `expanded_v1` |
| --- | --- | --- |
| Entries (inventory) | 20,000 | 20,000 |
| Combined worktree + independent staged bytes | 64 MiB | 384 MiB |
| Per worktree/index file | 64 MiB | 128 MiB |
| Lifecycle bytes | 64 MiB | 64 MiB |
| Tracked patch | 32 MiB | 32 MiB |
| One payload | 128 MiB | 512 MiB |
| Complete 7-payload + receipt backup | 256 MiB | 512 MiB |
| Receipt | 8 MiB | 8 MiB |
| Git metadata buffers | 16 MiB | 16 MiB |

The permit names `resourcePolicy`; any other value (unknown, `unlimited`, empty) fails the permit
schema before any effect. The permit hash binds it. Receipts: `schemaVersion: 1` is the old shape and
is always read under `default_v1`; `schemaVersion: 2` records `resourcePolicy` and the actual
`payloadLengths` of the seven payloads. The domain validator checks every list, entry and length
against the receipt's own policy and `sum(payloadLengths) <= backupBytes - receiptBytes`. Collection,
recheck, publication, replay and admission all take their limits from the one validated policy.
Replay refuses a receipt whose policy differs from the permit (`retained_nonqualified_receipt_conflict`).

### Tracked patch

`tracked.diff` is the HEAD-to-worktree TRACKED binary-safe diff only
(`git diff --binary --no-ext-diff --no-textconv --no-renames HEAD --`, bounded `maxBuffer`;
`codex-goal-retained-nonqualified-tracked-patch.ts`). `captureGitWorkspacePatch` is not called (it
appends untracked no-index diffs) and the approved-output helper is unchanged. Untracked and selected
ignored raw bytes live only in `untracked.tar`; stage-zero index modes/OIDs and `staged.tar` preserve
MM A/B, staged adds/deletes, worktree deletes, binary, modes and symlinks. Restore qualification
requires the base objects to be available; nothing is replaced by `git add`.

### Preflight before any large allocation (under the existing workspace lock)

1. Metadata-only inventory (`measureOnly`): bounded listing, sizes and modes from held descriptors,
   full stage identities, staged blob size via `git cat-file -s`, exact padded USTAR lengths, a
   receipt-entry upper bound. Over-file / over-aggregate / over-entries refuse before any body read.
2. Lifecycle sizes (`measureRetainedLifecycle`) and tracked-patch bound.
3. `retainedBackupBudget`: each payload and the complete backup against the policy; receipt bound.
4. Actual free space on the durable target AND scratch (`statfs`) with a margin, before allocation.
5. Expanded policy only: Linux memory admission. Effective allowance = min(`MemAvailable`, remaining
   of every effective cgroup ancestor); swap is excluded; the cgroup usage already includes this
   process. The complete ancestry needs a TRUSTED HOST CONTEXT that a process cannot establish about
   itself (see "Trusted host context (a3)" below); on top of it the reader proves from bounded kernel
   metadata (`linux-memory-availability.ts`): the cgroup2 hierarchy is mounted at `<cgroupRoot>` with
   mount root `/` in `/proc/self/mountinfo` (a subtree mount hides ancestors); on v2 every level from
   the root exists and states its own `cgroup.controllers` (a level is skipped only when that file says
   memory is not enabled there, deeper levels may not re-enable it, and the root must offer memory);
   `/proc/self/cgroup`, the namespace handle, the hierarchy root and the boot are re-read after the
   limits and must be unchanged. cgroup v1 and hybrid hosts are refused (`cgroup_v1_unsupported`),
   first. Anything unknown, hidden, oversize or unparseable refuses
   (`retained_nonqualified_memory_unknown:*`).
6. Heavy producer and admission verification are serialized inside the owning process
   (`serializeRetainedHeavyWork`).

An existing `owner-intent.json` (partial reconciliation) is read capped at exactly the permit's
`intent.length`, before memory admission; a grown or tampered file is refused as
`retained_nonqualified_preparation_conflict` without being buffered at the generic payload allowance.

During collection the actual payload lengths must stay within the admitted bounds
(`retained_nonqualified_source_growth:<payload>`); nothing is truncated. The recheck compares the
full digest again, so drift between preview and confirm refuses.

**Preflight is not a reservation.** Another process can use memory or disk after the check. Only
in-process serialization is provided; cross-process races are stated, not prevented.

### Memory threshold is a HYPOTHESIS

Requirement = 8 x permitted complete backup + 256 MiB = 4.25 GiB for `expanded_v1`
(`RETAINED_MEMORY_COPY_MULTIPLIER`, `RETAINED_MEMORY_HEADROOM_BYTES`). It is conservative arithmetic,
not a measured peak. It is qualified or refuted only by the actual-size TEST below.

### Actual-size TEST runner (authored, NOT executed)

`src/worker-codex/tests/codex-goal-retained-nonqualified-actual-size.linux.test.ts`, skipped unless
Linux + `RETAINED_ACTUAL_SIZE_TEST=1` + `RETAINED_ACTUAL_SIZE_DIR` containing a
`.tmp-retention-capacity-worker-a1` component. Deterministic nonsecret corpus: a dirty inventory of
exactly 12,288 untracked entries / 263,341,675 bytes, largest 123,655,872; one extra unchanged
tracked 18-byte base file exists only for HEAD and is outside both figures. Its fixture commit uses
the identity `iliya <iliyazelenkog@gmail.com>` (effective author/committer checked with
`git var`) and a conventional subject; no hook is bypassed. It is a LIMITED runner, not the full
MCP operation. Its 25 ms in-process sampler can miss synchronous allocation peaks, so it is not
high-water evidence. It checks metadata-only refusal under the ordinary
policy, measure/collect parity, exact tar length, raw restore (size, mode, streamed sha256 of every
file) and an over-aggregate refusal, and prints `RETAINED_ACTUAL_SIZE_PEAKS` with per-phase
RSS/heap/external/arrayBuffers peaks (the cgroup-effective column stays null: no admitted memory authority
exists, so the operator records cgroup high-water and enclosing limits externally).

Not covered by this runner (stated gap): the MCP operation end to end at real size (lifecycle bytes,
the tracked-patch child process, receipt publication), same-permit partial recovery and resource
failure at real size. The operator must drive those with the operation fixture on this corpus; the
nearest portable tests cover the logic at small size.

**Operator-owned runtime gates, all UNRUN:** Linux root MCP on the exact integrated source/image for
Node 24 and Node 26 with the full 263,341,675-byte / 12,288-entry / 123,655,872-largest inventory;
preview without effects; confirm bound to the plan; seven payload lengths/hashes; receipt then ledger
last; byte-identical same-permit replay; interruption after a large payload and after receipt before
ledger; conflicting owner and changed-source refusal; clean-base reconstruction from custody alone
(every untracked/ignored byte and mode, tracked patch applied, index rebuilt from receipt modes/OIDs
and staged blobs, covering MM, staged add/delete, worktree delete, binary and executable modes);
whole-operation process and cgroup high-water (RSS, heapUsed, external, arrayBuffers, cgroup
`memory.peak`/events) through collection, Git child output, tar build, publication verification,
rechecks, replay and admission; actual preallocation refusals for each cgroup counterexample.

### Verification record (author vs operator vs unrun)

- **Author (source-only session):** instructed to use only Read/Edit/Write/Glob/Grep. Exactly one
  disclosed violation: the author ran a single Bash `echo noop` (no effect on files or state). No
  other command is claimed or known. Source-only enforcement is not attested by this document.
- **Operator, on the a1 sealed source (`.tmp-capacity-seal-a1`), as reported to the author:** full
  project strict typecheck exit 0; retained nearest-unit log of 4 suites with 69 passed / 8 skipped
  (the skips cover Linux held-inventory/preflight behaviour). That is not full-MCP or actual-size
  qualification, and it predates the a2 correction below.
- **a2 correction (this round), UNRUN by anyone:** `tsc`, `linux-memory-availability.test.ts` (rewritten
  for the topology proof), the extended operation test (owner-intent cap, policy-conflict preservation,
  index rebuild), the corrected actual-size runner, Linux-only custody cases, Node 24/26, independent
  re-review. Type errors remain possible. Rule 31 mutation checks for policy dispatch, over-file/aggregate
  refusal, memory admission, topology proof and length verification are unrun.

### a2 independent-review correction (REQUEST_CHANGES)

| Finding | Change |
| --- | --- |
| P1 owner intent read at the expanded cap | Read capped at exactly `intent.length`; test asserts every intent read used that max and that a 2 MiB-grown intent is refused with no receipt/ledger. |
| P1 cgroup completeness assumed | Mountinfo/controllers proof, skipped-level validation, membership re-read; rejecting fixtures for missing leaf/intermediate, subtree mount, unmapped mount, drift. Its namespace proof (self vs visible PID 1) and its v1/hybrid support were NOT sufficient and are superseded by a3 below. |
| P2 policy-change test expected debt | Now asserts the conflicting external permit is refused and receipt, intent, ledger and admission (still allowed) are unchanged. Admission does not follow the mutable permit. Payload tampering denial is the separate length test. |
| P2 runner identity | `iliya <iliyazelenkog@gmail.com>`, `git var` identity check, conventional subject. |
| P2 docs | Current wording corrected (tracked-only `tracked.diff`, policy-dependent caps); this record added. |
| Corpus parity | 12,288 dirty untracked entries; tracked base file documented as outside the figures. |

The review file's SHA-256 (`18e2a58a...1737e79`) could not be verified by the author (no hashing tool
in this session); the content was read in full.

## Trusted host context (a3, namespace P1)

> **STATUS (a5): SUPERSEDED.** The sibling binding + anchor pair described below, and its stand-alone issuer,
> authenticated mutual CONSISTENCY only and have been removed. The reference now lives in the installed V5 inventory
> that the installation record pins, issued only inside the supervised installation operation (see "a5 installed
> memory authority" at the end of this document; its "Remaining boundary gap" is the current blocker, replacing
> the a4 "Exact remaining blocker"). Read this section as history.

The a2 namespace check compared `/proc/self/ns/cgroup` with the visible `/proc/1/ns/cgroup`. That is not
initial-host proof: both can belong to the same private PID/cgroup namespace, and a visible mount root `/`
can be remapped. The operator's a2 strict typecheck exit 0 and 82 passed / 8 skipped does not close it (the
skips include the Linux-only cases, and no runtime gate ran). a3 replaces self-observation with an
outside-issued context. Summary of the change and its limits:

- **Authority shape.** An admitted root operator in the actual host administration context
  (`assertReadonlyHostOperator`, plus the kernel's fixed initial cgroup-namespace inode
  `INITIAL_CGROUP_NAMESPACE_INO`) issues, per boot, one immutable ANCHOR (boot id, machine id, issuer
  runtime directory, cgroup-namespace handle identity from `stat`, cgroup2 hierarchy root dev/ino and
  mapping) and a BINDING carrying the anchor's expected SHA-256, both in
  `<hosted private root>/memory-topology/` (a proposal; a4 removed the production constant), root-owned, owner-only,
  through `createReadonlyPrivateRecord` (exclusive create, fsync, refuses different bytes). Source:
  `retained-memory-topology-issuance.ts`. The expected hash comes only from the binding - never from the
  retention permit, the environment or a caller value.
- **Reader.** `readLinuxMemoryAvailability` (one private Linux Host adapter used by producer, replay and
  admission via `assertRetainedMemoryAdmission`) reads the bounded binding and anchor through the existing
  held custody reader (`statHeldImmutableFile` for owner/mode, then `readImmutableFile` with a byte cap),
  checks the hash, then the LIVE boot, machine, runtime directory, namespace handle and hierarchy root, and
  repeats the live observation after the limits are read. Missing, forged, stale, wrong-boot/runtime,
  replaced or private-namespace context is `linux_memory_unknown:*` and refuses `expanded_v1`. The anchor
  authenticates TOPOLOGY, never available memory: the live ancestors' limits and usage are still read.
- **v1 and hybrid** are refused first (`cgroup_v1_unsupported`); no proof is pretended.
- **Finite policy stays independent.** The core domain (`retained-nonqualified-attempt.ts`) is unchanged and
  names no Linux fact. No SPI, manager, per-consumer adapter or public attestation field was added.
- **Positive Docker TEST route (the only one).** Host cgroup namespace, the complete host cgroup2 hierarchy
  read-only, the anchor directory, `/etc/machine-id` and the runtime at the same path read-only, private PID
  namespace, all bound by a trusted TEST launcher (`retainedMemoryTopologyDockerArgs` returns only the
  arguments; Docker flag spelling is unverified here). A private-cgroup-namespace Docker run remains a
  NEGATIVE test. A private-PID TEST makes no host-custody claim and cannot qualify the full-host scanner.

### Capability gaps, stated rather than hidden

1. **No existing private operator binding carries this hash.** The retention tool's normal entrypoint
   (`codex_goal_project_retain_nonqualified_attempt`) receives `permitFile` and `expectedPermitSha256` as
   caller arguments. The existing private bindings (`host-installation.json`, the ordinary-installation
   packet) are closed-schema, hosted-job specific and validated twice (provider-side wire and worker-side);
   the research operator binding is excluded by direction. Extending them is the broader auth design this
   task was told not to invent. a3 therefore adds ONE fixed-name pair of private records beside them, in the
   same private root and read through the same custody primitives. Whoever can write that root can issue
   the context; inside a container that is nobody only if the launcher exposes the directory read-only.
   Whether this should instead become a field of the installed operator binding is a decision for the
   authority review.
2. **No installed entrypoint runs the issuer**, and the trusted TEST launcher that verifies the container's
   identity/birth and global cgroup membership does not exist in this source. Both are authored-not-executed
   or absent.
3. **The initial-namespace inode constant is UNVERIFIED** here (no network). `0xEFFFFFFB` is recalled from
   the kernel's `proc_ns.h`; the review must confirm it. A wrong value only makes the expanded policy refuse.
   It is what makes a root-forged self-issued anchor in a private namespace fail.
4. **Native-host trust remains the existing operator premise** (`assertReadonlyHostOperator` has the same
   self-vs-PID 1 shape). a3 narrows it to issuance; it does not turn the issuing context itself into a kernel
   proof beyond the initial-namespace inode.
5. **Default custody read path** (root-owned, owner-only) is covered only by a Linux-gated fixture that
   substitutes the current user as owner; real root ownership is runtime-gated.

### Consumer Module Standard classification (actual private Host boundary)

Read in full: the staged retained (`6b31f20f`) and current (`d6127e2d`, identical bytes at `81063add`)
`common-assembly.md`, and the owner rules. The memory-topology reader, issuer and launch-args helper are
private Host adapters inside one cohesive feature: fixed library dependencies and private helpers, static
imports and typed factories, no Core/Assembly handle, no module, descriptor, resource scope, dynamic
instance or lifecycle registration. Trust issuance and the topology anchor are Host-owned authority (the
standard assigns permissions and trusted admission to the Host). Classification: **private Host boundary,
`not-adopted`**, one consumer; **pending migration** to a consumer-owned port plus contract descriptor only
when a second real consumer needs the same host context. The upstream pin is a classification reference and
is assumed NOT to move under this work; if it does, re-classify. No adoption, consumer profile or
repository-wide conformance is claimed and no ADR bytes are touched.

### a3 verification record

Author: source-only; the earlier disclosed Bash `echo noop` stands, no other command is claimed. Operator
(a2 source): strict typecheck exit 0, 82 passed / 8 skipped - not a runtime gate, not a P1 closure. UNRUN by
anyone for a3: typecheck, the rewritten `linux-memory-availability.test.ts`, the Linux-gated custody
fixture, the issuer on a real host (needs separate technical review before ANY effect), the Docker TEST
route, the full-size MCP operation on Node 24/26 with process and cgroup high-water, partial recovery,
index reconstruction. Rule 31 mutations for the new guards (anchor hash, boot, runtime, namespace,
hierarchy, v1-first, topology recheck) are unrun.

## a4 correction (independent a3 review, REQUEST_CHANGES)

Reported by the operator, not hashed by the author: the review file SHA-256 is
`268d6b873864d5465e9cb9f32f21d436f59ccec502c6cd63f16c0e5d822d3250` and the a3 seal manifest SHA-256 is
`db9ca66b83daf58cab649686703f88fde6df7db8aaac1f119cad56839ca968fe`; the a3 seal is untouched.

| Finding | Change |
| --- | --- |
| P2 strict typecheck, `Uint8Array` returned as `Buffer` | The private read now builds a real `Buffer` from its own `Buffer` chunks; no cast. |
| P1 metadata and bytes on two descriptors | New `readHeldImmutableFileChecked` (`project-control-evidence-custody-held-stat.ts`) built on the existing held-parent primitives (`openAbsoluteFileNoSymlinks`, `assertHeldLexicalFile`, `closeHeldLexicalFile`): ONE final descriptor supplies uid, mode, size and bytes; the owner/mode check runs on it before any payload read; the byte cap holds on size and while reading; identity and metadata must be unchanged after the read; the lexical binding is revalidated before release. Nearest rejecting cases: valid same-descriptor read, insecure mode refused before the payload phase, path replaced between check and read, over-cap, symlink (Linux-gated). |
| P1 hierarchy not held together | `proveHierarchyMount` refuses unless exactly ONE cgroup2 row sits at the path with mount root `/`, NO mount nests inside it, its mount-parent chain is made of path ancestors, no other mount covers an ancestor path, and no sibling rows stack at one path (row order is never used). The row set, every level directory identity, the membership, namespace handle, root and boot are re-checked after the limits are read. Nested overmount, competing rows, ancestor overmount, drift and level replacement have rejecting fixtures. Honest limit: levels are identity-rechecked, not read through held descriptors. |
| P1 authority not installed | The production reader no longer treats the pair as authority. `readLinuxMemoryAvailability` requires an `admittedBindingSha256` that only an installed, boot-bound, immutable operator authority could supply; none exists, so it refuses `host_authority_not_installed`. `codex-goal-retained-nonqualified-resources.ts` passes none and its default reader rejects unconditionally; the fixed anchor directory constant was removed. The issuer is retained only as a clearly unqualified, DISABLED proposal (`ISSUANCE_ADMITTED = false`, throws before any effect, no production reference). |

### Exact remaining blocker

`expanded_v1` stays refused in production (`retained_nonqualified_memory_unknown:linux_memory_unknown:host_authority_not_installed`)
until a genuinely admitted installed authority exists: an immutable, boot/runtime-bound expected reference for the
memory-topology anchor in the existing installed operator authority (its closed schema, provider and worker
validation, and a qualified issuance and TEST launcher path), independently reviewed. No existing accepted route
was found; research authority must not be reused; no permit, environment or scalar may stand in. Tests that inject
a reference exercise mechanics only and qualify no authority. The unchanged limits: no memory reservation, no
held-descriptor level reads, an unverified initial-namespace constant (`INITIAL_CGROUP_NAMESPACE_INO`), unrun
Linux-only fixtures, full-size Node 24/26 MCP evidence, restore/index/recovery and cgroup high-water still required.
The default `default_v1` policy and the accepted old routes are unaffected.

CMS: unchanged guidance and pin evidence above; the topology reader and the disabled issuer remain a private Host
boundary, `not-adopted`, with adoption pending. Nothing here reinterprets placement or invents a manager.

Verification record: author source-only (the disclosed Bash `echo noop` and the earlier scanner `/tmp` write remain
disclosed, not erased). UNRUN by anyone for a4: strict typecheck, the changed rejecting cases, Linux-gated fixtures,
all runtime gates.

## a5 installed memory authority (supersedes the a3 sibling pair)

> **STATUS (a6): SUPERSEDED.** The optional `memoryTopology` key on the V5 inventory, its collector inside the
> installation supervisor, its inventory-based reader and the "hosted ordinary runtime" origin proof were REMOVED in a6:
> the V5 closed schema is restored byte for byte (a V5 record carrying `memoryTopology` is now rejected, with a test).
> The a5 analysis of the existing closure and its "Remaining boundary gap" are retained as the evidence that led to the
> a6 role; read "a6 retention operator role" at the end of this document for the current design.

Reported by the operator, not hashed or run by the author: the a4 review file SHA-256 is
`17ab2eb955495da0acc61acb20f5591525ac61cbc99dcfdd1d2821a7a2eaf3f6`; the a4 seal has 19 files; the operator's
a4 strict typecheck exit 0 and macOS run were 61 passed / 48 skipped (Linux gates pending). a4 was accepted only as a
fail-closed preparation checkpoint, NOT as installed authority. The operator also reports having confirmed
`CGROUP_NS_INIT_INO` (`0xEFFFFFFB`) against the Linux UAPI `nsfs.h`; the author did not retrieve it.

### Existing authority closure that was inspected

The actual private root is `/var/lib/subscription-runtime-host-policy`. `host-installation.json` (immutable;
`runtimeDirectory`, `runtimeSha`, `runtimeManifestSha256`, `inventorySha256`), `ordinary-origins.json` and
`host-activation.json` (boot/supervisor session, advanced only by successor-checked `publish`) are created through
`createReadonlyPrivateRecord`. `inspectedInstallation()` binds the installation to the live runtime stage and to the exact
bytes of `readonly-inventory.json`. The V5 inventory is the supervised operator's exclusive, create-only, BOOT-bound
census (`bootId`, supervisor birth, operation id, work/cleanup window, and every cgroup directory with held-descriptor
dev/ino, root path `""` included). The schema-2 launch packet binds operation/host/boot/runtime/node/bootstrap, and the
supervisor (`runOrdinaryInstallationSupervisor`) proves it is the unit's MainPID in the verified cgroup before it
collects. A reboot needs the normal re-installation/reactivation (`finishClosed` re-sessions the activation); records are
never overwritten.

### The extension (one capability, no sibling root)

- **Where the reference lives.** A new OPTIONAL key `memoryTopology` of the V5 inventory (`host-inventory.ts`), closed
  sub-schema `{schemaVersion:1, mountPoint:"/sys/fs/cgroup", cgroupNamespace:{dev,ino}, hierarchyRoot:{dev,ino}}`:
  identities and the fixed mapping only, never a memory/limit/headroom scalar. The parser binds `hierarchyRoot` to the
  census root row. The installation record already pins the inventory bytes by SHA-256, so the expected reference is
  authenticated by the existing chain; no new record name, root or file exists.
- **Version/migration semantics.** V5 stays V5. Absence means the capability is not installed, so existing inventories
  and installations stay valid and nothing is migrated; the capability appears only when a normal installation operation
  publishes an inventory carrying it. A host that cannot supply it (v1/hybrid, private or non-initial namespace, masked
  or nested mount) installs WITHOUT it and the capability stays refused. A partial publication is an inventory the
  installation does not pin, which authenticates nothing. After a reboot the old inventory is stale (boot mismatch) until
  the normal lifecycle publishes a new one; old records and history are retained, nothing is overwritten.
- **Issuance (only inside the supervised operation).** `tryCollectHostedMemoryTopology` runs in
  `runOrdinaryInstallationSupervisor` after its process/unit/cgroup proofs and feeds `collectOrdinaryInstallationDraft`. It
  proves the initial host context directly: the kernel-fixed initial cgroup-namespace inode on top of exactly one unmasked
  cgroup2 mount (no nested mount, no ancestor overmount, no competing row), unified hierarchy only, memory controller at
  the root. Never "self equals visible PID 1" and never a constant alone. `verifyOrdinaryInstallationInventory` re-collects
  and compares on every exclusive verification, so a stale root or mapping denies.
- **Read (Host composition).** `retained-memory-authority.ts` authenticates, purely and testably: the inventory bytes equal
  the installation pin; the inventory is V5 with the capability; host id, runtime directory, boot (inventory = activation =
  live) and machine id match; the operation window has not ended. The wrapper `readRetainedMemoryReference` feeds that
  function only for an authenticated hosted ordinary runtime (`readHostedOrdinaryRuntime`: retained start, birth,
  installation, live kernel session, descriptor checks, under the common fence), through the existing same-descriptor,
  root-owned, bounded private readers (`readHostedActivationBytes`). It takes no path, permit, environment value or
  scalar. The retention memory gate (`codex-goal-retained-nonqualified-resources.ts`) lazily calls it; anything else
  fails the origin proof and `expanded_v1` stays refused.
- **Live measurement (`linux-memory-availability.ts`).** With the authenticated reference: live boot, machine, namespace
  handle and hierarchy root must equal it; the namespace must be the initial one; one unmasked cgroup2 mount; every level
  from the root states its own controller availability; live limits/usage of every enforcing ancestor are read; mount rows,
  level identities, membership, namespace and root are re-read afterwards. v1/hybrid and any unknown refuse.
- **Removed.** The a3/a4 sibling anchor+binding pair, its stand-alone issuer and its `admittedBindingSha256`/`anchorDirectory`
  seams are gone. `readHeldImmutableFileChecked` (a4) is kept with its tests as the reviewed narrow same-descriptor
  primitive; the reference itself is read through the existing hosted private readers, which already do the same-FD
  owner/mode/size/bytes checks under an ancestor binding.

### Exact publication and launch sequence (nothing was executed)

1. Normal immutable runtime build and staged-artifact verification (unchanged).
2. Root issues the existing qualified-pair installation packet for a NEW operation id (unchanged contract).
3. `runQualifiedPairInstallationOperator` funds the operation and launches the supervisor unit via
   `trustedOrdinaryInstallationSupervisorLaunch` (unchanged).
4. The supervisor proves itself, then `tryCollectHostedMemoryTopology` and `collectOrdinaryInstallationDraft` build the
   inventory (now optionally with `memoryTopology`); `publishReadonlyInventory` writes it create-only; the installation and
   activation records are created/advanced through the existing store; nothing else is written.
5. A consumer running as an authenticated hosted ordinary runtime reads the reference via `readRetainedMemoryReference`
   inside the operation's work window.

### Remaining boundary gap (exact evidence; no invented mechanism)

Retention is not yet an operation that can call step 5. The admin tool `codex_goal_project_retain_nonqualified_attempt`
is a root-brokered MCP call (`codex-goal-mcp-project-control-admin-tool-registration.ts`) that is neither the
supervisor nor the ordinary creator launch. The existing closure admits exactly one creator launch kind:
`admitSourcePacket` requires `codex_goal_project_start` with a stored start plan
(`hosted-ordinary-installation-bootstrap.ts`), `parseHostedInventoryV5` requires exactly one creator whose job root and
workspace are `/jobs/<id>[/workspace]`, and `enrollOrdinary` publishes an ordinary-origin birth for that job. Running
retention as that creator would also create ordinary-origin records for the original job, which is outside this task.
**Minimal required delta (not implemented, needs its own review):** a second, closed creator launch kind for the retention
tool (packet admission, creator schema, no origin birth for the retained job) so retention runs as an authenticated
hosted ordinary runtime inside a supervised operation. Until then the default stays refused, as required.

The private-PID Docker TEST route is not completed either: a container cannot satisfy the live systemd origin proof of
the production reader, so `retainedMemoryTopologyDockerArgs` (host cgroup namespace, complete read-only hierarchy, the
three real records read-only) only prepares the bind list; a reviewed TEST composition that injects an authenticated
reference is separate work. It establishes no full-host process custody, and a trusted TEST launcher that verifies
container identity/birth does not exist in this source.

### CMS classification and profile guidance

Both documents were read in full (retained `6b31f20f`, current `d6127e2d`, identical bytes at `81063add`; byte evidence
above unchanged). The extension is a cohesive Runtime Host feature: a pure inventory field in the existing Host policy
boundary, a Host collector inside the existing supervised operation, and a Host composition function that hands retention
a closed `HostMemoryReference`. Stable resource bounds stay in core and do not depend on Linux. Concrete installation,
orchestration and kernel observation stay Host. No Core/Assembly handle, module, descriptor, resource scope or dynamic
instance is created and no SPI or manager is added: classification **private Host boundary, `not-adopted`**, one proven
consumer, adoption pending. The standard requires correct guidance now rather than after a second consumer; the guidance
is "static imports and typed factories inside the cohesive feature; a consumer-owned port plus contract descriptor only if
a second independently assembled consumer appears". No repository CMS checker exists (the standard itself says a
checker is an adopting consumer's job), so the enforcing checks are the rejecting tests below; no pin was moved.

### a5 verification record

Author: source-only (Read/Edit/Write/Glob/Grep); the disclosed Bash `echo noop` and the earlier scanner `/tmp` write
remain disclosed, not erased. UNRUN by anyone: strict typecheck, every test below, Linux-gated fixtures, the issuance
inside a real supervised operation, the Docker route, the full-size MCP operation on Node 24/26 with process and cgroup
high-water, restore/index/recovery, independent source and authority review, and the qualified runtime artifact.
Rejecting tests added or rewritten: `src/core/tests/host-inventory.test.ts` (optional topology parser: absent,
frozen, root-bound, scalar smuggling, wrong mapping/version), `src/worker-codex/tests/retained-memory-authority.test.ts`
(capability absent, substituted inventory, partial publication, forged mapping, older schema, wrong machine/runtime/boot,
foreign activation, expired window), `src/worker-local/tests/linux-memory-availability.test.ts` (no reference, ignored
sibling pair, private namespace, stale boot/machine/namespace/root/mapping, competing rows, nested overmount hiding a
tight ancestor, ancestor overmount, subtree, membership/namespace/root/mount/level drift, v1/hybrid first, a valid
reference with a live tighter ancestor), and `codex-goal-retained-nonqualified-resources.test.ts` (default caller is
not an authenticated runtime).

## a6 retention operator role (the normal path for the expanded policy)

Operator evidence for a5, preserved as reported (not rerun by the author): strict typecheck handle 19631 exit 0; the nearest
run handle 11479 exit 1 overall - four passing files, 101 passing tests, 3 skipped, and `hosted-ordinary-installation.test.ts`
with 192 failures on macOS (`hosted_readonly_host_operator_required`, `/proc` namespaces unsupported). That is NOT Linux
proof and NOT an established source regression; host identity was not weakened or mocked to make it green. The log is
`.tmp-operator-checks-a5/nearest-tests.log`. The hosted installation suite must not be repeated on macOS; it needs the
admitted Linux TEST geometry.

### Why a role, and why not the a5 shape

a5 could not reach the real retention MCP root: `admitSourcePacket` admits only `codex_goal_project_start`, V5 permits exactly
one hosted creator job root, and enrolling the original job would have created its ordinary-origin birth. a6 therefore adds
a distinct authenticated OPERATOR ROLE beside the hosted ordinary-creator flow, inside the same private Host-policy
boundary (`/var/lib/subscription-runtime-host-policy`, one new fixed subdirectory `retention-operations/`, created by the
operator like the installation operation directory). It has no job, creator, enrollment or origin: the historical job is
only the INPUT named by a private permit, and its custody/permit/CAS/lease/process checks run unchanged in the real
retention MCP entry (`projectControlRetainNonqualifiedAttempt`) inside the role's own process.

### Version and schema semantics (deliberate, narrow)

- The installation packets (schemaVersion 1/2) and the V5 inventory are UNCHANGED. a5's optional `memoryTopology` key was
  removed (it silently altered a closed schema); a V5 record carrying it is refused again, with a test.
- The retention packet is a new closed record: `schemaVersion: 3`, `role: "retention_operator"`, with its own parser
  (`src/core/host-infrastructure/host-retention-operation.ts`), directory and unit prefix
  (`subscription-runtime-retention-<id>.service`). A hosted packet cannot parse as a retention packet and a retention packet
  cannot parse as an installation packet (distinct version, role and key set), both asserted in tests.
- Packet fields: operation id; host, boot, runtime directory, runtime sha and manifest sha; node and bootstrap pins; the
  finite window (`issuedEpochMs`, `workEndEpochMs`, `cleanupEndEpochMs`, monotonic anchor; at most 1 h of work and 10 min of
  cleanup by the preparation parser); `installationSha256` (exact bytes of `host-installation.json`) and `inventorySha256`;
  `launch` discriminated as `systemd_unit` or `docker_test`; and ONE closed invocation: the tool name
  `codex_goal_project_retain_nonqualified_attempt`, controller/worker job ids, permit file, expected permit hash,
  `confirmRetention` and optional plan hash / registry root.
- The funded record (`<id>.funded.json`, schemaVersion 3) is written ONCE by the outside operator and holds the packet hash and
  the memory-topology IDENTITIES only (cgroup-namespace handle, hierarchy root, fixed mapping; never a limit, usage or
  headroom). Migration: none. Existing installations keep working and gain nothing implicitly; the capability appears only
  when an operator prepares and runs a retention operation. No compatibility shim remains.
- Records live under `retention-operations/`: `<id>.json` (packet), `<id>.funded.json`, and inside `<id>/`: `supervisor`,
  `result`, `closed`, `held` and (TEST) `container`. Reads use the existing root-owned, mode- and ancestry-checked private
  reader; every write is create-once, so a consumed name is never rewritten or silently replayed.

### Operation flow (nothing here was executed by its author)

> **a8:** steps 1-3 below describe the superseded outside-operator flow (`prepare`/`operate`, systemd unit). The current route is
> "a8 route" at the end of this document: the same role steps run inside the admitted installation supervisor.

1. `retention-operation-bootstrap.js prepare --retention-options <private path>`: the initial-root operator writes the packet
   from LIVE facts (admitted installation bytes, boot, machine, runtime, pins). The options file only describes the request;
   every authority value is observed, never copied from it.
2. `retention-operation-bootstrap.js operate --retention-operation <id>`: the same outside operator re-authenticates the
   installation chain (`assertInspectedInstallation`, packet pins, boot of the installation's activation, window), pins the
   bootstrap and node, refuses a new attempt for a permit whose earlier operation is not `closed`, OBSERVES the complete
   host memory hierarchy (`collectHostedMemoryTopology`: the kernel-fixed initial cgroup-namespace inode, exactly one
   unmasked cgroup2 mount, unified hierarchy only), writes the funded record create-once, then launches the supervised unit
   (`trustedRetentionOperationLaunch`) or the pinned TEST container, waits, and CLOSES from retained positive evidence or
   HOLDS (`held` record, non-zero exit).
3. `retention-operation-bootstrap.js --retention-operation <id>` (the supervised process): proves its identity (unit
   MainPID/cgroup/argv/exe, or the container record), re-authenticates, observes the topology again and requires it identical
   to the funded one, writes its `supervisor` record, builds the memory port and calls the real retention operation with it.
   The port exists only here: the MCP registration never passes one, so a plain tool call, a permit, the environment or any
   caller value cannot admit `expanded_v1` (it refuses `host_authority_not_installed`). The reader still re-observes boot,
   machine, namespace handle, root, mount rows, level identities and membership around the live ancestor measurements.
4. The result is a create-once `result` record (hash plus a bounded copy of the tool output); preview and refusal outcomes
   close with `ok: false`; a held operation is reconciled by the operator (the retention tool is same-permit idempotent),
   never blindly replayed.

### What changed for replay and admission (the memory gate moved to where bodies are materialized)

Only the FIRST consumption materializes payloads (tar construction, tracked patch), so only it needs the memory port.
Replay and admission verify by streaming SHA-256 through the held, component-safe descriptor (`hashHeldImmutableFile`, one
1 MiB chunk resident, same byte cap, identity and lexical rechecks) and the inventory digests files the same way when it is
not collecting. Therefore replay and admission of an expanded receipt need no memory authority and no role; the digest
parity between collecting and streaming modes is unchanged (mode, size and hash come from the same descriptor).

### TEST launcher (source only, unqualified)

`retention-operation-test-launcher.ts` binds the SAME installed-operation authentication and differs only in how the process is
born and identified. Container: HOST cgroup namespace, the complete host cgroup2 hierarchy READ-ONLY, packet and funded
READ-ONLY, only its own record directory writable, machine id and runtime READ-ONLY, no network, no capabilities, PRIVATE PID
namespace (so it is NOT full-host process custody and cannot qualify the full-host scanner). Disposable fixtures only: the
fixture root must be a TEST/.tmp area, every other mount must be a fixture path, and the permit and every path inside it must
lie under the fixture root, so no original job path can be mounted or retained through it. Identity: the image is pinned by id
and the mounts by (source, target, mode), compared with `docker inspect`; after start the operator records container id, host
pid, host cgroup and kernel start ticks, and the in-container supervisor accepts the record only if its own view agrees (pid 1,
cgroup, start ticks, mountinfo read-only flags). Partial or uncertain effects stay on disk: the funded record is create-once,
the container is never removed or re-created by this code, and no new attempt for the same permit starts until the previous
one is `closed`. The `docker create/inspect/start/wait` command and `docker inspect` field spelling are UNVERIFIED against
current Docker documentation (no network in the authoring session). No environment value or JSON argument can turn a TEST run
into production authority: the launch kind comes from the funded, hash-pinned packet.

### Files

Core: `src/core/host-infrastructure/host-retention-operation.ts`. Host: `retention-operation-bootstrap.ts`,
`retention-operation-host.ts`, `retention-operation-records.ts`, `retention-operation-test-launcher.ts`,
`retained-memory-authority.ts` (pure authentication), `retained-memory-topology-issuance.ts` (live observation only),
`hosted-ordinary-installation-bootstrap.ts` (a8: funded schemaVersion 3 discriminator), `hosted-installation-activation.ts` (one `export`
on `assertInspectedInstallation`; the file stays at 999 lines). Retention: `codex-goal-mcp-project-control-retained-nonqualified.ts`
(optional port, streaming backup verification), `codex-goal-retained-nonqualified-resources.ts` (no ambient authority),
`codex-goal-retained-nonqualified-inventory.ts` (streaming digests), `codex-goal-project-retained-nonqualified-admission.ts`
(no memory gate), `project-control-evidence-custody-held-stat.ts` (`hashHeldImmutableFile`).

### Rejecting tests (all UNRUN)

`host-retention-operation.test.ts` (hosted packets in the retention role, altered discriminator/window/tool/launch, creator or
job smuggling, funded and preparation bounds, V5 refuses retention shapes), `retained-memory-authority.test.ts` (wrong
installation hash/inventory/runtime/boot/machine, window and clock, funded record for another packet, substituted digest,
self-observed or private-namespace topology, replaced root, forged funded topology, closed invocation without origin),
`retention-operation-test-launcher.test.ts` (writable or missing hierarchy, writable records, original-job mounts, non-TEST
fixture root, permit outside the fixture root, exact container pins, in-container cgroup/birth/mount mismatch),
`linux-memory-availability.test.ts` (unchanged mechanics: stale boot/machine/namespace/root, nested overmount hiding a tight
ancestor, drift, v1/hybrid first), `codex-goal-mcp-project-retained-nonqualified.test.ts` (real operation with the expanded
policy: no port refuses, a tight allowance refuses before effects, an adequate one previews and retains a v2 receipt, then
admission and same-permit replay need no memory authority), `host-inventory.test.ts` (V5 stays closed). The hosted installation
suite is Linux-only and was not touched.

### Operator commands (do not run the hosted installation suite on macOS)

- Strict typecheck: `tsc7 --noEmit`, or the project typecheck (the files above are inside the existing `tsconfig`).
- Portable cases: `vitest run src/core/tests/host-retention-operation.test.ts src/core/tests/host-inventory.test.ts
  src/worker-codex/tests/retained-memory-authority.test.ts src/worker-codex/tests/retention-operation-test-launcher.test.ts
  src/worker-local/tests/linux-memory-availability.test.ts src/worker-codex/tests/codex-goal-retained-nonqualified-resources.test.ts`.
- Linux root (admitted geometry, Node 24 and 26): the four affected files
  `codex-goal-mcp-project-retained-nonqualified.test.ts`, `codex-goal-project-retained-nonqualified-admission.test.ts`,
  `project-control-evidence-custody-held-read.test.ts`, `linux-memory-availability.test.ts`, then the role cases above.

### Normal TEST launch packet preparation sequence (for the operator, after independent review of the exact packet and launcher)

1. Build and stage the exact runtime artifact; confirm the installation is admitted and re-sessioned in the current boot.
2. Build the disposable TEST fixture (operator, permit, registry, evidence/ledger roots, a stopped TEST job) under a
   `.tmp-*` / `TEST-*` root; root-own the permit 0600 and record its SHA-256.
3. Pin the container image by id; write the private options file; run `prepare`; inspect the packet.
4. Run `operate`; read `closed`/`held`, the `result` record and the container state; reconcile before any new attempt.

### CMS classification and profile guidance (current, pending)

Both documents were read in full (retained `6b31f20f`; current `d6127e2d`, identical bytes at `81063add`; the evidence in
"Compare retained 6b31 with current d6127e2d" above is unchanged). The role is a cohesive Runtime Host feature: a pure wire
contract in the existing Host-infrastructure folder, Host adapters for installation, launch and observation, and a narrow
port that the retention feature accepts as a plain function type. Stable finite policy stays in core and names no Linux
fact. No Core/Assembly handle, module, descriptor, resource scope or dynamic instance is created; no SPI, manager or
service bag exists. Classification: **private Host boundary, `not-adopted`; adoption pending**; the correct guidance now is
static imports and typed factories inside the feature, and a consumer-owned port plus contract descriptor only if a second
independently assembled consumer needs the same context. No repository CMS checker exists (the standard leaves that to an
adopting consumer), so the enforced checks are the rejecting tests above plus the existing architecture guardrails (the
activation file remains under its 1000-line cap).

> **a7 note:** the a6 text above is corrected by "a7 correction (independent a7 review)" below: the outside operator is admitted
> by the existing kernel operator session, the TEST container is bounded by the finite window with owned cleanup, its executable
> is the pinned host file mounted read-only and re-hashed inside, and staged bodies are fetched only when collecting.

### Remaining qualification gates (none claimed)

Independent review of the role, schema, publication and launcher sequence; exact-source Linux 24/26 runs of the four
affected files and the new role cases; the first real supervised operation on an admitted installation (unit route) and the
TEST container route on admitted geometry; the full-size MCP operation (263,341,675 bytes, 12,288 entries, 123,655,872
largest) with preview, confirm, receipt, ledger ordering, replay, admission, interruption/recovery and complete
tracked/index/untracked/ignored reconstruction; measured RSS/external/heap and cgroup high-water through every phase (the
8 x backup + 256 MiB threshold remains a hypothesis); all-task process custody and full-host eligibility; and the qualified
runtime artifact. The author is source-only; the disclosed Bash `echo noop` and the earlier scanner `/tmp` write remain
disclosed, not erased.

## a7 correction (independent a7 review, REQUEST_CHANGES)

The a7 review (manifest `565d62d5...`, 31 files, reported by Root; a6 manifest `41346df7...`) accepted only the `--pid` assertion
correction and sealed four P1 blockers. The corrections below are SOURCE ONLY and UNRUN. They supersede the corresponding a6 text.

| P1 | Closure |
| --- | --- |
| Outside operator never admitted by the existing kernel | `prepareRetentionOperationPacket` and `runRetentionOperationOperator` call `HostedReadonlyHostKernel.operatorSession()` FIRST (before any read for publication, directory, packet, topology observation, funded record or launch) and bind the returned session to the stored activation with the same comparison every normal installation operation makes (`assertActivationSession`) and to the packet's boot and machine (`assertRetentionOperatorAdmission`). The funded record now carries that admitted session; the operator re-admits and compares immediately before the first effect; the supervised child continues only if the stored activation still equals the recorded session (`assertRetentionFundedSession`) and does not masquerade as the supervisor. Structural root/namespace checks remain but are no longer treated as admission. |
| Docker wait timeout leaves the container active | `runOwnedDockerTestLifecycle` replaces the blocking `docker wait`. Every command's timeout is capped by the packet's remaining work (or cleanup) budget, the container is polled by id, and on deadline, error or partial failure ONLY the exact owned container is stopped (fresh id + pinned image + operation label proof, and the recorded kernel start ticks before any signal), escalating `stop` to `kill` inside the cleanup budget and requiring a fresh not-running inspect. It then fails HELD (`container_stopped_after_failure`), or `cleanup_unproved` if the stop cannot be proved; the container and records stay as evidence, nothing is removed, re-created, replayed or addressed by name, and a create that returned no id is `create_uncertain` with no signal. Close additionally requires the container's cgroup to be empty. |
| Docker branch has no executable pin | The pinned host node file is a REQUIRED read-only bind mount over the entrypoint path (so the image cannot substitute bytes there); the operator pins it for both launch kinds before funding; the in-container supervisor checks `/proc/self/exe`, `process.execPath`, the hash of the file it actually runs and of the loaded bootstrap against the packet BEFORE building the memory port or calling MCP. The image must provide compatible shared libraries (a qualification caveat). The systemd pin path is unchanged. |
| Staged bodies bypass the streaming contract | The inventory fetches a staged blob body ONLY when `collect === true` (after preflight). Measuring, admission and the producer recheck bind the independent index identity (stage-zero mode and object id, whose id is the content hash) plus the size admitted from `git cat-file -s`, and never request the body. Digest and measurements are identical between modes. |

Admission-session capability gap (exact source evidence, not papered over). The existing admission has a narrow shape: `operatorSession()`
(`hosted-readonly-host-kernel.ts:137-142`) requires the caller to be in the admitted supervisor's cgroup and, for a V5 inventory, to
BE the supervisor process (`collectProcessBirth(pid) === inventory.supervisor.birth`); `session()` (`:58-79`) additionally requires the
supervisor unit's live MainPID birth to equal the inventory; the census asserts the supervisor group contains only that process
(`hosted-ordinary-installation-census.ts:101-104`). Therefore, on a V5 installation, no SEPARATE outside operator process can be
admitted, and after the installation operation ends no session exists at all; prepare/operate then refuse (fail closed, nothing
published). The reviewer-required reuse is implemented exactly; whether the role can run depends on the installation shape. Minimal
required delta (not implemented, needs its own review): a retention creator discriminator inside the installation operation, so that
the admitted supervisor process itself performs the prepare/fund steps (V6 creator rows and a funded-packet branch in
`runOrdinaryInstallationSupervisor`), or a dedicated kernel admission for a second supervised operator unit. Until one exists, the
expanded policy cannot be consumed on a V5 host, which is the truthful state.

Tests (all UNRUN): `retention-operation-host.admission.test.ts` (doubles used only to observe ORDER: refused admission, stale
supervisor, lookalike installation and wrong installation leave no packet, directory, topology collection, funded record or launch;
the admitted composition publishes the packet only after admission, and funds before a launch whose failure is HELD),
`retained-memory-authority.test.ts` (admission and funded-session comparisons), `host-retention-operation.test.ts` (funded session
schema), `retention-operation-test-launcher.test.ts` (pinned-executable mount and bytes, label ownership, bounded lifecycle: normal end,
stalled work, stop then kill, unprovable stop, changed birth, foreign label, slow setup, partial start, CLI failure),
`codex-goal-retained-nonqualified-capacity-inventory.test.ts` (a 24 MiB staged-only MM case: no `cat-file blob` in verification or
measuring mode, one in collecting mode with the authentic bytes and identical digest, a restaged index changes the digest).
Operator commands: `tsc7 --noEmit`; then `vitest run src/worker-codex/tests/retention-operation-host.admission.test.ts
src/worker-codex/tests/retention-operation-test-launcher.test.ts src/worker-codex/tests/retained-memory-authority.test.ts
src/core/tests/host-retention-operation.test.ts`, and on Linux `src/worker-codex/tests/codex-goal-retained-nonqualified-capacity-inventory.test.ts`.
Not claimed: any Linux, installed-role, real Docker, real MCP or full-size qualification; the private-PID TEST is source-only and
establishes no full-host custody.

## a8 route (Root-selected): the retention role runs INSIDE the admitted installation supervisor

This section SUPERSEDES the a6/a7 outside-operator flow (`prepare`/`operate`, `trustedRetentionOperationLaunch`, the
`systemd_unit` launch kind, `prepareRetentionOperationPacket`, `runRetentionOperationOperator`, `hostedRetentionUnit*`); those
are removed, not kept as a parallel variant. Source only, UNRUN.

### Exact source reason the external V5 caller is refused (guard preserved, unchanged)

`HostedReadonlyHostKernel.operatorSession()` (`hosted-readonly-host-kernel.ts:137-142`) requires `collectSelfCgroup()` to equal the
inventory supervisor unit's control group AND, for V5, `collectProcessBirth(process.pid) === inventory.supervisor.birth`, before it
calls `session()` (`:58-79`, live supervisor MainPID birth, census: the supervisor group holds only that process). The V5
inventory is create-once and names the birth of the installation supervisor process, so any other process (an outside root
operator, a retention unit, a container) can never equal it. Nothing in this change touches, relaxes or bypasses that check, and no
caller is relabeled as the supervisor.

### The route

The retention role is a closed DISCRIMINATOR of the existing installation operation, not a second actor:

1. `QualifiedPairInstallationRequest` schemaVersion `2` = schemaVersion `1` + exactly one closed `retention` request
   (`launch` = `installation_supervisor` | `docker_test`, and the one retention invocation). The funded installation packet is
   schemaVersion `3` = schemaVersion `2` + `retention`; both are parsed closed (`parseHostedRetentionRequest`), pinned by the
   existing operation record hash and `launcher-consumed.json`, and funded by the unchanged `runQualifiedPairInstallationOperator`.
   schemaVersion 1/2 and the V5 inventory are unchanged. The consumers that pinned the funded `schemaVersion === 2`
   (`hosted-ordinary-installation-owned.ts`, `-launcher.ts`, `-qualification-guest.ts`, `trusted-custody-systemd-launch.ts`) accept 2 or 3 and
   nothing else. There is NO caller window: the finite window is the installation operation's own work/cleanup window.
2. The existing installation supervisor unit starts and runs ALL its existing proofs unchanged (unit MainPID/cgroup/argv/exe,
   socket stdio, packet and pair admission, profile/bus verification), publishes the V5 inventory and calls `store.install()`.
3. With schemaVersion 3, `runOrdinaryInstallationSupervisor` does NOT call `enrollOrdinary`, `resumeOrdinary`, the hosted creator
   launch, `assertOrdinaryInstallationOriginalClose` or `finishClosed`: no origin birth, no job start, activation stays Closed.
   It calls `runAdmittedRetentionOperation` (`retention-operation-host.ts`).
4. `runAdmittedRetentionOperation`: (a) existing `operatorSession()` FIRST (the supervisor passes it by being the inventory
   supervisor); (b) read the actual installation/activation (`assertInspectedInstallation`) and bind packet fields from the funded
   window plus the installation bytes and inventory the same process just published: runtime directory/sha/manifest, boot, machine,
   node pin, `assertActivationSession`, packet boot/machine, finite window; (c) pins and node path; (d) refuse while another operation
   for the permit is not `closed`; (e) observe the memory topology; (f) publish packet and funded records create-once (the funded
   record carries the admitted session); (g) re-admit and compare the session, then run: `installation_supervisor` runs the real
   `projectControlRetainNonqualifiedAttempt` in this process with the port built from `retentionMemoryReference` (live topology
   must equal the funded one) and then closes from retained positive evidence; `docker_test` runs the owned container lifecycle
   (same packet/funded, pinned Node, finite window, exact-owned cleanup). Any later failure writes `held`; nothing is repaired.
5. The supervisor writes the existing `<id>.closed.json` terminal (`sourceExitCode` 0 only for a closed, successful retention). A
   non-successful retention exits non-zero and the issuer's existing closure refuses (HELD), exactly like a failed creator.
6. Inside the TEST container only, `retention-operation-bootstrap.js --retention-operation <id>` (single argv shape, requires a
   `docker_test` packet) re-authenticates against the supervisor-written records, proves container identity and the pinned
   executable, re-observes the topology, and calls the same retention entry.

The retention role cannot start a job: the only workload reachable is the one closed tool (`hostedRetentionTool`; any other tool
or extra key fails the parser), the creator row of the inventory stays a pinned identity that is never launched, and no origin or
enrollment record is created for the historical job, which remains an INPUT named by the private permit. Existing quiet, lease,
process-holder, global admission checks and immutable backup/uncertainty semantics are untouched (they run in the retention entry).

### Remaining qualification gates and exact limits of this route (disclosed)

- (superseded by "a9 corrections" below) The V5 inventory is create-only, so the a8 route alone is a FRESH installation-class
  operation. An already-installed host enters the role through the installation SUCCESSOR added in a9; a fresh own TEST
  installation remains a separate thing and does not prove eligibility of an installed host.
- The creator row required by the closed V5 schema is the pinned installation identity of the operation; it is never launched by this
  branch. Whether a reviewer wants a dedicated V6 creator-less shape instead is a design question left open.
- `docker_test`: launching the docker CLI from the supervisor places a transient child in the supervisor cgroup, which the census
  forbids while the kernel session is being re-checked; the TEST route admits once before and relies on its own owned lifecycle.
  Source only; Docker flag/inspect spellings remain unverified.
- Unrun: strict typecheck, the portable and Linux cases, the first real supervised operation, `retainOriginalOrdinaryInstallationClosed`
  with a retention terminal (reviewed by reading: phase CLOSED, `supervisorId` = original birth, terminal generation, empty starts),
  full-size MCP, index recovery, RSS/cgroup high-water, full-host scanner/all-task custody, qualified artifact.

### a8 tests (UNRUN)

`host-retention-operation.test.ts` (request parser closed: no window/host/boot/operation/hash/creator keys, removed `systemd_unit`
kind refused), `retention-operation-host.admission.test.ts` (rewritten for the in-supervisor composition: an unadmitted external
caller whose kernel admission throws, stale activation, lookalike installation, wrong boot/machine/runtime/sha/window and node pin
refuse before any directory, record, topology collection, retention call or spawn; the admitted role records packet, funded,
supervisor, result, closed in that order, reaches the retention entry with only the closed invocation and a port, creates no
origin/creator, retains a non-successful retention or a thrown tool as a closed NOT-ok operation, and holds a changed session, a
stale topology or a failed publication), `retained-memory-authority.test.ts` and `retention-operation-test-launcher.test.ts`
(launch kind updated). The positive tests use recording doubles for the kernel and I/O only to observe mechanism; they create no
authority and mock no namespace identity.

### a8 commands (not run)

- Strict: `tsc7 --noEmit` (or the project typecheck).
- Changed-risk: `vitest run src/core/tests/host-retention-operation.test.ts src/core/tests/host-inventory.test.ts
  src/worker-codex/tests/retention-operation-host.admission.test.ts src/worker-codex/tests/retained-memory-authority.test.ts
  src/worker-codex/tests/retention-operation-test-launcher.test.ts`; Linux root: the hosted-ordinary-installation suites (funded
  schemaVersion 3 consumers) and the four affected retention files.
- Typed invocation (data, not a command): a qualified-pair request `{ schemaVersion: 2, packet, candidate, preparedFixture,
  copiedCohort, preparedCollectorProfile, priorCollectorProfile, retention: { launch: { kind: "installation_supervisor" },
  retention: { tool: "codex_goal_project_retain_nonqualified_attempt", controllerJobId, workerJobId, permitFile,
  expectedPermitSha256, confirmRetention } } }` placed where the existing request is read
  (`ordinary-installations/<id>.request.json`), then `hosted-ordinary-installation-bootstrap.js install --qualified-pair <id>`.
  TEST: the same with `launch: { kind: "docker_test", image: "sha256:<id>", fixtureRoot: "/…/TEST-…", mounts: […] }`.

### CMS / Host classification (a8)

Unchanged: private Host boundary, `not-adopted`, adoption pending. The change is within Runtime Host (unit/process/orchestration
authority stays in the installation supervisor; the stable finite policy stays core). Pin delta versus the a6/a7 text: the
retention bootstrap is container-only, `trustedRetentionOperationLaunch` and the `systemd_unit` kind no longer exist, and the funded
installation packet gained schemaVersion 3. No scanner/policy/Native owner path was touched.

## a9 corrections (independent a9 review, REQUEST_CHANGES; Root FINAL SOURCE ADMISSION)

Source only, UNRUN. The reviewer accepted the new-installation dispatch (retention reaches the actual admitted supervisor without any
old-job origin), the kernel guard, the Node pin, the staged-metadata path and the same-FD/memory checks; those are preserved. Three
blockers are corrected. Operator receipts for a9 (pinned compiler exit 0; five-suite focused run 123 PASS) are Root's observations and
are not repeated or claimed here. TS7 stays unsupported by the existing `baseUrl` configuration; no configuration was changed.

### 1. Post-IO finite deadlines (`retention-operation-test-launcher.ts`)

Every effect is now bounded on both sides by `boundedDocker`: the remaining time caps a command's timeout BEFORE it runs, and the
deadline is checked again AFTER it returns, because a command that started inside the window and returned late cannot prove when it
completed. The same check precedes the identity-record publication, the work-loop success and every stopped/empty cleanup proof, and
`runAdmittedRetentionOperation` re-checks the work window immediately before the terminal receipt on BOTH routes. Defined boundary:
an observation that returns with less than 1 ms left, or exactly at the deadline, is LATE. Late work routes to the exact-owned bounded
cleanup and fails HELD (`container_stopped_after_failure:...deadline_after:...`); a late cleanup observation is `cleanup_unproved`. A CLI
timeout is still never treated as container death, there are no abandoned callbacks, and EOF/exit facts are kept as evidence without
being promoted to in-window success.

### 2. Finite cleanup owner that survives the supervisor (`cleanupOwnedDockerTestContainer`, `cleanupOwnedRetentionContainer`)

The Docker container lies outside the installation supervisor's control group, and the existing outside issuer stops that group at
work end (and `RuntimeMax` reinforces it), so a supervisor-local cleanup cannot be the only owner. Reused mechanism: the EXISTING
outside installation issuer (`runFundedInstallationSupervisor`), which already owns the operation, its unit and its absolute cleanup
window and outlives the supervisor. No new manager, no daemon, no broader signal authority:

- The admitted supervisor announces custody BEFORE each step as create-once records beside the operation: `intent` before
  `docker create`, `created` (the exact id returned by create) before `docker start`, then the existing `container` record (host pid,
  cgroup, kernel start ticks). It remains the only actor that creates, funds and starts. If `created` cannot be recorded the
  container is never started.
- After the supervisor unit has ended for ANY reason (clean exit, killed at work end, RuntimeMax, lost), the issuer calls
  `cleanupOwnedRetentionContainer` within `cleanupEnd`: no `intent` means no container can exist (nothing is called); `intent`
  without `created` is an UNCERTAIN creation (nothing started, nothing signalled, no lookup by name, no retry; outcome
  `create_uncertain`); `created` names the exact container, stopped only after a fresh id + pinned image + operation-label proof (and
  the recorded birth when the supervisor got that far), `stop` then `kill`, and a stopped observation that returns inside the cleanup
  window. The create-once `cleanup` record carries `no_container | already_stopped | stopped` (closing) or
  `create_uncertain | cleanup_unproved` (HELD, container and every record left as evidence).
- The issuer's closure requires the closing outcome; otherwise it throws held. The outside actor holds no retention authority: it
  cannot fund, start, run the retention tool or impersonate a supervisor, and its only effect is stopping the exact owned container.
- **Superseded in part by a10 section 1:** the issuer now proves the ORIGINAL unit terminal BEFORE reading any ownership, and only
  a closing outcome is retained as the `cleanup` receipt (the HELD outcomes are returned and retained as `cleanup-held.json`).

### 3. Installation successor for an already-installed V5 host

Why the a8 route alone cannot serve an installed host (a9 report, verified at the cited lines): the cold admission required the
prior inventory's operation id to equal the requested one (an already consumed operation); the fixed inventory is create-once;
the immutable installation embeds that inventory's digest; and `finishClosed`/`operatorSession` cannot admit a new process against the
dead predecessor's birth. The successor uses the EXISTING qualified-pair installation owner, its original-operation proofs and the
activation fence; there is no framework.

**Versions (closed).** Request schemaVersion 3 = 2 (retention) + `successor` (the committed predecessor pins: installation id,
installation/inventory/activation SHA-256, activation generation). Funded installation packet schemaVersion 4 = 3 + `successor`.
A successor is only authorized together with the retention request. The consumers of the funded version accept exactly
`hostedFundedInstallationVersions` (2, 3, 4). The V5 inventory schema is unchanged. The activation gains the OPTIONAL key
`installationSelectionSha256` (emitted only when selecting, so every existing activation keeps its exact bytes; both closed parsers
accept it, and the successor guard permits it to change only CLOSED to CLOSED with every start terminal, a new supervisor session, an
untouched origin catalog, and never to disappear).

**Records (create-once, content-addressed, nothing rewritten or removed).** Under `installation-successors/`:
`<sel>/readonly-inventory.json`, `<sel>/host-installation.json` (same installation id/host, new runtime pins, the new inventory
digest) and LAST `<sel>.json`, the closed selection record named by its own SHA-256 `<sel>` (generation, operation, boot, supervisor
birth, the predecessor's installation/inventory/activation digests and generation, the predecessor selection link, and the two new
digests). The predecessor `host-installation.json`, `readonly-inventory.json` and activation history stay intact.

**Readers.** `readHostedActivationBytes("host-installation.json" | "readonly-inventory.json")` is the ONE resolver
(`resolveSelectedInstallationRecord`): without the activation key it returns the fixed records; with it, only the record whose digest
the activation names (verified), and each copy must match the digest that record carries; there is no newest-file rule and no caller
selector, and a mismatch refuses instead of falling back. The kernel's inventory reader, `inspectedInstallation`, the foreground and
manifest-placement readers, the current-dependency-origin `fixed()` and the retained tool files all resolve through it.

**Transition (inside the new supervisor, `hosted-installation-successor.ts`).**
1. Admit the fresh supervisor against its OWN candidate census (`new HostedReadonlyHostKernel(candidate).operatorSession()`: live
   cgroup membership, unit MainPID and birth) and require the outside issuer's independent record of it (`original-supervisor.json`:
   operation, unit, boot, birth, invocation, cgroup, written after the issuer's own physical bind) to agree. Self-authored candidate
   bytes are not admission, and the old birth is never relabeled (`assertHostedInventorySuccessorCongruent` refuses the same unit,
   birth or operation id).
2. Under the activation fence re-read the COMMITTED predecessor and require the funded pins, a CLOSED activation, every start
   terminal, the same boot and host, no pending publication (the normal reader refuses it), the staged runtime pins, and a candidate
   census congruent to the predecessor except for the supervisor (no restarted or extra unit, no process in a kept node, creator
   identity and child slot unchanged, no active ordinary/hosted unit). A reboot never qualifies.
3. (a12, F2) Under the SAME fence and before anything is staged, run the candidate's complete exclusive census
   (`new HostedReadonlyHostKernel(candidate, request).verifyExclusiveInventory(fence)`); the committed activation is authenticated again
   as the pinned PREDECESSOR view and the candidate is a separately named new generation (section "2. F2" below).
4. Stage the records create-once; 5. publish ONE activation successor selecting `<sel>`. `publish` runs
   `assertInstallationSelectionTransition` for every publication, so the first publication and the recovery of a retained
   `host-activation.next` pass through the same revalidation (chain, predecessor pins, session, staged files, congruence); 6. re-read
   through the normal readers, re-inspect the installation against the stage and run the normal `verifyExclusiveInventory` against
   the NEW selected world; only then does `runAdmittedRetentionOperation` run.

**Partial publication, recovery, rollback (explicit).** Failure before step 5 (including a refused candidate census in step 3) leaves
inert staged files that no reader selects, or none at all; the operation id is consumed once records exist, so a new funded operation
(new selection digest) is required and nothing is retried or overwritten. A crash inside step 5 leaves the retained
`host-activation.next`, finished only by the existing `recoverSerialized` after the same revalidation (it never constructs a fresh
attempt). Failure in step 6 leaves the selection committed and CLOSED; there is no automatic rollback (the predecessor supervisor is
dead and cannot be re-admitted), a later reviewed successor operation supersedes it and the predecessor data stays for forensics. The
origins, enrollment and installation identity are preserved byte for byte; the original jobs are neither started nor re-enrolled.

### Tests added or changed (UNRUN by the author)

`host-installation-successor.test.ts` (core, with the shared real-parser fixture `host-successor-fixture.ts`): closed request and
selection records, congruence refusals (relabeled unit, reused birth/operation, other boot/host, restarted/changed/extra/missing unit,
process in a kept node, new activator, changed creator or child slot). `hosted-installation-successor.test.ts` (Host): candidate
admission first, staging order with the selection last, one publish, new-world verification, predecessor files byte-identical,
origins/enrollment/starts preserved, outside-record mismatch (operation, unit, birth, invocation, cgroup, boot), stale pins, active
start, non-CLOSED, reboot, pending publication, non-congruent census, wrong staged runtime, a crash before publication with no
selection and no overwrite, and the transition revalidation (stale predecessor pin, wrong session/boot, missing record, changed
staged bytes, chain, removal, no-session-change, active starts) with the REAL resolver and activation guard over an in-memory map.
`retention-operation-test-launcher.test.ts`: late final inspect, exact-boundary behaviour (late at the deadline, accepted 1 ms
before), late cleanup observation, custody announced before each step, no start when the id cannot be bound, and the outside owner
(exact stop of the bound container, already stopped, no custody, uncertain creation, foreign label, changed birth, unproved stop, late
proof, wrong packet kind). The positive Host tests use doubles for the kernel and I/O only to observe mechanism; they create no
authority and mock no namespace identity.

### Operator commands (not run)

- Strict: `tsc7 --noEmit` stays unsupported by the existing `baseUrl`; use the pinned compiler the operator already used.
- Changed-risk (portable): `vitest run src/core/tests/host-installation-successor.test.ts src/core/tests/host-retention-operation.test.ts
  src/worker-codex/tests/hosted-installation-successor.test.ts src/worker-codex/tests/retention-operation-test-launcher.test.ts
  src/worker-codex/tests/retention-operation-host.admission.test.ts`. Linux root: the hosted-ordinary-installation, hosted
  activation and kernel suites (funded versions 2/3/4, selection resolver, the kernel `inventory()` change), then the four retention files.
- Typed normal successor request (data): a qualified-pair request `{ schemaVersion: 3, packet, candidate, preparedFixture,
  copiedCohort, preparedCollectorProfile, priorCollectorProfile, retention: { launch, retention }, successor: { installationId,
  installationSha256, inventorySha256, activationSha256, activationGeneration } }` where the four digests/generation are read from
  the CURRENT committed records (`host-installation.json`, `readonly-inventory.json`, `host-activation.json` as the selected readers
  return them), and a NEW operation id (never the predecessor's). Placed at `ordinary-installations/<new id>.request.json`, then
  `hosted-ordinary-installation-bootstrap.js install --qualified-pair <new id>`. The outside-cleanup TEST variant uses
  `launch: { kind: "docker_test", ... }` with the same request.

### Required gates before any effect (none claimed)

Independent review of this source; the staged runtime artifact and its stage record; the pair qualification and collector profile for
the new artifact; the physical custody check on the real host (no active ordinary/hosted unit, all starts terminal, same boot) by
the operator immediately before funding; Linux 24/26 runs of the hosted installation, activation, kernel and the retention files; a
real owned-container death/deadline/cleanup proof (supervisor lost at work end; the outside owner stops only that container before
cleanup end, and the stopped container, cgroup and all partial evidence remain); the full 263,341,675 B / 12,288-entry MCP
operation with preview/confirm/receipt/ledger/replay/admission/interruption/recovery/restore; RSS and cgroup high-water; all-task
process custody (the observed 4,462-FD process is not proven unrelated). A successful fresh own TEST installation does NOT prove
original-host eligibility; the original thirteen jobs must be shown neither started nor re-enrolled on the real successor.

### CMS / Host classification (a9)

Unchanged: private Host boundary, `not-adopted`, adoption pending; the retained `6b31f20f` and current `d6127e2d` guidance
(identical bytes at `81063add`) were not re-derived. The successor is Runtime Host lifecycle (installation, activation fence, process
and unit ownership, storage, recovery); only the closed wire contract and the congruence rule are pure core. Pin delta versus a8: the
funded installation version set (2, 3, 4), the optional activation key, the selected-record resolver, the kernel `candidate` view, the
TEST container custody records and the outside cleanup owner. No Core/Assembly handle, module, descriptor, SPI, manager or service bag
is created. There is still no repository CMS checker; the enforcing checks are the rejecting tests above plus the architecture
guardrails (`hosted-installation-activation.ts` stays at the 1000-line cap).

## a10 corrections (independent a10 review, REQUEST_CHANGES; this delivery is SOURCE ONLY and UNRUN)

Nothing below was executed (no compiler, no test, no Docker, no systemd, no hash). The author's tools were Read/Edit/Write/Glob/Grep
only, so no SHA-256 is claimed here; byte identity is Root's. Base `58851cee2d1abfaca91b0c3f39dec316f06a77d3`. No installed record,
original job, registry, pointer or hosted process was touched. The previous session/operator admission, same-FD custody, complete
hierarchy refusal, Node pin, bounded staged-metadata verification, strict legacy routes and the capacity preflight are untouched.

### Status of every requirement

| ID | Status | Where |
|---|---|---|
| F1 outside cleanup needs terminal custody of the ORIGINAL unit first | **implemented** (source) | `retention-operation-host.ts` `originalUnitPending`, `proveOriginalUnitTerminal`, `cleanupOwnedRetentionContainer(operationId, gate)`; `retention-operation-test-launcher.ts` `OutsideCleanupGate`, `cleanupOwnedDockerTestContainer`; `hosted-ordinary-installation-bootstrap.ts` `observeOriginalUnit`, `outsideCleanupGate`, `runOutsideCleanup` |
| F2 candidate exclusive inventory before the irreversible publication | **implemented in source (a12 follow-up), UNRUN and not independently accepted** | explicit predecessor/candidate generation semantics: core `admittingSupervisorGeneration`, new `hosted-ordinary-installation-history.ts`, `hosted-ordinary-installation-census.ts` `reservedGroups`, kernel `predecessor` pins, `hosted-installation-successor.ts` step 3; see section 2 |
| F3 congruence compares the creator launch | **implemented** | core `host-installation-successor.ts` `launchSemantics` in `assertHostedInventorySuccessorCongruent` |
| F4 direct reader tests, surface derived from the producers | **implemented** (tests only; the resolver is unchanged) | new `hosted-installation-selected-reader.test.ts` |
| F5 one activation-byte snapshot | **implemented for `readHostedInstallationActivation`**; other readers listed below are NOT changed | `hosted-installation-activation.ts` `readHostedInstallationActivation` |
| F6 finite owned-cleanup recovery | **implemented** (entry + runbook below) | bootstrap `recoverOwnedRetentionCleanup`, argv `--recover-cleanup <id>` |
| F7 deadline sampled after each IO and before the claim | **implemented** (work and cleanup boundaries) | `retention-operation-host.ts` `closeRetentionOperation`; `cleanupOwnedDockerTestContainer` receipt write |
| F8 remaining items | **partly implemented**, rest observations | below |

### 1. F1: the original unit is terminal BEFORE any cleanup outcome

Defect (confirmed in source): `runFundedInstallationSupervisor` called the cleanup right after `await closure`, and only checked
`MainPID`/cgroup/job AFTER it. `fail()` ends with `stop --no-block` and a proxy SIGTERM, so the proxy can close while the unit still
lives; a supervisor between `create` and `start` could start the container after the outside owner had retained `already_stopped`,
`no_container` or `create_uncertain`.

Mechanism. `cleanupOwnedRetentionContainer(operationId, gate)` requires an `OutsideCleanupGate` (no overload without it) and calls
`gate.proveOriginalTerminal()` first, before it reads the packet, and `cleanupOwnedDockerTestContainer` calls it again before it
reads the custody records. The bootstrap gate polls (200 ms, inside the issuer's cleanup window) until ALL of these hold for the
original `subscription-runtime-installation-<id>.service`: `ActiveState` is `inactive` or `failed`, `MainPID` is `0`, no job (`Job=`
empty and absent from `list-jobs`), and every node of its control group positively reports `populated 0` with an empty
`cgroup.procs` (the existing `assertOriginalSupervisorEmpty`; an absent group is NOT empty - except the narrowly proven
terminal-disposal case of the "Terminal-unit custody correction" section at the end of this document, which supersedes this
sentence for a unit that systemd retired). A different control group or
invocation id (compared with the issuer's own `original-supervisor.json` when it exists) is HELD immediately. If the proof fails,
nothing is read, signalled or recorded: `{ ok:false, outcome:"cleanup_unproved", reason:"original_unit_unproved:..." }`, and the
issuer throws held. The window is sampled again AFTER the last observation. `cleanupMs` is now read after the proof, so the packet
read no longer shifts the cleanup end (F8).

Receipt semantics (changed, deliberate). Only a CLOSING outcome (`no_container | already_stopped | stopped`) is written as the
create-once `cleanup` receipt, and only if that write itself returned inside the cleanup window; a receipt that already exists
closes idempotently with no Docker call. Non-closing outcomes (`create_uncertain`, `cleanup_unproved`, a late receipt) are returned
with their reason and retained by the issuer as the FIRST evidence in `ordinary-installations/<id>/cleanup-held.json`; they no longer
consume the receipt name, so recovery can still close the operation.

Residual risk, not closed by source: unit terminality excludes the admitted supervisor and its Docker CLI children, but a `docker
start` request already accepted by the Docker daemon could still complete after a CLI killed mid-request; `already_stopped` is one
inspect. Only the real owned-container death/deadline/cleanup case on the Linux host can show whether that window exists.

### 2. F2: explicit predecessor / candidate generations (a12 follow-up; the a11 text said BLOCKED)

Confirmed in source (not assumed): `reservedGroups` in `hosted-ordinary-installation-census.ts` required
`activation.supervisorId === inventory.supervisor.birth` AND, for EVERY row of `activation.ordinaryStarts` (terminal ones included),
`start.supervisorId === inventory.supervisor.birth` plus `attachment.supervisorBirth`/`workEndEpochMs`/`cleanupEndEpochMs` equal to that
inventory's. Before the selection the committed activation correctly names the PREDECESSOR, so the literal reviewer call refused every
successor; after the selection a predecessor with any ordinary start would have failed the post-publication verification (the a11
"related, unverified" risk is real, and is closed by the same change). Nothing was relabelled and no fake activation record exists.

Contract. The census distinguishes the two generations by name:

- **SELECTED census** (normal admission, unchanged in strength): the inventory is the one the committed activation selects and the
  activation names its supervisor. An ACTIVE start must be admitted by exactly that supervisor. A TERMINAL start keeps the generation
  that admitted it: its `start.supervisorId` must be a birth PROVEN by the committed selection chain (every selection record
  digest-verified, each predecessor inventory digest-pinned by its successor's record, generations consecutive from 1, the original
  fixed inventory read by the same private reader the Host uses for fixed records, chain length capped at
  `maximumSelectionChainDepth` = 64, births and operations distinct), and its attachment must carry THAT generation's birth and
  work/cleanup windows. Unknown history, another boot, an activation row and start record that disagree on the reservation generation,
  or a terminal start of a foreign birth refuse exactly as before.
- **CANDIDATE census** (`new HostedReadonlyHostKernel(candidate, request)`, only inside the successor, under the held fence, BEFORE any
  record is staged or selected): the committed activation is authenticated AGAIN, by the funded pins, as the predecessor view: the
  pinned activation bytes and generation, the pinned selected installation and inventory bytes, the installation pinning that
  inventory, phase CLOSED, the activation naming the predecessor's supervisor, same host and boot, every start terminal. The candidate
  is a NEW generation: its birth and operation must not belong to any proven generation (`candidate_relabelled`). Its own live
  facts (session, MainPID birth, exact unit group, units, activators, cgroup members, jobs, reserved groups, collector profile, system
  bus) are verified with the candidate's own windows; nothing is written and no activation is pretended to name the candidate. A
  kernel with a candidate and no pins refuses before any live observation; pins without a candidate refuse at construction.
- Selection stays impossible until the whole candidate census has returned, and the publication still re-validates the pinned
  predecessor (`assertInstallationSelectionTransition`, also on recovery) under the same fence: that is the predecessor CAS. The
  post-publication verification of the selected world stays.

Not weakened: the SELECTED path never accepts a candidate (`selected_world`), pins never apply to a selected world, no unconditional
supervisor exception exists, and active starts are never adopted across generations. Widened, deliberately and only for the shape a
successor creates: terminal starts of PROVEN earlier generations.

What source cannot show: the live systemd/cgroup observations of the candidate census on the installed Linux geometry (the Docker
CLI in the supervisor's group, quiescent predecessor unit rows, activation races) and the first real successor over a predecessor
that has terminal ordinary starts. Those stay operator qualification.

### 3. F3: creator launch semantics

`assertHostedInventorySuccessorCongruent` now also compares `ordinaryCreators[0].launch` (the parser already makes `runtimeLaunch`
equal to it): `cwd` and every argument after the runtime CLI (tool, closed `--args-json` payload, `--json`) must be equal; the CLI
path (`args[0]`) must end in `/dist/worker-codex/codex-goal-cli.js` and its runtime directory is normalised away because a new
artifact lives elsewhere; the command (the pinned node of each artifact) is not compared across artifacts.

### 4. F4: the direct reader

`resolveSelectedInstallationRecord` already verified the record and file digests; nothing could fail if those lines were removed.
`hosted-installation-selected-reader.test.ts` binds them: missing/changed record, missing/changed selected file with no fallback to the
fixed record, a mixed self-consistent record that pins another world's digests, a reference that is not a digest / null / not a string,
for both record names, plus the real private-file reader and a check that every name the core producers emit passes the Host reader's
own name regex. Mutation protocol (three parts, as in the guard-binding rule): delete the record-digest check, delete the
selected-file-digest check, delete the `settled` comparison; assert each edit applied, observe the named test fail, restore, observe
green. The in-memory matrix is context for the decision; the real-fs block binds the reader as used.

### 5. F5: one snapshot

Call graph (confirmed): `readHostedActivationBytes("host-installation.json")` resolved through `resolveSelectedInstallationRecord`,
which reads the activation itself, and `readHostedInstallationActivation` then read `host-activation.json` AGAIN, so a publication
between the two returned the installation of generation A with the activation of generation B. Now the activation bytes are read once,
the SAME bytes are handed to the resolver as its `host-activation.json`, and the activation is parsed from them; at the end the
record is re-compared and a mismatch refuses (the caller retries) instead of merging. The resolver and the immutable record
verification are unchanged. NOT changed (outside the owned files): `inspectedInstallation`/`readHostedReadonlyHostInventory` and
`assertExclusiveHostedActivation` still read activation bytes independently; they compare digests against the installation they
were handed and refuse on a mismatch, so they can refuse spuriously during a publication but cannot accept a mixed pair.
`hosted-installation-activation.ts` is exactly at the 1000-line cap after this change.

### 6. F6: finite owned-cleanup recovery (runbook)

The outside issuer is the only cleanup owner; if it dies the container is no longer stopped by anyone. Recovery re-runs the SAME
helper with the SAME terminal-custody gate, without funding, starting or replaying anything.

1. Preconditions. Same boot and machine as the funded packet; the issuer process is gone (do not run two owners). Look at
   `retention-operations/<id>/cleanup.json` (if present and closing, nothing is left to do), `ordinary-installations/<id>/cleanup-held.json`
   and `.../<id>.closed.json`.
2. As initial-namespace root, with the packet's pinned node and the installed runtime of the funded operation:
   `node <runtimeDirectory>/dist/worker-codex/hosted-ordinary-installation-bootstrap.js --recover-cleanup <operation id>`.
   It requires the funded record, its `operation.json` copy and the launcher-consumption record, a funded version 3 or 4 with a Docker
   TEST launch, and the live boot/machine; it gets a fresh 120 s window (`recoveryCleanupWindowMs`), not the ended window of the
   original operation.
3. Exit 0 and `{"ok":true,...}` on stdout: custody is closed (stopped, already stopped or no container) and the `cleanup` receipt exists.
   Exit 70: stays HELD with the reason on stdout/stderr and in `cleanup-held.json`. `original_unit_unproved:...main_pid_alive` or
   `group_not_empty` means the supervisor unit still lives: wait for its own window or `RuntimeMax`, then run again. Never signal
   Docker by name. `create_uncertain` and `cleanup_unproved` stay HELD for the operator's forensic review.
4. Recovery closes container custody only. It does not write the operation's `.closed.json`, does not run or replay the retention, and
   a retention attempt without its own `closed` record keeps blocking a new attempt for the same permit until it is reconciled.

### 7. F7: the deadline after every IO

`closeRetentionOperation` samples the WORK window after every read (supervisor, result, container record, `cgroup.events`) and once
more immediately before creating `closed`, so a read that began inside the window and returned after it never reaches `closed`.
Cleanup boundary: the `cleanup` receipt write is an IO whose return must be inside the cleanup end, and the terminal proof is
accepted only if the window still holds after its last observation. The lifecycle already sampled after every Docker command.

### 8. F8 items

Implemented: tests for a failed `recordIntent` (no `docker create`) and for a failed `recordContainer` after `start` (exact container
stopped, HELD); `intent`, `created` and `container` records must each name the packet's operation (defence in depth); cleanup window
no longer shifted by the packet read; congruence cases for creator id, job root/workspace and disabled creators. Not changed, by
decision: the core keeps the relative physical names (`retention-operations`, `installation-successors`) because the Host reader's
name regex and the producers must describe one layout, and the new test derives the producer names to detect drift; moving them to the
Host is a boundary question for the reviewer, not a defect. A cwd-only difference cannot be constructed (the parser ties `cwd` to the
workspace, which congruence already compares).

### Tests (UNRUN)

New or changed: `retention-operation-test-launcher.test.ts` (gate-first binding block, receipt semantics, late receipt, foreign custody
records, intent/container record failures), `retention-operation-host.admission.test.ts` (terminal-custody predicate and bounded
proof, wrapper order, `closeRetentionOperation` delayed IO per stage and boundary), `host-installation-successor.test.ts` (core;
launch semantics), `host-successor-fixture.ts`, `hosted-installation-selected-reader.test.ts` (new). The Host doubles prove the
DECISION, not the observation: `observeOriginalUnit` needs the installed Linux geometry. Mutations to run (assert applied, observe
failure, restore): remove the `proveOriginalTerminal` try-block in `cleanupOwnedDockerTestContainer` (launcher gate block fails);
remove the `assertInWindow` after the `cgroup.events` read and the one before `create` (stage and boundary cases fail); remove the
`launchSemantics` comparison (five launch cases fail); remove the `settled` comparison (mid-flight publication case fails).

### Operator commands (not run)

- Strict: the pinned compiler the operator already used (the `baseUrl` configuration keeps `tsc7` unsupported);
  `node scripts/check-architecture-guardrails.mjs`.
- Portable: `vitest run src/core/tests/host-installation-successor.test.ts src/core/tests/host-retention-operation.test.ts
  src/core/tests/host-inventory.test.ts src/worker-codex/tests/hosted-installation-successor.test.ts
  src/worker-codex/tests/retention-operation-test-launcher.test.ts src/worker-codex/tests/retention-operation-host.admission.test.ts`.
- Linux root (real private-file reader and the suites that mock `readHostedActivationBytes` or read the installation):
  `vitest run src/worker-codex/tests/hosted-installation-selected-reader.test.ts src/worker-codex/tests/hosted-ordinary-activation.test.ts
  src/worker-codex/tests/hosted-readonly-host-kernel.test.ts src/worker-codex/tests/hosted-readonly-supervisor-host.test.ts
  src/worker-codex/tests/hosted-readonly-runner.test.ts`, then the hosted-ordinary-installation suites.

### a12 F2 follow-up: tests, mutations, operator commands (UNRUN)

Changed scope versus a11: `hosted-ordinary-installation-census.ts` (previously outside the 41-file manifest), the successor contract and
its caller, the kernel (`predecessor` pins, early candidate guard), one new Host module `hosted-ordinary-installation-history.ts`
(chain proof and pinned-predecessor authentication, built on the existing resolver and private readers; it is the single place
that reads the committed selection chain). Everything else of a11 (F1, F3-F7, terminal cleanup, creator semantics, direct-reader
refusals, post-IO deadlines, owned recovery) is untouched.

Tests. Core `host-installation-successor.test.ts` ("supervisor generations keep their own identity"): the real fixtures through
`admittingSupervisorGeneration`: terminal predecessor start keeps its generation (candidate census and after selection), an active
start is never adopted across generations or exists in a candidate census, unknown birth / other boot / disagreeing reservation
generation refuse. Host `hosted-ordinary-installation-history.test.ts` (new): the real selection resolver, parsers and digests over an
in-memory file map: a valid pinned predecessor yields the candidate census view and changes no byte; stale activation/generation/
inventory/installation/id pins, a non-CLOSED activation, an active start, a foreign supervisor session, another host or boot, a
relabelled candidate birth or operation, a missing activation, a mixed installation/inventory reference refuse; after one and two
successors the whole chain is proven down to the original fixed record, and a changed earlier record, a changed or missing original
inventory, a record of another birth/operation/installation/boot, a skipped generation, a repeated supervisor and an over-long chain
refuse. `hosted-installation-successor.test.ts` (Host): the candidate census runs once, under the publication's own fence, with the
funded pins, before any record; a refused census stops everything (disclosure: the census is a double there, so that case proves order
and fail-closed wiring only). `hosted-readonly-host-kernel.test.ts`: pins without a candidate and a V5 candidate without pins refuse
before any live observation. NOT covered by any test here: the census' systemd/cgroup walk against a candidate (existing code, needs
the installed Linux geometry) and the unit-name allowance of terminal predecessor units lingering in `list-units`.

Mutations to run (assert applied, observe failure, restore, observe green): in `admittingSupervisorGeneration` drop the
`!input.terminal && ...` clause (active-start cases fail); drop the `born.bootId`/`start.bootId` clause (boot cases fail); in
`hosted-ordinary-installation-history.ts` drop the `candidate_relabelled` line, the `predecessor_active_start` line, the
`stale_predecessor` line, the `selection_predecessor_inventory` digest comparison, or the `generation + 1` comparison (the named
cases fail); in `hosted-readonly-host-kernel.ts` move the early candidate guard after `this.session()` (the no-observation assertions
fail); in `hosted-installation-successor.ts` delete the `kernel.verifyExclusiveInventory(fence)` call (order and census-refusal cases
fail).

Operator commands (not run): add `src/worker-codex/tests/hosted-ordinary-installation-history.test.ts` and
`src/worker-codex/tests/hosted-readonly-host-kernel.test.ts` to the portable `vitest run` list above (the history test uses doubles
only and needs no Linux); the pinned compiler and `node scripts/check-architecture-guardrails.mjs` as before.

Cost note: every census now reads the selected inventory once more (up to 4 MiB, already read by the kernel) and, only after a
successor, one record plus one inventory per generation (chain depth is capped at 64).

Remaining functional blockers: none known in source for F2. Open and NOT claimed: source acceptance, Linux 24/26 qualification of a
real successor over a predecessor with terminal ordinary starts, installed authority, original13 readiness.

### CMS / Host classification (a10)

Unchanged: private Host boundary, `not-adopted`, adoption pending; the pins recorded for a8/a9 were not re-derived and no new pin was
introduced, so an unreviewed or stale pin is not adoption. Runtime Host lifecycle (unit custody, cleanup ownership, recovery,
activation reads) stays in the Host; the core change is one pure congruence rule. No Core/Assembly handle, module, SPI, manager or
service bag was created: the gate is an argument of the existing cleanup helper. The enforcing checks are the rejecting tests above;
there is still no repository CMS checker. Source acceptance, the Linux 24/26 qualification, installed authority, the physical
owned-container death case and every original-job operation remain separate, closed gates.

## Terminal-unit custody correction (outside-cleanup F1; SOURCE ONLY, UNRUN, not independently accepted)

The a14 source seal is preserved historical evidence; this correction is a new delta on top of it. The a14 acceptance does not make
this correction unnecessary, and no physical gate is claimed passed. Nothing was compiled, tested, hashed or executed by its author (Read/Edit/Write/
Glob/Grep only); byte identity and every run are Root's.

### Physical facts used (and not used)

From Root receipt `runtime-systemd-terminal-cgroup-actual.json` (machine `d856d40d...`, isolated TEST units `Type=exec`, `--wait`, no
`CollectMode`, `originalJobsTouched:false`), at 0 / 200 ms / 1 s after the unit ended:

- `normal` (`/usr/bin/true`) and `stop` (stopped `sleep 5`): `MainPID=0`, `Job=` empty, `ControlGroup=` empty, `ActiveState=inactive`,
  `InvocationID=` EMPTY at every sample. The stop unit's live `ControlGroup` before the stop was the nested path ending in
  `.../TEST-node26-retention-cgroup-20261011-a1.slice/TEST-node26-retention-cgroup-20261011-a1-stop.service`.
- `failure` (`/usr/bin/false`): `MainPID=0`, empty `Job`, empty `ControlGroup`, `ActiveState=failed`, `InvocationID` RETAINED
  (`24eb60f0...`) at every sample.
- The receipt's `knownLeafExists:false` is for a FLAT TEST-slice path that was never the unit's path; it is WRONG as evidence and is not
  used. The only absence fact used is Root's exact-leaf receipt `runtime-systemd-terminal-cgroup-exact-leaf-actual.json`: the nested
  `/sys/fs/cgroup/TEST.slice/.../TEST-node26-retention-cgroup-20261011-a1-stop.service` has `existsNow:false`
  (`readonlyExactOwnedTESTCgroup`). That is a TEST path; nothing in source derives the production path from it.
- NOT observed by those two receipts (stated, not assumed): `LoadState` of a terminated unit, and the nested live path / parent chain
  for `normal` and `failure`. The a16 amendment below uses Root's later receipt for exactly those facts.

### a16 amendment: authenticated-retired `not-found` (supersedes the `LoadState=loaded` requirement of the first draft)

Physical facts used, all from Root's `runtime-systemd-loadstate-a2-actual.json` (isolated TEST units `...-terminal-loadstate-20261011-a2-*`;
nested live chain `/sys/fs/cgroup/TEST.slice/.../TEST-node26-terminal-loadstate-a2.slice/<unit>.service`, every directory root-owned on
`dev` 29, observed alive and again after exit at 0 / 0.2 / 1 s):

- `normal` and `stop`: live `loaded`/`active`/`running` with a real invocation; after exit `LoadState=not-found`, `ActiveState=inactive`,
  `SubState=dead`, `MainPID=0`, `Job=` empty, `ControlGroup=` empty, `InvocationID=` empty; the exact original leaf is absent
  (`originalLeafExists:false`) under the SAME parent directories (identical `dev`/`ino` before and after).
- `failure`: stays `LoadState=loaded`, `failed`/`failed`, keeps its original `InvocationID`, empty `ControlGroup`, leaf absent, same parents.
- A NEVER-created unit prints the SAME show as `normal`/`stop` (`not-found`, `inactive`, `dead`, PID 0, empty group and invocation).
  Therefore `not-found` and empty group/invocation are NOT authority: only retained provenance of a genuinely admitted, formerly live
  unit separates the two. The flat path of the older 31737 run is not used anywhere.

Mechanism (one predicate, two callers). `originalUnitPending` now has three distinct accepting shapes: (1) existing empty leaf, unchanged;
(2) `loaded` + bound-absent (a failed unit: retained invocation exactly, empty group, leaf gone); (3) authenticated-retired `not-found`
(`inactive`, PID 0, no job, empty group and invocation on both samples, leaf gone). For (2) and (3) the leaf must be proved absent under
parents whose `path`/`dev`/`ino` equal the ancestry the ISSUER retained while the unit was alive. Authority = the issuer's bound
`original-supervisor.json` agreeing with the supervisor's own `<id>.supervisor.json` AND a new create-once `original-leaf-chain.json`
(`observeLiveLeafChain`, taken in the same bind as the birth/invocation/group, written BEFORE the supervisor record) naming the same
operation, unit, boot and group. No authority (never-created, no bound record, unconfirmed record, no retained chain) makes `not-found`
HELD immediately (`original_unit_unauthenticated`); recreated, missing, extra, reordered or renamed parents are HELD
(`original_leaf_parents_unbound`); a non-empty changed invocation or another boot is a replacement. A `loaded` unit with an empty
invocation is no longer accepted (pending `invocation_empty_for_loaded_unit`): physically only a collected unit has none.

Authority derivation (a17). The three records' bytes, read through the private root-owned reader, and the funded identity (operation,
unit, exact group, funded machine and boot, live machine and boot) go through ONE pure function,
`deriveOriginalUnitExpectation` (`retention-operation-host.ts`), instead of three readers inside the bootstrap. It grants nothing to
arbitrary bytes: reader custody (owner, mode, held FD) and the live supervisor/unit/cgroup observation stay with the caller. Refusals
are field-specific HELD reasons: `machine_mismatch`, `boot_stale`, `identity_group_invalid`, `bound_record_mismatch:<field>` (operation,
unit, group, boot of the issuer's record), `bound_invocation_invalid`, `bound_birth_invalid`, `supervisor_record_mismatch:<field>` (the
supervisor's own record against the issuer's: operation, unit, boot, BIRTH, INVOCATION, group), `leaf_chain_mismatch:<field>`,
`leaf_chain_parents_invalid`, `leaf_chain_leaf_invalid`, `*_record_shape`. An ABSENT record only withholds authority. No new record
format and no new public grant: the schemas are exactly the three writers' existing ones.

Callers. `proveOriginalUnitTerminalCustody` in the bootstrap is the single composition (record bytes, derivation, bracketed
observation, bounded polling). It is used by (a) `outsideCleanupGate`, before the packet/Docker ownership
read, and (b) the issuer's final closure in `runFundedInstallationSupervisor`, which replaced its own extant-cgroup/current-invocation
check (`collectUnitInvocation`, `ControlGroup ===`, `assertOriginalSupervisorEmpty`) at that one callsite. Funding, installation and
cleanup deadlines are unchanged.

### Defect and change

Defect: the outside-cleanup predicate required an extant control group and a matching CURRENT `InvocationID`, so a normally disposed unit
(empty `ControlGroup`, empty `InvocationID`, leaf gone) held cleanup forever even though birth/unit/invocation custody was retained.

Changed (`retention-operation-host.ts` `originalUnitPending`, `OriginalUnitExpectation/Sample/Facts`; `hosted-ordinary-installation-
bootstrap.ts` `observeOriginalLeaf`, `sampleOriginalUnit`, `observeOriginalUnit`, `supervisorBirthAuthenticated`, `outsideCleanupGate`;
`hosted-readonly-linux-collector.ts` `collectOriginalUnitTerminalShow`). The gate interface (`proveOriginalTerminal`) and the order are
unchanged: the whole proof still completes BEFORE the ownership read and any Docker call.

- Identity before any absence is accepted. The gate checks `/etc/machine-id` and the live boot against the funded packet (the recovery
  entry uses the funded record), the issuer's bound `original-supervisor.json` (operation, unit, exact original group, boot) and then
  cross-checks it with the supervisor's OWN `<id>.supervisor.json` (unit, boot, birth, invocation, group): two independent writers must
  agree, a disagreement is HELD. Only then is `birthAuthenticated` true. A terminal process has no live birth to re-read, so birth is
  authenticated through those two records plus the retained invocation, not re-observed.
- Unit state is sampled BEFORE and AFTER the bound leaf observation and the two samples must be identical (`observation_drift` otherwise;
  a change of boot/group/non-empty invocation across them is a replacement, HELD).
- Required unit facts (all from the manager, never inferred): `LoadState` `loaded`, or `not-found` ONLY under the a16 authority above;
  `ActiveState` `inactive|failed` (`inactive` for `not-found`), `MainPID=0`, no `Job` and not in `list-jobs`.
- An EXISTING leaf: unchanged strength. Every node must positively report empty (existing walk) AND systemd must still name the exact
  original group and a retained invocation (`control_group_unbound_for_live_leaf`, `invocation_unretained_for_live_leaf`).
- An ABSENT leaf (`absent_proved`): every parent of the canonical original path (`/sys/fs/cgroup` -> `subscription.slice` ->
  `subscription-runtime.slice` -> `subscription-runtime-hosted.slice`) is opened through its parent's descriptor (`O_DIRECTORY|O_NOFOLLOW`
  via `/proc/self/fd/<fd>/<name>`), must be root-owned, on cgroup2 (`statfs` magic) and, below the root, have a readable `cgroup.events`;
  the exact leaf name must be ENOENT on the parent descriptor and not listed by it; every held directory must resolve to the same
  device/inode by path afterwards. A missing/unproved parent, another errno or any change is `not_proved` (never absence). No global scan.
  Absence additionally requires the retained invocation and the a16 authority (otherwise HELD `original_unit_unauthenticated`), the
  observed parents must equal the retained live ones (else HELD `original_leaf_parents_unbound`), and systemd must report an EMPTY
  `ControlGroup` for it (`control_group_reported_for_absent_leaf` otherwise).
- Current invocation: equal to the retained one for a `loaded` unit (failed), EMPTY only for a collected `not-found`/`inactive` unit. A
  non-empty invocation that differs from the retained one is a replacement and is never substituted (`original_unit_replaced:invocation`).

### Rejecting tests (`retention-operation-host.admission.test.ts`; UNRUN)

Block "a normally disposed terminal unit is accepted only on the retained, authenticated original identity" and the gate-composition
cases in "F1: cleanupOwnedRetentionContainer proves terminal custody BEFORE it reads the packet". Accepting: authenticated-retired
normal/stop (`not-found`), loaded failed with the retained invocation, the unchanged existing-empty leaf (three distinct shapes). Refusing
(the gate cases all assert NO packet/custody read, no record created): never-created unit (no bound record), unconfirmed record or no
retained chain, no retained invocation, recreated/missing/extra/reordered/renamed/absent parents, changed nonempty invocation, stale
boot, live MainPID, pending job, drift between the bracketing samples, leaf not proved absent, collected unit that still reports a
group/invocation, `failed` reported by a collected unit, collected unit with an existing leaf, `masked`/`error` load states, and a
`loaded` unit with an empty invocation. The existing bounded-proof tests use the bracketed fact shape.

Authority derivation (a17), blocks "authority derivation: the three already-authenticated records plus the funded identity" and "authority
derivation drives the SAME gate decision for cleanup": the real exported `deriveOriginalUnitExpectation` is driven with the exact
writers' record bytes. Positive: genuine issuer + supervisor + live-chain bytes derive the retained invocation and ancestry and are
accepted by the predicate for a collected normal/stop unit and a loaded failed unit. Rejecting, each with its OWN reason and mutating
only that field (the issuer-side cases mutate the bound and the self-record together, so only the issuer-vs-identity check can refuse):
foreign operation/unit/group/boot in the issuer's record, malformed or empty retained invocation/birth, supervisor self-record with a
changed BIRTH (pid and ticks), changed INVOCATION or another operation/unit/boot/group, stale machine, stale boot, a retained chain
of another operation/unit/boot/group, a wrong/missing/extra/reordered/negative-device/zero-inode/extra-field parent, a bad leaf
identity, malformed JSON or foreign/missing keys in any record, a group that is not a slice path ending in the unit, and a chain of
another bind (accepted by the derivation, refused by the live ancestry in the predicate). Missing records yield `authority: null`
(never-created, unconfirmed, no chain) and a collected unit stays HELD. Through `cleanupOwnedRetentionContainer`, every failed
derivation returns `cleanup_unproved` with the specific reason and performs no packet read, Docker call or receipt.

NOT exercised by any test: `observeOriginalLeaf`, `observeLiveLeafChain`, `sampleOriginalUnit`, the private-file readers and
`/etc/machine-id`/boot reads inside `proveOriginalUnitTerminalCustody`, and therefore the wiring of BOTH callers (the issuer's closure
spawns systemd-run and reads /proc and cgroupfs). Both callers consume the same function, but the tests drive the derivation and the
decision, not the callers, the reader custody or the live supervisor/cgroup checks, which stay physical gates.

Mutations to run (assert applied, observe the named failure, restore): drop the `retired && (... authority === null)` HELD (the
never-created and unconfirmed cases fail); drop the `sameAncestry` HELD (the parents cases fail); drop the before/after comparison (drift
cases fail); drop `retired && unit.activeState !== "inactive"` (collected-`failed` case fails); drop the `invocationId !== expected`
return for loaded units (empty-invocation-on-loaded case fails). Derivation (a17), each a one-line test-local mutation of
`deriveOriginalUnitExpectation` (assert the line matched once, observe the named RED, restore, observe GREEN): delete the
`bound[key] !== value` loop (the ISSUER cases fail); delete `"birth"` from `supervisorRecordKeys` (only the reused-BIRTH cases fail);
delete `"invocationId"` from it (only the INVOCATION case fails); delete the `/^[a-f0-9]{32}$/` test (the invocation-shape cases
fail); delete the `liveBootId`/`liveHostId` lines (the stale boot/machine cases fail); delete the `chain[key] !== value` loop (the
LIVE CHAIN mismatch cases fail); delete the `path !== slices[at]` clause (wrong/reordered parent cases fail).

### Operator commands (not run)

`tsc7 --noEmit` is unsupported by this project's `baseUrl` configuration; use the pinned compiler the operator already used, then
`node scripts/check-architecture-guardrails.mjs`, then `vitest run src/worker-codex/tests/retention-operation-host.admission.test.ts
src/worker-codex/tests/retention-operation-test-launcher.test.ts`.

### Unresolved physical proofs and risks (nothing here is claimed passed)

1. RESOLVED INPUT (a16): `LoadState` of terminated units and the live nested chain are now known from Root's
   `runtime-systemd-loadstate-a2-actual.json`; the first draft's blanket `not-found` refusal is replaced by the authenticated-retired
   branch. Not resolved by it: the receipt is TEST units under `TEST.slice`, with a different parent chain and without the production
   supervisor's records; nothing derives the production path from it.
2. The retained live chain is a NEW record (`original-leaf-chain.json`) written by the issuer at the bind. Operations bound BEFORE this
   change have none, so their collected units stay HELD (deliberate: no authority). Production slices
   (`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice`): whether they persist while empty on the
   installed host is unobserved. If a parent is collected and recreated, the retained `ino` no longer matches and the unit stays HELD.
3. The issuer's final closure in `runFundedInstallationSupervisor` now uses the same proof (this reverses the first draft's "adjacent,
   not changed"). Its wiring, the live observation and the three record readers are unexercised by tests; it needs the Linux
   qualification with a genuine admitted normal and stop unit, not only the predicate tests.
4. A cleanup that polls for terminality inside the issuer's closure is bounded by the cleanup deadline (`budget(packet, true)`); the
   first observation normally succeeds because `systemd-run --wait` has returned. Unobserved: the time between the proxy returning and
   systemd collecting the unit, which would show as pending `unit_not_terminal`/`observation_drift` until the window ends.
5. The Docker side residual risk of section 1 (a `start` already accepted by the daemon) is unchanged.
6. The exact-leaf and a2 receipts are point observations of TEST paths, not proof of stability or of installed authority.
