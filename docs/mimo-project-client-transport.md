# MiMo project client transport

The local MCP and CLI delegate configured MiMo project operations through the existing restricted Host Jobs transport. The host owner derives registry, controller, source, job, workspace, admission, account and credential paths from its private project/workstream binding. The client sends only the typed `MimoProject` identity and operation DTO. The shared MiMo key stays on the host.

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

Use `mimoProjectId` and `mimoWorkstreamId` with the ordinary tools:

- `codex_goal_project_create_job`: `jobId`, `promptBody`, exact enrolled `sourceCommit`, `confirmCreate: true`.
- `codex_goal_project_refill_worker`: the same identity, `promptBody`, `expectedSourceCommit`, `confirmRefill: true`. Remote refill accepts creation; observe its operation before starting.
- `codex_goal_get_job_status`: the same identity and `jobId`; no local registry path is needed.
- `codex_goal_project_start`: the same identity, `jobId`, `confirmStart: true`, after create settled successfully.
- `codex_goal_project_stop`: the same identity, `jobId`, `confirmStop: true`.

Create, start and stop return a pending owned operation. Inspect status until that operation settles; a pending operation or successful submission is not worker completion. A transport timeout is uncertain: inspect the same job instead of resubmitting. Caller paths, credentials, environment, commands, model/provider overrides and arbitrary tool names are refused. The ordinary OpenAI route is unchanged when the MiMo route fields are absent.

An installed, authenticated host endpoint and enrolled project binding are required. A local route file alone does not enable execution. Contained clients require their own authorized transport channel; do not expose host SSH credentials or the shared MiMo key to a worker to obtain one.
