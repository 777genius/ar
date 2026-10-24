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
`hosted-mimo-project-bridge-cli.js` as root on the worker host (override the
path with `BRIDGE_CLI`). It reuses the previous job's Create request envelope
with a new `jobId` and enforces one non-obvious ordering invariant: the
workspace must not change while Start is in flight.

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
launches. `--plan-dest` must be a relative path inside the workspace. Because
the launched worker can already modify its workspace, staging opens every path
component without following symlinks and writes only a regular file. The tool
also strips AppleDouble `._*` files after staging; they otherwise pollute the
workspace diff.

```sh
python3 scripts/ops/mimo-project-bridge-relaunch.py <project> <source-job> <new-job> \
  --workstream <workstream> --plan-src /path/to/plan.md --plan-dest refs/plan.md
```

Use it only for a source job whose bridge Status is settled and terminal and
that failed before producing output (a provider quota block with
`outputObserved: "false"`, or a gate block at admission). It is not a way
around an uncertain or still-running job: reconcile that with same-job Status
as [hosted-mimo-project-workers.md](./hosted-mimo-project-workers.md)
requires. A job that produced a patch continues as a new job from the
preserved patch instead. The reused envelope keeps the original prompt and
`sourceCommit`; after the binding has advanced, Create fails with
`mimo_project_bridge_source_mismatch`. If the tool is interrupted, re-run it
with the same new job id, which re-polls the retained operations; never pick
another id to work around the uncertainty.

Before any bridge call the tool reads the source request and `--plan-src` and
checks that the request is a Create for the same project, workstream and
machine. The machine id defaults to `/etc/machine-id`; `MACHINE_ID` or
`--machine-id` asserts the expected host instead. Log markers per phase are
`CREATE_`/`START_` + `SETTLED_OK`, `SETTLED_FAIL`, `BAD_RESPONSE` or
`POLL_TIMEOUT`, then `STAGED`, `STAGE_FAILED` or `NOT_STAGING`, and a final
`EXIT` line. Exit codes: `0` launched and staged, `2` preflight refused
(nothing was submitted), `3` create failed, `4` Start not confirmed or staging
failed.

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

- `scripts/ops/mimo-account-capacity-clear.mjs` resets stuck gate records
  through the store API (`tryClaimRecheck` with `Refresh`, which does not wait
  for `recheck_due`, then `resolveRecheck` with `Available`). It repeats for up
  to 64 records until none remains or a claim or resolve is refused, and prints
  the `BEFORE`/`AFTER` state.
- `scripts/ops/mimo-account-capacity-state.mjs` dumps the current phase and
  capacity for the demand and account-wide (records of other models or
  efforts). It uses strict reads: an unreadable record fails the dump instead
  of being discarded.

Both read `ACCOUNT_ID` (default `account-q`), `POOL_DIR` (default
`/srv/worker-state/account-pools/live-codex-auth`), `MODEL` (default
`mimo-v2.6-pro`, with `high` effort and `default` service tier) and
`BRIDGE_DIST` (default `/opt/subscription-runtime/mimo-project-bridge-current/dist`,
the installed runtime the store is loaded from). The clear tool records
`OWNER_ID` (default `operator-recovery:$USER`) as the claim owner. Both are
pinned to `MODEL_BACKEND=xiaomi-mimo-token-plan` and exit `2` for any other
value: the ChatGPT namespace resolves account identity from `auth.json`, which
these tools must never read. Clearing the gate record does **not** clear
provider-side quota: the first provider request writes a fresh limit right back
if the quota is truly exhausted. Treat the clear as "remove our stale block",
not "capacity is back".

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
  the account has capacity. `--hours` (default 12) bounds the watch and
  `--glob` overrides the journal pattern. Both outcomes exit `0`, so read the
  last line (`WINDOW_OPEN` or `WATCH_END no-window`). Never detach it with
  `nohup`, `disown`, `setsid` or a background shell child (AGENTS.md, Host
  Access): run it in an attended foreground session, and give a longer watch
  an owned service. Probe once after it fires.
- Never substitute a different model to work around a MiMo quota block.

## Stopping a job

The bridge `stop` operation is protective: for a fresh live worker it returns
`project_control_fresh_worker_stop_denied` with
`requiredState: silent_stale_or_heartbeat_only_no_output` and a `stopCommand`
naming the job's exact tmux session. Stopping a healthy worker is an operator
emergency cancellation: run that `stopCommand` exactly as returned, then check
the process table for the worker's remaining processes. Never pattern-kill
(`pkill -f <jobId>` or similar): the job id is also in the command line of the
bridge's own owned operation units (`--execute-owned
…/<jobId>.<operation>.request.json`), and killing one leaves that operation
unresolved. Terminate a surviving process only after verifying that it belongs
to that worker. Then reconcile the job with same-job bridge `status` and
`stop` as described in
[hosted-mimo-project-workers.md](./hosted-mimo-project-workers.md). The job's
`progress.json` may keep a stale `status: "running"` after the process tree is
dead — trust the process table, not the file.

## Hard rules

- MiMo models only on these routes; report the limitation instead of
  substituting another model family.
- Use the installed broker, controller and bridge APIs. No guessed command
  names, no manual registry, lease, or state edits.
- Never read or copy credentials (`auth.json`, `encryption-key.hex`).
- A successful job launch alone is not proof of completed work.
- Production service, data, or DNS changes need separate approval.
