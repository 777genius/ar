# MiMo project client transport

The local MCP delegates configured MiMo project operations through the existing restricted Host Jobs transport. The host owner derives registry, controller, source, job, workspace, admission, account and credential paths from its private project/workstream binding. The client sends only the typed `MimoProject` identity and operation DTO. The shared MiMo key stays on the host.

Configure `~/.config/subscription-runtime/mimo-project-routes.json` as an operator-owned regular file with mode `0600`, inside protected directories. Project and workstream names are lowercase identifiers. A route selects transport; it does not authorize a host project:

```json
{
  "schemaVersion": 1,
  "routes": [{
    "projectId": "test-project",
    "workstreamId": "test-work",
    "host": "configured-worker-alias",
    "machineId": "00000000000000000000000000000000",
    "socketDir": "/private/tmp/subscription-runtime-ssh"
  }]
}
```

Publish one reviewed route through the local operator command:

```sh
node /absolute/subscription-runtime/dist/worker-codex/mimo-project-client-cli.js --configure-route /absolute/reviewed-route.json
```

The input uses the same protected JSON schema above with exactly one route. Use the verified host alias, machine ID and owned authenticated socket directory from current inventory. The command publishes to `~/.config/subscription-runtime/mimo-project-routes.json`, preserves other entries, and makes an identical existing route a no-op. A conflicting entry or concurrent publication is refused; inspect the existing configuration instead of overwriting it. The command does not install credentials, open a host route or launch work. A new local installation needs protected configuration parents and an authenticated restricted Host Jobs endpoint first.

The shared catalog is bounded to 1,024 distinct project/workstream routes and 256 KiB of UTF-8 metadata. Publication uses compact JSON; exceeding either budget fails without replacing the existing catalog. Existing catalogs require no migration.

Use this command after trusted `--prepare-project` for both existing and future projects. Keep one entry per logical project/workstream and reuse that identity for subsequent jobs. Every agent using this local MCP configuration shares the same route catalog; adding project-specific SDK code is unnecessary.

Use `mimoProjectId` and `mimoWorkstreamId` with the ordinary tools:

- `codex_goal_project_create_job`: `jobId`, `promptBody`, exact enrolled `sourceCommit`, `confirmCreate: true`.
- `codex_goal_project_refill_worker`: the same identity, `promptBody`, `expectedSourceCommit`, `confirmRefill: true`. Remote refill accepts creation; observe its operation before starting.
- `codex_goal_status_by_id`: the same identity and `jobId`; no local registry path is needed.
- `codex_goal_project_start`: the same identity, `jobId`, `confirmStart: true`, after create settled successfully.
- `codex_goal_project_stop`: the same identity, `jobId`, `confirmStop: true`.

Hosted MiMo create and refill accept optional `thinking`: `true` maps to `reasoningEffort: "high"`, and `false` maps to `"none"`. Legacy `reasoningEffort` remains supported: `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; omitting both fields keeps `medium`. When both are supplied, the legacy value is preserved and must agree: `thinking: false` requires `none`, while `thinking: true` accepts any supported non-`none` effort. Contradictions are rejected before submission. The Boolean is normalized to reasoning effort in the shared MiMo wire parser; it is unavailable for ordinary local routes or start, status, and stop. The value is retained for that new job. MiMo treats non-`none` efforts as enabled thinking. See [MiMo Responses documentation](https://mimo.mi.com/docs/en-US/api/chat/responses).

Create, start and stop return a pending owned operation. Inspect status until that operation settles; a pending operation or successful submission is not worker completion. A transport timeout is uncertain: inspect the same job instead of resubmitting. Caller paths, credentials, environment, commands, model/provider overrides and arbitrary tool names are refused. The ordinary OpenAI route is unchanged when the MiMo route fields are absent.

## Loaded client compatibility

Installing a new client does not reload an existing MCP connection. Older sessions can retain schemas without `thinking`
and readers limited to 256 routes / 64 KiB, even when the installed publisher supports the current [shared catalog limits](../src/worker-codex/mimo-project-client-route-limits.ts).
Reconnect that MCP server through the supported client procedure and verify its loaded entrypoint and exposed tool schema.
Do not restart the desktop app or unrelated worker jobs to refresh this connection.
Before publishing route 257, or exceeding a loaded reader's byte budget, ensure every client using the catalog is compatible;
otherwise an older reader can reject the whole catalog. Keep the existing catalog until compatibility is established.
Until the refreshed schema exposes `thinking`, use the supported legacy `reasoningEffort` field; reconnecting never authorizes replay of an existing job.
For same-job Status reconciliation and candidate-free Stop completion, follow [operator troubleshooting](hosted-mimo-project-workers.md#operator-troubleshooting).

An installed, authenticated host endpoint and enrolled project binding are required. A local route file alone does not enable execution. Contained clients require their own authorized transport channel; do not expose host SSH credentials or the shared MiMo key to a worker to obtain one.

Fresh registered MiMo jobs use the trusted CodingV1/64 policy; callers cannot select profiles or turn budgets. A qualified deployment supports native code editing, shell execution and project builds/tests within the admitted workspace. This requires exact-artifact native sandbox and real model Coding E2E evidence, not a legacy eight-turn research Worker proof. Each enabled project/workstream must be enrolled by the trusted operator and have a matching local route; disabled routing stays disabled. Merely updating the local MCP or this route file cannot activate a host release.

Hosted MiMo Create/refill accepts optional `ownedPaths` to narrow the enrolled
admission contract for a fresh job. Use exact relative files or trailing-slash
directories, at most 256 unique entries and 48 KiB of JSON; each path is at most
4096 bytes; the complete wire request must fit the existing 64 KiB ingress budget. Every entry must be contained in an enrolled ownership boundary.
Omitting the field inherits the enrolled ownership unchanged. Control operations
reject it, and a same-job replay does not revise an existing admission.

The host replaces only the contract's `ownedPaths`: exact enrolled source SHA,
packets, mandatory documents/scripts/fixtures/checks, review kind and execution
policy remain inherited. Runtime computes the resulting workKey and validates
that contract before broker worktree/job creation. `candidate/*` is not glob
syntax; `candidate/` is authorized only if covered by the enrolled contract.
Paths outside enrollment require a separately reviewed enrollment. Ownership is
an admission and output claim, not OS enforcement of per-file writes.
