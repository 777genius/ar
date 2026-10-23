# Hosted MiMo project worker operations

Operator runbook for relaunching, probing and stopping hosted MiMo project jobs
through the installed project bridge on the Linux worker host. Runtime
semantics (admission, provider fields, stream retries, routing metadata) live in
[hosted-mimo-project-workers.md](./hosted-mimo-project-workers.md); the due-only
capacity refresh tool is
[codex-status-capacity-recheck.md](./codex-status-capacity-recheck.md). These
procedures are metadata-only: never paste provider secrets, credentials,
prompts, or model outputs into logs, tickets, or docs.

## Relaunching a bridge job under a new job id

`scripts/ops/mimo-project-bridge-relaunch.py` drives the installed
`hosted-mimo-project-bridge-cli.js` (override the path with `BRIDGE_CLI`, the
host machine id with `MACHINE_ID` or `--machine-id`). It reuses the previous
job's Create request envelope with a new `jobId` and enforces one non-obvious
ordering invariant: the workspace must not change while Start is in flight.

1. `create` and poll until the observation reaches `state: "settled"` with an ok
   result.
2. `start` and poll until `state: "settled"` (a `running` observation is only
   the unit report, not launch confirmation).
3. Confirm `<state-root>/<project>/<workstream>/mimo-bridge-operations/<jobId>.start.result.json`
   has `ok: true` and no error.
4. Only then stage the requested plan/reference files (`--plan-src` into
   `--plan-dest` inside the job workspace).

Staging earlier fails Start with
`project_control_workspace_state_changed_before_start` and the job never
launches. The tool also strips AppleDouble `._*` files after staging; they
otherwise pollute the workspace diff. Exit codes: `0` launched and staged, `3`
create failed, `4` Start not confirmed or staging failed.

## Account capacity gate

The worker-account capacity store gates MiMo launches per backend namespace (for
`modelBackend: xiaomi-mimo-token-plan` the account's `mimo-token-plan`
namespace). A provider limit writes `quota_limited`, then a cooldown
(`worker_account_capacity_time_to_reset_ms`) leads to a `recheck_due` phase.
Jobs without a capacity rechecker burn their single `maxAccountCycles` admission
attempt (`quota_recheck_unavailable`). Generic pool and quota status tools
report against other slot namespaces and do not touch the MiMo namespace. Never
hand-edit registry, lease, or store files.

Operator tools:

- `scripts/ops/mimo-account-capacity-clear.mjs` resets a stuck gate record
  through the store API (`tryClaimRecheck` with `Refresh`, then `resolveRecheck`
  with `Available`).
- `scripts/ops/mimo-account-capacity-state.mjs` dumps the current phase/capacity
  read-only.

Both default to `MODEL_BACKEND=xiaomi-mimo-token-plan`, `ACCOUNT_ID=account-q`,
and `POOL_DIR=/srv/worker-state/account-pools/live-codex-auth`, overridable via
env. Clearing the gate record does **not** clear provider-side quota: the first
provider request writes a fresh limit right back if the quota is truly
exhausted. Treat the clear as "remove our stale block", not "capacity is back".

## Quota block vs gate block

- Provider quota block: the job starts, reaches the provider, and dies on the
  first request with `codex_app_server_turn_error … 502
  {"code":"proxy_upstream_failed","upstream_status":429}` — the proxied refusal
  arrives after about a minute and 9 proxy requests, matching the stream retry
  behavior in [hosted-mimo-project-workers.md](./hosted-mimo-project-workers.md).
  The attempt journal shows `status=blocked reason=quota_limited` with
  `outputObserved: "false"`. Jobs of other projects on the same account fail the
  same way within minutes: the account is limited, not the job.
- Gate block: the job fails at admission with `account_unavailable` /
  `quota_recheck_unavailable` and never reaches the provider.
- A passing account quota live check covers a different quota counter than the
  MiMo route; it does not prove MiMo capacity.

## Probe cadence when quota-blocked

- At most one probe job per window: minimum 30 minutes apart, backing off to
  hours after repeated identical failures.
- After three identical provider-quota failures, stop probing and report. The
  unblock is one of: top up the purchased token-plan credits, re-login the
  account through device auth (it helps only if the limit is account-scoped), or
  wait out an hourly/daily window.
- `scripts/ops/mimo-quota-window-watch.py` passively scans attempt journals and
  exits with `WINDOW_OPEN` when a recent journal change shows observed output
  (`outputObserved` is serialized as the string `"true"`) or the last attempt
  status is `completed`/`succeeded`/`running` — any job getting that far means
  the account has capacity. Run it under `nohup`, probe once after it fires.
- Never substitute a different model to work around a MiMo quota block.

## Stopping a job

The bridge `stop` operation is protective: for a fresh live worker it returns
`project_control_fresh_worker_stop_denied` with the required state and a
`stopCommand` naming the exact tmux session. Execute that `tmux kill-session -t
<jobId>` command, then `pkill -f <jobId>` and verify no processes remain. The
job's `progress.json` may keep a stale `status: "running"` after the process
tree is dead — trust the process table, not the file.

## Hard rules

- MiMo models only on these routes; report the limitation instead of
  substituting another model family.
- Use the installed broker, controller and bridge APIs. No guessed command
  names, no manual registry, lease, or state edits.
- Never read or copy credentials (`auth.json`, `encryption-key.hex`).
- A successful job launch alone is not proof of completed work.
- Production service, data, or DNS changes need separate approval.
