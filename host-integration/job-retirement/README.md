# Job retirement host contract, version 1

The runtime owns the fact that a job is retired. The host retention tool in
`777genius/platform-infra` owns the physical deletion of workspace bodies. This
directory is the contract between the two. The runtime produces the records;
the host tool reads them and never writes them.

The operator command and its procedure are described in the
[job retirement runbook](../../docs/runbooks/job-retirement.md).

## Files

| File | What it is |
| --- | --- |
| `v1/schema.json` | JSON Schema 2020-12 of every record the runtime writes. Its four `$defs` documents are selected by their `schema` field. |
| `v1/layouts.json` | Registry roots and layouts and record paths. Patterns are anchored and use positional groups only, so Python `re` and ECMAScript read them the same way. `referenceCensus` is informational: the roots the runtime's own bounded census reads; it is not a scope for the host tool's checks. |
| `v1/fixtures/cases.json` | Conformance cases: every document file with its expected verdict, the deletion decisions, record locations and workstream coverage below. |
| `v1/fixtures/valid/`, `v1/fixtures/invalid/` | The documents the cases refer to. |

`schema.json` and `layouts.json` are generated from
`src/worker-codex/job-retirement/job-retirement-contract.ts`. A test fails when
they drift; regenerate them with
`UPDATE_JOB_RETIREMENT_CONTRACT=1 npx vitest run src/worker-codex/tests/job-retirement-contract.test.ts`.
Consume the directory at a pinned revision of this repository and record the
SHA-256 of `schema.json` and `layouts.json` next to the pin.

## Registry layouts

| Layout | Registry root | Scratch root | Unit |
| --- | --- | --- | --- |
| `project-workstream` | `/srv/worker-state/jobs/<p>/<w>/registry` | `/srv/workers/jobs/<p>/<w>` | one workspace and its jobs |
| `flat-workstream` | `/srv/worker-state/jobs/<w>/registry` | `/srv/workers/jobs/<w>` | one workspace and its jobs |
| `mimo-workstream` | `/srv/worker-state/mimo-projects/<p>/<w>/registry` | `/srv/workers/mimo-projects/<p>/<w>` | the whole workstream |

A job's workspace must be strictly inside the scratch root of its layout, or
the runtime refuses to retire it. Jobs sharing one workspace (a producer and
its verifier) are retired together, each with its own tombstone naming the same
directory. A MiMo workstream is retired as one unit: its
`source` checkout and every worktree under `workspaces/`.

## Records

All records are root-owned `0600` files in root-owned `0700` directories,
published atomically: the complete bytes are written and synced under a private
temporary name, then linked into place without replacing an existing file.

| Record | Path | Meaning |
| --- | --- | --- |
| Closed job | `<registry>/<jobId>/terminal.json` | Explicit runtime proof that the job is terminal and will never start again, with the boot ID it was closed in. For controllers and never-started jobs this is the only terminal record that exists. The runtime's job reader refuses the job for every operation that loads it; only read-only projections still read its manifest. |
| Retired job | `<registry>/<jobId>/retired.json` | The job's tombstone. Status and Stop answer from it alone. |
| Retired workstream | `<stateDir>/retired.json` | The MiMo unit's tombstone. Only this record names a scratch root. |
| Receipt | `<stateDir>/job-retirements/<planSha256>.json` | One per completed plan, with the digest of every record it produced. |

The terminal proof kinds are:

- `native-released`: the research start's `last-terminal.json` matches its spec,
  its runtime and provider units are inactive and the prepared writer reader
  reports `released`. The record keeps the digests of the spec and of
  `last-terminal.json`, because `/run` does not survive a reboot.
- `runner-disposed`: the last event of `<jobRootDir>/<taskId>.events.jsonl` is
  `runner_disposed`, no tmux session, progress process or app server is alive,
  and any ordinary writer authority is released.
- `never-started`: no research run-state, no events, progress or result file,
  no successful bridge Start, a pre-start admission receipt (if the job has an
  admission) that still says `validated_not_launched`, and a released protected
  birth or none at all.
- `controller-closed`: the MiMo controller holds no writer authority; it is only
  closed together with its whole workstream.

The output proof kinds are `handoff` (a durable handoff packet whose manifest
digest the reviewed plan names, re-verified against the current workspace byte
for byte) and `clean` (no change in `git status`). Ignored files are not part of
either: they are regenerable by definition. In both cases no commit reachable
from the workspace HEAD or `feat/<jobId>` may be missing from every
remote-tracking ref.

## Rules beyond the JSON Schema

`validateJobRetirementDocument` in the contract module is the reference
implementation. Each `reason` below appears in `cases.json`.

| Reason | Rule |
| --- | --- |
| `schema` | The document does not match `schema.json`. |
| `layout_unknown` | `registryRootDir` matches no layout. |
| `layout_mismatch` | The recorded `layout`, project or workstream disagrees with `registryRootDir`. |
| `workspace_outside_scratch` | A workspace or scratch root is not where its layout puts it. |
| `deletion_scope_invalid` | A per-job tombstone of a MiMo workstream must defer to the workstream tombstone; any other tombstone deletes its own workspace only. |
| `source_path_invalid` | A MiMo source is not `<scratchRoot>/source`. |
| `duplicate_job` | A workstream tombstone lists a job twice. |
| `role_terminal_mismatch` | Only a MiMo controller is `controller-closed`, and a workstream has exactly one. |

## Obligations of the host tool

1. Delete only the target of a valid tombstone found at its own path
   (`jobRetirementRecordLocationMatches` and the `locations` cases): the
   `workspace` of a retired job whose `deletion.scope` is `workspace`, or the
   `scratchRoot` of a retired workstream. A per-job tombstone with
   `deletion.scope: workstream` never deletes anything on its own. Several
   per-job tombstones may name the same workspace; delete it once.
2. Right before deleting, `lstat` the target. Delete only a directory that is
   not a symlink and whose device and inode equal the recorded ones;
   `jobRetirementDeletionVerdict` and the `deletion` cases define the outcome.
3. Re-run the host tool's own reference and mount checks across every
   `/proc/*/mountinfo`. The runtime unmounts the job's pins in the initial host
   namespace only; copies inherited by other mount namespaces may remain.
4. For a workstream, check that the `tombstoneSha256` of every listed job
   matches its `retired.json` (`jobRetirementWorkstreamCovers` and the
   `workstreamCoverage` cases).
5. Never delete or rewrite a registry, state root, binding, workstream YAML,
   durable handoff, closed record, tombstone or receipt.

## Versioning

The contract is at version 1 and follows the repository's MVP rule: a breaking
change ships as a new `schemaVersion` with a changelog note in the runbook and
updated fixtures in the same change, and the host tool moves with it.
