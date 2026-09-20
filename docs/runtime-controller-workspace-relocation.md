# Idle controller workspace relocation

`codex_goal_project_relocate_controller_workspace` is a host administrator MCP
operation, also available through the generic `subscription-runtime-codex-goal
tool` CLI. It is deliberately absent from the controlled agent tool allowlist.
It changes only the controller manifest's `workspacePath` and `updatedAt`.
It does not move files, retire registrations, relabel jobs, or alter scope,
evidence roots, accepted reviews, consumed-output records, or job identity.
A controller with authoritative creation history and no previous run is eligible.
Legacy absence of run files alone is insufficient.

The destination must already be an existing, non-bare Git repository/worktree
with a commit and clean Git status (including untracked files and submodules),
inside the controller's existing writable workspace scope. Both workspace
identities are canonicalized and revalidated. Symlink escapes, denied/auth/
registry destinations, and any registered destination collision are rejected.
An empty remote allowlist remains a deny-all list.

## Parent review and execution

Use the built TEST checkout. Create a preview argument file using the actual
registry, controller ID, and **already existing** destination selected by the
parent. For example, `controller-relocation-preview.json` contains:

```json
{
  "registryRootDir": "/absolute/TEST/registry",
  "controllerJobId": "ar-assembly-secondary-controller",
  "workspacePath": "/absolute/TEST/existing-clean-controller-workspace"
}
```

The exact supported preview command is:

```sh
node dist/worker-codex/codex-goal-cli.js tool codex_goal_project_relocate_controller_workspace --args-file controller-relocation-preview.json
```

Preview still obtains all locks and checks current safety evidence. It returns
`reason: "confirm_relocate_required"` with a plan; it does not modify the
manifest or append a relocation receipt. Copy the plan's exact
`expectedManifestSha256` and `oldWorkspacePath` into a reviewed confirmation
argument file, retaining the same registry, controller, and destination:

```json
{
  "registryRootDir": "/absolute/TEST/registry",
  "controllerJobId": "ar-assembly-secondary-controller",
  "workspacePath": "/absolute/TEST/existing-clean-controller-workspace",
  "expectedWorkspacePath": "/exact/old/path/from/preview",
  "expectedManifestSha256": "<64 lowercase hexadecimal characters from preview>",
  "confirmRelocate": true
}
```

After independent review, the exact supported apply command is:

```sh
node dist/worker-codex/codex-goal-cli.js tool codex_goal_project_relocate_controller_workspace --args-file controller-relocation-confirm.json
```

These are templates, not claims about an existing destination in production.
No production repair is part of the implementation task. The parent must
verify its actual selected destination and obtain independent review before
any eventual production use. Afterwards, inspect the fresh producer admission
snapshot against that actual workspace; preserving the completed reviewer at
the old workspace is intentional.

## Serialization and evidence

Lock order is the existing controller scope lock, the maintenance fence at the
**persisted `manifest.jobRootDir`**, sorted canonical old/destination workspace
locks, then the registry mutation lock. Registry paths and runtime job roots
may be different. Controller starts take an activity lease at that same job
root and reload the entire manifest before using it; a start loaded before a
completed relocation therefore rejects manifest drift even though scope did
not change. Registry creates and updates share the registry mutation mutex.
Updates resolve the activity root from the persisted manifest under that mutex.
Shared activity leases may nest inside broker operations. Relocation publishes
directly under its exclusive fence and registry mutex, avoiding an attempt to
reenter the update helper's activity lease.

Under the locks, relocation reads fresh worker status and controlled-agent
state, rejects live/stale/unknown observations and hosted providers, and uses
the existing fail-closed process inventory to reject legacy runtime writers
and processes using the involved workspace paths. Unreadable process evidence,
unknown owner identity, unavailable tmux observation, and stale run state require
investigation; absence of a live-looking status is insufficient. Previously
stopped controller owners that are still live are conservatively rejected.

Before publication, immutable `prepared.json` custody evidence binds the exact
before/after manifest hashes, controller/task/project identity, old/new canonical
paths, and unchanged scope hash. Volatile evidence is repeated after preparing
the receipt. The manifest is replaced using the existing synced atomic rename
helper. An immutable `applied.json` receipt follows. Receipts live under:

```text
<jobRootDir>/controller-workspace-relocations/<operationId>/{prepared,applied}.json
```

If final audit publication fails, the result explicitly says `applied: true`
and `controller_relocation_applied_audit_pending`; the prepared receipt remains.
Do not retry with a new hash to conceal that partial audit result. For process
crash or filesystem durability errors, compare current manifest bytes with the
prepared before/after hashes and investigate before further mutation. Locks
serialize supported runtime entrypoints; direct external filesystem edits are
not a supported administration channel.

## Separate remote-selection defect

`allowedGitRemotes: []` has no authorized canonical remote. For a local branch
such as `main`, `resolveCanonicalRemoteWorktreeSource` cannot select one and
returns `project_control_canonical_remote_ambiguous`. Explicit `origin/main`
is also denied; it is not a bypass. With an already authorized exact remote
such as `allowedGitRemotes: ["trusted"]`, use the exact `trusted/main` ref;
the existing canonical remote resolution then verifies the selected remote head.

Existing `update_controller_scope` deliberately treats `allowedGitRemotes` as
immutable. Consequently this patch does **not** provide a remote grant repair
for the existing empty list. Adding such a grant requires a separately reviewed
host-admin operation bound to an explicit trusted remote identity and the
existing scope. Relocation is not authority to grant a remote, choose a URL, or
replace an empty list with defaults or a wildcard. Do not edit production JSON
to work around that separate limitation.

## Correction to candidate 2cbe686e3db40c90ed9bf04dee0cda4d34a17e69

Relocation probes every persisted worker PID with signal 0 under the existing
locks. Only ESRCH proves absence. A live process, EPERM, invalid PID, or any
indeterminate error rejects, even if a display snapshot claimed it was absent.
Completed progress normally retains its PID; a real exited PID is eligible.

New controller registration records `.controller-state-origin.json` only when
it creates a fresh runtime root, before publishing the manifest. An existing
root is not certified. Start publishes `.controller-state-location.json` with
the canonical actual state directory under the activity lease, before provider
launch or controlled state writes. Publication uses the existing durable
no-replace JSON helper. Concurrent starts selecting different directories cannot
overwrite the winning reference; the losing start rejects. Subsequent starts
must use the same canonical directory. Provider state uses that canonical path.
Relocation reads the bound directory and also checks the default directory.
Missing/rebound bound paths, stale runs, unknown owners, and missing or mismatched
creation history fail closed. These metadata files do not change manifest fields
or existing audit/review/ledger records.

A legacy controller may still start with a bound location, but that binding does
not prove where older runs stored state. Default relocation still rejects missing
creation history. Do not manufacture an origin file.

The host-admin relocation tool accepts `historicalNeverRunAttestation` for this
specific legacy gap. This is a **new trusted administrator assertion**, not proof
inferred by the runtime. Parent must independently evaluate the retained launch
history and accept responsibility for its completeness before supplying it. The
implementation makes no claim that production history is complete.

Supply all fields from `controllerHistoricalAttestationSchema`: operator identity,
assertion timestamp, exact controller job ID and creation timestamp, current raw
manifest SHA256, scope SHA256 (SHA256 of JSON.stringify of the loaded scope),
canonical registry/jobRoot/source/destination paths, and retained evidence
references with SHA256 hashes. Confirmation must be exactly:
`I attest complete never-run controller history through this relocation maintenance fence`.
All five history assertions must be true: complete history from creation through
this operation's fence; no controller/provider/worker execution; coverage of
default/custom/direct/alternate-host launches; coverage of state movement/deletion;
and distinction between broker child workers and execution of the controller.
This assertion is not a general remote grant or authorization API.

Use the existing host-admin MCP tool `codex_goal_project_relocate_controller_workspace`
with `registryRootDir`, `controllerJobId`, the exact proposed `workspacePath`,
`expectedWorkspacePath`, `expectedManifestSha256`, `confirmRelocate: true`, and
that attestation object. The parent must fill truthful values from reviewed
retained evidence; there is deliberately no pre-signed production command here.
Missing relocation confirmation or invalid attestation rejects. A legacy preview
without the assertion continues to reject unresolved history.

Under the maintenance/workspace/registry locks, the operation validates every
identity field and records the actual maintenance fence acquisition cutoff. It
publishes a separate immutable `historical-attestation.json` receipt beside the
prepared/applied receipts, binding the assertion to the operation and exact
before/after manifest hashes. Revalidation follows publication. Existing audit,
review, broker event and ledger bytes remain untouched. Changed revision or
workspace requires a new assertion; a recorded start contradicts never-run even
if the provider outcome is uncertain. Any location binding, malformed origin,
known execution state, live/unknown/stale worker, dirty destination, collision,
scope or lock violation still rejects. Missing history is the only overridden
condition. References are administrator assertions; the tool does not infer
completeness from their contents or read credential files.

Start now performs pure launch and Codex auth-scope prerequisites while holding
the activity lease and before binding a directory. Failed preflight permits a
corrected-directory retry. Once provider construction may have effects, the
binding remains immutable even after failure; no catch block removes it.

Ledger epoch migration retains its exclusive controller maintenance fence through
scope publication. Its internal publication helper checks the fence token and
owning process at the persisted runtime root under the registry mutation mutex,
and requires the captured raw manifest SHA256. It changes only the active ledger
root and updatedAt, retaining unknown manifest and scope fields. This is not an
admin bypass option: ordinary updates still acquire activity leases and reject
maintenance contention. Existing migration admission, scope, audit and ledger
publication gates remain in force.
