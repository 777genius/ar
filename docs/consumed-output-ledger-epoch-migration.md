# Consumed-output ledger epoch migration

Use `codex_goal_project_migrate_consumed_output_ledger_epoch` when immutable
legacy output records still exist but their external archive evidence can no
longer be recovered. The operation does not repair or erase legacy debt. It
preserves every old-ledger byte and creates explicit quarantine records for
evidence that cannot be admitted as valid.

## Safety contract

- The controller must use `ProjectScopedControl` and exactly one active
  `consumedOutputLedgerRoots` entry.
- The new root must be inside an existing project read/workspace/worktree root,
  outside denied roots, and must not overlap the old root.
- Preview binds controller manifest/stable-scope fingerprints, registry job-id
  snapshot, old/new roots, cutoff, every source file, and every external
  admission-evidence realpath/size/hash (or explicit missing/denied marker)
  into one SHA-256 plan.
- A production-sized legacy-admission exception is accepted only for the
  independently approved exact 495 unconsumed-completed-job / 205
  orphan-legacy-workspace / 6 active-writer-conflict / 4
  inactive-dirty-workspace envelope. The plan and every later
  epoch retain its canonical category counts, subjects hash, full sanitized
  debt hash and cutoff. Near-count or content drift fails closed; smaller
  ordinary migrations continue through the normal quarantine transition.
- Apply requires the exact preview hash. It rescans immediately before seeding
  and immediately before activation, so source or scope drift fails closed.
- All old-root files are copied byte-for-byte to
  `legacy-preservation/`. Valid current or post-cutoff terminal records are
  also copied to the new `items/` directory. Every other item gets an immutable
  `quarantine/` entry with `valid=false` and `repaired=false`.
- Dirty orphan workspaces are never copied, deleted or declared repaired. Their
  device/inode, HEAD, status, tracked diff and untracked-content hashes are
  signed into a quarantine binding. Every later epoch carries and revalidates
  the exact binding; drift remains blocking. Denied-root evidence is never read
  or trusted.
- The transaction advances only
  `prepared -> scope_switched -> receipt_prepared -> active` under
  the controller CAS lock and the shared ledger publication lock. A prepared
  root is owned and retained for fail-forward retry; it is never deleted after
  publication or scope switch. Seed trees, state replacements, scope updates,
  retirement markers and receipts are synced before the next durable phase.
  New prepared roots also contain an immutable schema-v2 intent binding the
  old/new roots, epoch history, root device/inode identities and plan hash.
  Existing prepared schema-v1 roots are upgraded and activated by the same
  hash-confirmed call. It publishes or recovers a resumable v2 provenance
  sidecar without rewriting the immutable v1 plan, owner, state, history or
  seeded evidence bytes. The sidecar binds the reconstructed exact debt and
  canonical workspace/process custody before activation continues.
- Before quiescence checks, apply acquires a durable controller-maintenance
  fence. Operation publication/execution, complete integration use cases and
  worker launch use activity leases that are mutually exclusive with that fence. Process
  inspection remains defense in depth for N-1 writers; changing a package
  symlink alone is not proof that they reloaded.
- Normal terminal publication uses one shared old/new ledger lock, so it cannot
  race the final revalidation, receipt publication or activation window.
- The durable controller scope CAS is the point of no return. Immediately after
  that CAS, apply publishes an immutable retirement marker in the old root
  while still holding both publication locks. A stale writer that later acquires the shared lock rejects that
  retired root instead of publishing invisible terminal evidence. The exact
  marker is required by every active receipt; any partial epoch tuple fails closed.
- The epoch receipt records plan/root hashes, migrated and quarantined counts,
  timestamps, and admission summaries before and after migration. Replaying
  the same plan is idempotent only when the exact stored plan/state/owner,
  immutable seeded preservation/items/quarantine bytes and actual scope all
  agree. New terminal items may be appended after activation without changing
  the seed manifest. A retry
  after scope switch or receipt publication resumes the stored immutable plan
  rather than rebuilding it from the changed controller manifest. Quarantined
  entries remain visible in admission as non-blocking
  `LegacyOutputQuarantineRequired` debt with exact epoch/plan/count evidence.
  Later epochs carry the cumulative prior quarantine count in their signed
  plan and receipt, so preserved legacy debt cannot disappear from admission.

## Operator procedure

1. If stale nonterminal integration attempts block quiescence, preview
   `codex_goal_project_reconcile_stale_integrations` and save its plan SHA. The
   plan binds the exact controller manifest/maintenance epoch, registry and job
   roots, workspace/denied roots, allowed remote/branch identity, live remote
   branch OID, clean target HEAD and exact attempt bytes. Patch evidence is
   admitted only from canonical project custody and signs its real path,
   device/inode, mode, size and byte hash. Confirm with that SHA only.
   Reconciliation revalidates the controller CAS, runs under the controller
   maintenance fence and target locks, records durable per-attempt progress,
   and resumes idempotently after interruption.
2. If the exact persisted stale plan contains investigated legacy attempts that
   still cannot be terminalized safely, preview
   `codex_goal_project_quarantine_legacy_integration_attempts` with that
   `sourceStaleIntegrationPlanSha256` and an ISO cutoff that excludes new work.
   The cutoff must already be at least 24 hours old. Only the audited refusal
   classes `target_workspace_dirty`, `attempt_patch_partial_or_ambiguous` and
   `patch_outside_reviewed_store` are accepted; any other refusal fails closed.
   The incident envelope is exactly 17 attempts: 2 reconciliation-evidence-bound
   and 15 unresolved, with refusal counts 3/7/5 in that class order. Any count
   or distribution drift fails before publication. The quarantine is single-use
   for the ledger epoch: its immutable active-plan claim permits exact same-plan
   replay only, and rejects every second plan before or after the epoch switch.
   The custody plan imports the complete source plan atomically; callers cannot
   supply attempt IDs, dispositions or free-form refusal reasons. It preserves
   attempt and event bytes, controller/scope/registry/workspace/process custody,
   and records eligible entries separately from unresolved evidence. Confirm
   only the returned `expectedLegacyAttemptQuarantinePlanSha256`. The active
   receipt explicitly states that source was not mutated, lifecycle was not
   terminalized, rollback and ledger consumption were not claimed, and the
   prior reject outcome is not claimed without immutable per-attempt evidence. The
   exception is terminal for ledger-epoch quiescence only. Any byte, scope,
   registry, workspace, process or source-plan drift blocks activation. The
   ledger-epoch plan and receipt then anchor the exact quarantine plan, root,
   receipt and disposition counts. After the atomic scope switch, that immutable
   anchor replaces live controller/registry CAS checks so later jobs and pushes
   do not invalidate historical custody. Normal integration mutators reject only
   attempt IDs covered by the active or epoch-anchored receipt.
   The same MCP operation is available from the CLI without a second code path:
   `subscription-runtime-codex-goal tool codex_goal_project_quarantine_legacy_integration_attempts --args-file <json>`.
3. Pause new work, wait for all other project-control/integration operations to reach
   terminal state, then drain and reconnect all old MCP/OpenAI bridge processes.
   Record admission and confirm the controller points at the intended old root.
4. Call the migration tool without confirmation. Save `planSha256`,
   `oldRootHash`, file count, migrated count and quarantine count.
5. Review the bounded counts and paths, then call the same tool with
   `expectedLedgerEpochPlanSha256` and `confirmLedgerEpochMigration=true`.
   For a prepared v1 plan this same call atomically recovers or publishes the
   sidecar and continues activation; no second confirmation is required.
6. Read another admission snapshot. Confirm the active root contains
   `ledger-epoch-receipt.json` and the returned before/after comparison matches
   the observed result.
7. Point maintenance and janitor code at
   `resolveConsumedOutputMaintenanceLedgerRoot(scope)`. It selects the active
   scope root and verifies an epoch receipt when present; do not hardcode a
   historical ledger root.

## Rollback

Automatic failures before the durable scope switch leave the old root active.
Once the scope CAS succeeds, recovery is strictly fail-forward: a retry resumes
the stored plan, publishes/verifies the old-root retirement marker, receipt and
active state. It never claims that the old root remained active.
After a successful activation, do not manually edit either ledger. A rollback
is a second brokered epoch migration with the current active root as the old
root and a fresh, empty destination. This preserves the activation history and
produces another hash-bound receipt instead of mutating prior evidence.
