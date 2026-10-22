# Retiring finished jobs and MiMo workstreams

A finished job keeps its workspace on scratch until something removes it, and
removing it by hand breaks Status and Stop: they open the workspace as a
protected source. The supported path has two owners:

- the runtime's root operator command `--retire` proves that a job is terminal
  and its output preserved, tears down its research pins and writes a tombstone;
- the host retention tool in `777genius/platform-infra` deletes the workspace
  body later, and only for a valid tombstone whose device and inode match.

The runtime never deletes workspace bodies. The records and their rules are the
[job retirement host contract](../../host-integration/job-retirement/README.md).

## Units

| Target | Registry root | What is retired |
| --- | --- | --- |
| `job` | `/srv/worker-state/jobs/<p>/<w>/registry` or `/srv/worker-state/jobs/<w>/registry` | One exact worker job, together with the jobs of the same registry that share its workspace (a producer and its verifier). The workspace must be inside `/srv/workers/jobs/<p>/<w>` or `/srv/workers/jobs/<w>`. Controllers are refused. |
| `mimo-workstream` | `/srv/worker-state/mimo-projects/<p>/<w>/registry` | The whole workstream: the controller, every worker and every unregistered failed Create, plus the `source` checkout and all its worktrees. A single MiMo job is refused (`unit_must_be_workstream`): its worktree shares the source. |

Bindings, workstream YAML, state roots, registries, run-state and durable
handoffs stay where they are. Status and Stop of every retired job keep working
from the records, including after the host tool deleted the scratch root.

## Procedure

1. For a MiMo workstream, close its route first: the workstream or project
   `.route-disabled` marker in `/etc/subscription-runtime/projects/`, or
   `routing_enabled: false` in its workstream YAML through the platform-infra
   inventory. Anything that closes Create counts. The command refuses an open
   route (`route_open`).
2. Write the plan as a root-owned `0600` file in the root-owned `0700`
   directory `/etc/subscription-runtime/job-retirement/`:

   ```json
   {
     "schemaVersion": 1,
     "machineId": "<32 hex>",
     "target": { "kind": "mimo-workstream", "projectId": "<project>", "workstreamId": "<workstream>",
       "expectedBindingSha256": "<64 hex of the binding bytes>" },
     "jobs": [
       { "jobId": "<controller>", "expectedManifestSha256": "<64 hex of job.json>", "output": { "kind": "clean" } },
       { "jobId": "<worker>", "expectedManifestSha256": "<64 hex>", "output": { "kind": "handoff", "manifestSha256": "<64 hex>" } }
     ]
   }
   ```

   For one job the target is `{ "kind": "job", "registryRootDir": "<registry>", "jobId": "<job>" }`
   and `jobs` holds that job and every job that shares its workspace
   (`plan_jobs_mismatch` for a job with another workspace). A workstream plan lists every job of the
   registry, the controller included. `output` is the reviewer's statement of
   where the job's work is: `handoff` names the manifest digest of its published
   durable handoff packet, `clean` says there is no change. Never-started jobs
   and the controller are always `clean`.
3. Dry run. It prints every job's state, terminal kind, output and the first
   refusal of each job. It writes no record and takes no maintenance fence; the
   existing birth observer it reuses briefly holds its protected publication
   lock, as Status does:

   ```sh
   node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --retire --dry-run /etc/subscription-runtime/job-retirement/<plan>.json
   ```

4. Apply the same plan once the dry run reports `ready: true`:

   ```sh
   node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --retire /etc/subscription-runtime/job-retirement/<plan>.json
   ```

   The result names the receipt `<stateDir>/job-retirements/<planSha256>.json`,
   every tombstone and, for a workstream, `<stateRoot>/retired.json`. Hand the
   receipt to the host tool's retention run; it re-checks references and mounts
   before it deletes anything.

## What is checked

Inside the maintenance fences (the workstream state root and the controller
job root for MiMo; every project controller of the registry for one job), for
every job:

- the manifest bytes equal the plan's digest, the job root is not inside its
  registry entry, and the workspace is where the layout puts it;
- root runs `git status`, `git diff` and plumbing in the workspace, so before
  Git first runs there: the workspace, its `.git`, the Git and common
  directories and every configuration file Git reads there can be changed by
  root alone (root's, no link, no group or other write); `.git`, a linked
  worktree's `commondir` and its `gitdir` back link agree, and Git must later
  report the same directories; the configuration, as `git config --file
  --list` itself reads it, sets no key that runs a program or loads more
  configuration (`filter.*`, `diff.<driver>.textconv` and `.command`,
  `diff.external`, `merge.<driver>.driver`, `include.*`, `includeIf.*`,
  `submodule.*`, `hook.*`, `pager.*`, `credential.helper`, `gpg` programs,
  tool commands, `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`,
  `core.gitProxy`, `core.askPass`, `core.pager`, `core.editor`) or changes which
  files and edits status sees (`core.worktree`, `core.excludesFile`,
  `core.attributesFile`, `core.sparseCheckout`, `core.ignoreStat`)
  (`git_config_unsafe`); there is no `.gitmodules`, no `modules` directory and
  no gitlink in the index (`git_submodule_present`); and no index entry is
  assume-unchanged or skip-worktree, which would hide an edit
  (`git_index_masked`). Git itself runs without system or global configuration,
  hooks, fsmonitor, external diff, textconv, the attributes file, transports,
  lazy fetch, submodule recursion, a pager, replace objects or optional locks,
  and with full stat checks (`core.trustctime`, `core.checkStat=default`, no
  untracked cache, no split index). Status and diff never trust the stat data
  of the repository's index, which a writer of the index controls: they run on
  a private index in a fresh `0700` temporary directory, rebuilt from the staged
  entries (`ls-files --stage` into `update-index --index-info`) and refreshed by
  hashing every file. The repository's own index is only read;
- no other registered job of any of the three layouts and no other MiMo binding
  claims the unit (`workspace_shared`): its workspace or scratch root is not the
  same, inside or around it, and no other path it names, at any depth of its
  manifest, lies inside it (`deniedRoots` excepted). The unit's own jobs keep
  no state, credentials, logs or evidence inside it (`state_inside_unit`);
- terminal proof from explicit runtime records only, never from age: no
  `active.json`; `last-terminal.json` matching its start spec with inactive
  runtime and provider units; no `mimo-candidate.json` without
  `mimo-publication.json`; the prepared writer reader reports `released`; no
  `account-reservation.json`. A job without research run-state is either
  `runner-disposed` (last runner event of this job, nothing alive) or
  `never-started` (nothing a run leaves behind, no successful bridge Start, an
  unlaunched admission receipt if the job has an admission, a released or
  absent birth). A native start must belong to this exact manifest and
  workspace directory (device and inode);
- output proof: the named handoff packet is intact, has no quarantined entries
  and equals the current workspace byte for byte (HEAD, status, index and
  worktree patches, untracked files), or the workspace is clean; and no commit
  reachable from HEAD or `feat/<jobId>` (for a standalone clone: from any
  local branch) is missing from every remote-tracking ref (handoff packets
  carry no commits). A terminal preservation refusal is no output proof: its
  result carries `details.preservationRefusal` and the authenticated receipt
  in the start directory, never a packet, so retirement refuses the job
  (`handoff_missing`) and the workspace stays until the owner decides;
- each research pin is unmounted already or mounts exactly the directory its
  spec bound there;
- every record the plan will write is valid as its readers will read it
  (`record_invalid`), before the first one is written. For example a
  workspace path with a space cannot be named in a record.

For a MiMo workstream also: the binding digest, a closed route, no
`.controller-recovery.json`, the registry's job set equal to the plan's, every
bridge operation settled (published result, no running unit, no `.tmp`), every
`mimo-bridge-attempts` entry registered or a settled failed Create, nothing in
the scratch root but `source` and `workspaces/<known job>`, a clean source at
the binding commit without local-only commits or a stash, no worktree of the
source outside the unit, and no repository outside the unit that borrows its
objects through `objects/info/alternates` or is a worktree registered inside
it. The census reads every MiMo binding, every registered workspace of the
three layouts and every snapshot under `/srv/workers/mimo-project-snapshots`.
The source's own alternates are recorded in the tombstone.

## Effects and recovery

The effects run in this order, each an atomic exclusive record:

1. For MiMo, the durable guard `<stateRoot>/.job-retirement.json` naming the
   plan, published under the registry lock that job creation also checks it
   under, and the registry compared with the plan once more under that lock: a
   job is either published before the guard and refuses the run, or refused. From now on
   the job reader refuses every job of the workstream, the controller
   included (`codex_goal_job_retirement_pending`): the job loader, project
   Start, refill, manifest create and update, controller loading and runtime
   selection fail. Every bridge operation of the workstream that would take an
   activity lease fails with `mimo_project_bridge_retirement_pending`, and so do
   `--recover-controller` and `--reconcile-interrupted-create`;
   `--advance-source` refuses with `mimo_project_bridge_advance_retirement_pending`.
   The guard stays after the workstream is retired.
2. `terminal.json` (closed) for every job, controller last, with the current
   boot ID. From now on the job reader refuses the job (`codex_goal_job_retired`)
   for every operation that loads it; Status answers `retiring`.
3. The job's research pins in the host namespace are unmounted, never lazily. A
   busy pin refuses with `pin_busy` and stays mounted.
4. `retired.json` for every job; for MiMo then `<stateRoot>/retired.json`.
5. The receipt.

Before step 1 only the receipt directory `<stateDir>/job-retirements` may have
been created. The maintenance fences are released at the end, also after a
failure: the guard and the closed records, not the fences, keep the unit
closed. Recover by replaying the exact same plan. Every step verifies what is
already there; fences left by a killed process are recovered; a closed native
job is checked against the exact records its close was based on, every other
closed job is proven again in full; a completed plan reports `alreadyRetired`
and writes a missing receipt from the records alone. A different plan for a
unit with records is refused (`record_conflict`). If a tombstoned workspace is
no longer the recorded directory the replay refuses
(`tombstone_identity_mismatch`); investigate before anything is deleted.

A retirement that has not closed any job yet can be withdrawn with the same
plan, for example when its replay keeps refusing for a reason that will not go
away soon:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --retire --cancel /etc/subscription-runtime/job-retirement/<plan>.json
```

Under the same fences it removes the guard of exactly this plan and reopens the
workstream (`{ ok: true, cancelled: true }`). Once any job has a closed or
retired record, or the workstream tombstone exists, cancel refuses
(`retirement_pending`): finish the retirement by replaying the plan.

A reboot between the close and the replay wipes the native run-state on the
`/run` tmpfs. The replay then accepts a closed native job without run-state
only when the boot ID differs from the one in its closed record: nothing of
the closing boot, a provider unit or a pin, can still exist. In the same boot,
missing run-state is refused (`terminal_unproven`).

## After retirement

- Bridge Status and Stop of a listed job return `{ ok: true, state: "retired",
  retirement: { ... } }` from the tombstones without a lease, an owned unit or
  a routed runtime. Create, Start, repairs and unknown jobs of a retired
  workstream fail with `mimo_project_bridge_workstream_retired`.
- Local `codex_goal_status`, project Stop and generic Stop answer `retired` (or
  `retiring` for a closed job) from the registry records, project Stop before
  it loads the controller. The job reader owns the effect guard: Continue,
  project Start, refill, manifest create and update, runtime selection and every
  other operation that loads the job fail with `codex_goal_job_retired`. Only
  read-only projections opt in to read a retired manifest: the job list, the
  overview, admission, run observation, the relocation census, the generic
  scope guard (a retired controller's scope still denies generic tools), the
  writer observation and the job resource. Integrating a worker's reviewed
  output, and verifier support for it, load the worker for effects: finish
  them before retiring it.
- Admission reports a retired job without debt: the reviewed plan accounted for
  its output, and its workspace may already be gone. Its writer census counts a
  closed or retired job as released, since its pins may already be unmounted.

## Refusal codes

Every refusal is `job_retirement_<reason>`:

| Reason | Meaning |
| --- | --- |
| `plan_invalid`, `machine_mismatch`, `layout_unsupported`, `unit_must_be_workstream`, `controller_requires_workstream`, `controller_missing` | The plan or its target is not acceptable. |
| `binding_mismatch`, `route_open`, `recovery_pending`, `fence_busy` | The workstream is not in a state to retire (fence: an operation or lease is live; retry later). |
| `plan_jobs_mismatch`, `registry_entry_incomplete`, `manifest_mismatch`, `manifest_invalid`, `job_root_colocated`, `workspace_missing`, `workspace_outside_scratch` | The registry or a manifest differs from the reviewed plan or layout, or a workspace is not a repository. |
| `account_reserved`, `active_start`, `terminal_unproven`, `candidate_unpublished`, `writer_not_released`, `runner_not_disposed`, `worker_alive`, `never_started_unproven`, `output_kind_invalid` | Terminal proof is missing. |
| `operations_unsettled`, `attempt_unaccounted` | A bridge operation or Create is not settled. |
| `handoff_missing`, `handoff_invalid`, `handoff_incomplete`, `handoff_stale`, `workspace_dirty`, `branch_unpublished_commits`, `stash_present` | Work could be lost. |
| `worktree_outside_unit`, `alternates_referenced`, `alternates_unsupported`, `reference_census_incomplete`, `workspace_shared`, `state_inside_unit`, `scratch_unknown_entry`, `source_mismatch` | Something outside the unit depends on it, or the unit holds something it must not lose or does not expect. |
| `workspace_foreign_owner`, `git_config_unsafe`, `git_submodule_present`, `git_index_masked` | Root would run Git in a repository someone else can change, whose configuration names a program, which holds a nested repository, or whose index hides edits. |
| `git_limit_exceeded` | A Git run exceeded its 120 s or 32 MiB output bound, for example hashing a very large checkout; nothing was decided. |
| `pin_unexpected`, `pin_busy` | A pin does not mount its recorded source, or cannot be unmounted. |
| `record_conflict`, `tombstone_identity_mismatch`, `record_invalid` | Existing records belong to another plan, a tombstoned directory was replaced, or a record would not be valid for its readers. |
| `retirement_pending` | Cancel was asked for a retirement that already closed or retired a job. |

## Limits

- A workspace that was already deleted by hand cannot be retired with this
  command (`workspace_missing`); its Status stays broken until a separately
  reviewed repair.
- Research run-state lives on the `/run` tmpfs. After a reboot a native job
  that was not closed yet loses `last-terminal.json` and can no longer be
  proven `native-released`; retire finished native jobs before planned reboots.
- "Published" means reachable from a remote-tracking ref of the local
  repository. The command never contacts a remote, so a tracking ref forged by
  a writer with access to the repository is not detected. Local tags are not
  checked. Files Git ignores are not part of the output proof, as they are not
  part of a handoff packet. That includes files hidden by `.git/info/exclude`
  or by an untracked `.gitignore` that ignores itself: review those before
  planning `clean`.
- Jobs sharing a workspace retire together only when the planned outputs match
  the workspace for each of them: each job's handoff is looked up in its own
  sink under its own task ID, so a shared dirty workspace refuses for the job
  without a packet (`handoff_missing`).
- An intent-to-add entry (`git add -N`) appears as a staged empty file in the
  rebuilt index, so a handoff plan for such a workspace refuses
  (`handoff_stale`). Repositories with submodules cannot be retired
  (`git_submodule_present`).
- Cancel and replay resolve the plan's binding by its digest; if the binding
  changed after the guard was published, restore it before either.
- Only the guard step takes the registry lock. Manifest updates check the
  records under that lock, but an update racing the close of a job can still
  rewrite its manifest after the tombstone; the tombstone's `manifestSha256` is
  then stale, deletion is not affected. Generic Continue of
  a job outside a project registry holds no lease between loading the job and
  launching it.
- A retired MiMo workstream keeps its state root, so its project and
  workstream IDs cannot be prepared again (`--prepare-project` refuses an
  existing state root). Use a new workstream ID.
- This is not `codex_goal_project_retire_legacy_job_summary`, which only
  removes a legacy job summary from project admission.
- Pins are torn down in the initial host namespace only. Mount namespaces that
  inherited a copy keep it; the host tool's mount check finds them.
- Jobs started by an older runtime release are proven through that release's
  writer reader, which must still be installed.
- Free-space admission is separate: see the capacity section of
  [scratch storage](host-scratch-storage.md#host-policy).

## Architecture classification

The command is a fixed root operator feature of `worker-codex`, in
`src/worker-codex/job-retirement/`: its helpers are static, feature-local
dependencies with test seams for host effects, not composition nodes. It adds no
Core or Assembly handle and claims no consumer adoption. It was classified
against the Get Modular Consumer Module Standard,
`docs/architecture/common-assembly.md#consumer-module-standard` at
`2f33631b1c64df120f75af03526cf24d1b749a7f` (complete-document SHA-256
`e4a157b97a103fd1836d1a44bacaafab57eebdd7a6fcafb5e00d67bef680e20b`), which
applies to new composition boundaries inside an accepted Host scope; this
repository has none. The shared piece is the versioned record contract in
`host-integration/job-retirement/v1`, owned here and consumed by the host tool;
product policy (when to retire, deletion and its timing) stays with the
operator and the host tool.

## Migration

This repository has no changelog; this section is the migration note.

- New records in registry entries (`terminal.json`, `retired.json`), in state
  roots (`retired.json`) and receipts in `<stateDir>/job-retirements/`. Older
  releases do not read them; install a release with `--retire` as the bridge's
  current runtime before retiring anything, and keep it installed.
- Status and Stop of retired jobs now return `state: "retired"` instead of
  failing; callers that only checked `ok` see a successful answer.
- The host retention tool consumes `host-integration/job-retirement/v1` at a
  pinned revision.
