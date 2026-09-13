# Bounded reviewed output file bytes

`codex_goal_project_mark_reviewed` accepts optional
`reviewedOutputFileByteAllowance` when `captureReviewedOutput: true`. It must be
a positive integer no greater than 8,388,608 bytes (8 MiB). Reviewers choose the
bound before capture and review of the exact `expectedPatchSha256`.

The allowance is part of the immutable reviewed output identity. It reaches
both exact workspace capture and reconstructed patch blob secret validation.
Both current and base file bytes remain subject to scanning. After those bytes
are bound to scanned blobs, the envelope scanner collapses consecutive synthetic
blank placeholders to one separator. It preserves all unbound bytes and avoids
pathological whitespace matching for reports with many lines. The existing
16 MiB aggregate and 16 MiB patch bounds remain unchanged.

Opening integration by `reviewedOutputId` carries the persisted allowance and
identity to the worker output. Commit re-resolves the attested reviewed snapshot
and checks the allowance, source path, base, patch hash/path, and changed files
before scanning. A missing integrity verifier rejects exceptional delivery.
Integration action arguments cannot enlarge the allowance. Required checks,
approved file scope, and full current/base secret scans still precede commit.

Omission preserves the previous identity serialization and limits: reviewed
capture and patch validation use 4 MiB; integration scanning uses its existing
2 MiB default. Existing records need no migration. No old review, custody
attestation, or consumed-output record is rewritten by this capability.

For an allowance-bearing patch integration, checks verify the target tree against
an application of the hash-verified reviewed patch to the target commit, before
and after execution. Successful checks persist that tree identity. Commit must
match it, scans all changed candidate blobs from that immutable tree (and the
base blobs), and requires the scanner to attest the same tree. The
base scan uses the immutable expected parent commit. The scan list and
recorded commit files come from the complete candidate-versus-parent tree delta,
including paths hidden from status by assume-unchanged or skip-worktree flags.
A compare-and-swap ref update publishes a commit built directly from those
object names. Benign worktree drift observed after checks, scanning, or commit
object creation rejects publication; a later concurrent write cannot enter the
fixed commit tree. The real index is synchronized without staging fresh bytes.

Custom integration adapters must implement tree verification, complete tree delta,
prepared publication/reconciliation, and the immutable tree/parent scanner
contracts to use the allowance. Historical attempts that
omit it retain the existing integration behavior. Allowance-bearing merge
attempts currently fail closed: merge resolution needs a separate expected-tree
binding and is outside this patch-delivery change. Ordinary merge behavior is
unchanged. Configured commit signing and executable post-commit hooks fail closed
before publication. Signed commits, merges, and post-publication hook semantics
need separate support; no configured guard is silently bypassed.

Validation hooks (`pre-commit`, `prepare-commit-msg`, `commit-msg`) run through
`git hook run --ignore-missing` (Git 2.36 or newer), honoring `core.hooksPath`.
They receive the approved author/committer environment and a temporary candidate
index. Each hook must succeed without changing the candidate tree, message, or
reviewed worktree. The resulting commit object is checked for the expected tree,
single parent, author, committer, and message. This supports the host policy
checking `git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT` for
`iliya <iliyazelenkog@gmail.com>` without disabling hooks.

Before the ref can advance, the existing integration attempt stores
`preparedReviewedCommit`: exact commit SHA, tree, parent, original index tree,
approved identity, reviewed-output ID, and scanned commit candidate. A failed
response after CAS is reconciled against that exact identity. Retrying the same
commit action and message can recover `CommitCreated` after a process or evidence
write failure, without creating an extra commit. Divergent refs, changed message,
identity, or prepared evidence fail closed. This uses the existing attempt store,
not a replacement custody ledger; it does not add a power-loss durability promise
to that store.

Index synchronization is independent of publication. `reviewedIndexRecoveryPending`
records failure without losing `CommitCreated`; repeating the same action retries
synchronization. Under the existing attempt and workspace leases, recovery locks
the index, accepts only the original or candidate
index tree, and never overwrites a differently staged tree or removes a foreign
index lock. An owned staging file hard-linked to `index.lock` proves ownership of
a lock left by failed cleanup, allowing the same publication to recover it.
A foreign lock or changed index leaves recovery pending until that conflict is
resolved. Temporary-directory cleanup failures cannot undo recorded publication.

Once `CommitCreated` and `reviewedIndexRecoveryPending: false` are durably stored,
replay verifies the prepared commit and published ref without acquiring or writing
the index. Later staging belongs to the caller, including an intentional staged
revert to the original tree. Pending or not-yet-recorded synchronization still
uses the ownership-checked recovery above. Focused regressions reload the local
attempt store after real large delivery and preserve original/different staging;
bounded SIGKILL child tests cover both sides of publication and an owned index
lock left by process death.
