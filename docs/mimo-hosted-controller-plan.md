<!-- Accepted planning revision a4. Independent gpt-6-astra xhigh review: CLEAN on 2026-09-30. Source SHA 00051adaf52b7cf243ec029140dd2808295c1110. -->

# MiMo hosted controller plan a4

This plan is pinned to source SHA **`00051adaf52b7cf243ec029140dd2808295c1110`** and uses **account-q**. It addresses review a3’s remaining HIGH finding by making one accepted child slot permit **one foreground goal-runner invocation, at most `maxGoalTurns` turn submissions, and no work past the grant’s absolute deadline**. This is a planning deliverable; no files were changed, tests run, jobs launched, or credentials read.

The controller remains one `mimo-v2.6-pro` process supervising **one active child at a time** from a finite grant. All later provisioning, launch, runtime, and end-to-end qualification must use **new disposable TEST projects**, never real user projects. No PR merge is in scope.

## 1. Preallocate authority before `ORDINARY`

While activation is `CLOSED`, the host operator creates the disposable project and a fixed number of child slots. Each slot fixes its child job ID, `<registry>/jobs/<jobId>` root, `<jobRoot>/workspace`, prompt path, profile, account-q binding, source SHA, and exact command, arguments, and cwd. The operator installs private grants and inventory, calls `enrollOrdinary()` for the controller and every child origin, and only then calls `resumeOrdinary()`. There is no live inventory mutation in `ORDINARY`.

A launch key durably claims one unused slot before prompt writing, checkout, manifest creation, or submission. Bounded task text goes only into the slot’s fixed prompt file; it cannot change the inventoried command or cwd. The dispatcher validates the private grant, materializes the workspace at the pinned source SHA, and records the separately built runtime artifact SHA. A partly materialized slot remains claimed for replay or reconciliation.

## 2. Bind and enforce the child’s complete runtime budget

The root dispatcher stores a versioned, private slot record binding the grant digest, approved `AgentRuntimeToolName` subset, `denyProjectInstructions`, edit boundary, **absolute task deadline**, positive integer `maxGoalTurns`, and these MVP settings:

- `maxAccountCycles: 1`
- `safeExecutionPolicy.maxAttempts: 1`
- `continuationMode: "disabled"`

The foreground bootstrap verifies that record against the actual ordinary process origin and fixed inventory tuple. It passes typed values through `CodexGoalRunConfig`, the production foreground CLI, safe executor, runtime factory, and app-server goal runner. Model supplied arguments cannot replace them. The factory builds the bounded workspace profile, sets `nativeToolSurface: "disabled"`, disables native environments, and passes the turn ceiling to the goal engine. Child workspace MCP tools remain separate from the controller’s three broker tools.

**Reject conflicting effective settings, not just conflicting inputs.** After defaults, profile, environment, CLI arguments, and executor policy have been resolved, the CLI and executor verify the three MVP settings, the single account-q binding, bounded tools, native-tool suppression, deadline, and `maxGoalTurns`. The factory verifies the options it actually constructs. Missing values, an effective five-cycle default, a higher derived attempt allowance, an enabled continuation path, or a different account fail before the child starts. Explicit conflicting flags or configuration fail rather than being silently clamped.

For a hosted MiMo child, the executor invokes the goal runner exactly once. `goal_slice_exhausted` is terminal for that child, and a retryable failure does not start another account cycle, attempt, thread continuation, or runner invocation. The owned child unit has no automatic restart. A crash or ambiguous turn submission leaves the slot failed or uncertain for reconciliation; it does not relaunch the foreground route. Any future design that enables retry must first add a durable child-wide remaining-turn allowance across all attempts.

At the actual app-server `turn/start` boundary, the runner checks a child-scoped counter **before** submission. It consumes one allowance before writing the request, so an ambiguous submission also counts. It must never submit turn N+1 after N starts, including when turn N leaves the goal unfinished. Reaching N produces a typed budget-exhausted result, closes continuation, and initiates cleanup. The one-invocation and no-restart rules make this counter a child-wide ceiling for the MVP; the ledger retains the configured limit and observed count for audit.

The grant’s absolute deadline is fixed when issued and is never renewed by a turn, account cycle, wait, replay, or controller restart. The dispatcher checks it before acceptance, materialization, and host submission. The foreground bootstrap, executor, and runner check it before each turn submission and after each event. The turn waiter receives **the lesser of its normal relative timeout and the time remaining to that same absolute deadline**; it cannot receive a fresh full timeout after time has elapsed. A monotonic elapsed-time bound within the process protects against a backward wall-clock change, while the absolute timestamp remains authoritative across processes. Clock inconsistency fails closed.

The dispatcher also retains a deadline timer and, for each owned runtime or provider unit, sets a nonrenewable systemd runtime limit no longer than the remaining grant time at that unit’s start. This bounds a stalled foreground process; the systemd limit is a stop mechanism, **not termination proof**. At deadline, new turns and tool calls are denied, an active turn is cancelled, and the dispatcher requests `terminateOwnedScope`. If expiry occurs before dispatch intent, it must first prove that no submission occurred. After dispatch intent, occupancy stays held until the receipt-backed termination or natural-completion reconciliation succeeds. A dispatcher failure fences dispatch and leaves uncertain records held; it does not authorize a replacement launch.

## 3. Give keyed launch one durable owner

Under the controller, workspace, and host fences, a root-controlled ledger records grant identity, key digest, canonical request digest, slot ID, account-q, source SHA, prompt digest, operation ID, predetermined host start ID and unit, absolute deadline, turn ceiling, effective-option digest, state, and generation.

Keys are unique within the immutable project, workstream, and controller identity. A changed request conflicts. Repeating a key returns the same slot and handles, including after completion or a lost response. Distinct accepted keys permanently consume the finite allowance. The ledger owns grant-local active occupancy and account binding; a shared account mode or expiring lease does not. Only one slot may be active or uncertain.

States are `claimed → materializing → prepared → dispatch_intent → submitted → running → stop_requested → terminal`, with `uncertain` for ambiguous effects. Persist and fsync slot binding and host correlation before submission. A prepared record may submit only after positively proving no dispatch intent occurred. Once intent exists, replay reconciles the **same** start ID and unit; absence, timeout, or exception cannot create a second submission. A proven failure before intent may release active occupancy while retaining the accepted key and slot. An uncertain submission never releases occupancy.

Submission acknowledgment returns operation and child handles promptly; foreground waiting occurs outside short locks. Operation files are sanitized ledger projections, never independent launch authority.

## 4. Make cleanup and restart depend on termination proof

Add `terminateOwnedScope(scope, startId, reason)` to the root dispatcher for controller providers and children. Under the common host fence it marks the scope terminating, rejects new runtime and provider starts, and closes dynamic tool calls. Provider creation persists a separate provider-unit reservation **before** systemd submission, correlated to the parent runtime start ID and actual creator cgroup.

Termination enumerates the retained runtime unit and every correlated provider unit. It stops only positively owned units, drains queued starts, waits a bounded period, escalates those units if necessary, and rechecks retained host, boot, supervisor, unit, and cgroup identities. Success requires proof that the creator cannot submit again, no systemd job remains queued for each unit, and every expected cgroup is empty. A surviving provider, collector error, deadline, changed birth, or missing correlation yields `termination_unresolved`; reservations and occupancy remain held.

On success the dispatcher fsyncs a root-only receipt containing scope and start IDs, parent and provider correlations, activation generation, proof digests, and outcome. This receipt is independent of a provider’s zero-exit event. Natural completion also reconciles separately reserved provider units before occupancy release. Budget exhaustion and deadline expiry use this same path; neither a local timeout nor a stop request terminalizes the child.

Permit a proof-backed `Reserved → Terminal` successor during `ORDINARY`, preserving immutable reservation fields and monotonic generation. Restarting the controller process requires the old controller provider’s termination receipt; active children retain their own reservations and occupancy. Dispatcher death fences dispatch and retains uncertain records. The MVP has no automatic dispatcher takeover.

Make `stopAppServerProcess()` fail on its ten-second timeout. Propagate unresolved hosted proof through driver disposal, controlled provider stop, and controlled-run startup; a returned `Failed` stop also blocks restart. Keep the previous run cleanup-pending or failed until reconciliation. Report readiness only after app-server initialization and thread creation.

## 5. Preserve controller authority and admission

The model sees exactly **launch, observe, stop** as bounded dynamic tools. Dispatcher identity comes from retained controller process origin and the private grant, never a model supplied ID, registry path, or environment marker. Authorize opaque handles before reading target manifests. Launch accepts only key, approved profile choice, and bounded task text. Observe returns a small shared status and brief DTO. Stop returns `stop_requested` until proof-backed terminal state appears. Recovery is host-only.

Deny recursive controllers, raw shell/SSH/Git/tmux, arbitrary MCP and sockets, credential access, source or account override, installation, commit, push, and merge. Worker-side MiMo admission and independent provider-side origin validation must agree on exact identity, profile, and effective confinement. Compose MiMo named filesystem permissions with global-scan protection; keep hosted admission closed if either check fails.

Resolve the canonical MiMo key afresh for each authorized provider launch through the fixed host resolver. Require root-owned ancestry, `O_NOFOLLOW`, regular file, link-count, mode, and size checks. Register redaction first, inject the value only into the private provider environment, and write no `auth.json`. Never put the credential locator or value in commands, previews, configuration, operation files, logs, or artifacts.

The final hosted profile omits the existing project-control MCP subprocess and uses only the authenticated dispatcher channel. Existing nonhosted behavior remains available. **PRs 1–5 keep hosted-controller activation denied.**

## Qualification gates and PR sequence

Before implementation, retain both gates:

1. Confirm the installed app-server’s exact `thread/start.dynamicTools` and `item/tool/call` wire schema with pinned protocol material or a captured synthetic exchange. Prove one call through the client handler, including ID type, thread/turn binding, cancellation, response limits, and native-tool suppression. There is no shell, generic MCP, or `codex exec` fallback.
2. On new disposable TEST inventory, prove framed full-duplex traffic through the actual `systemd-run --pipe` path and both bootstrap handoffs. Prove acknowledgment while a child lives, bounded frames, retained origin binding, no descriptor inheritance by provider or child, and no reopening through `/proc`. A failed gate requires a separately reviewed transport design.

| PR, in order | Deliverable and focused acceptance | Estimated changed LOC |
|---|---|---:|
| **1 — `fix(mimo): prepare guarded hosted admission`** | Fixed credential resolver; controller and child admission; independent provider validation; effective configuration and scan checks. Activation stays denied. Test both readers, configuration actually used, doctor without auth files, rotation, and secret isolation. | **800–1,250** |
| **2 — `feat(controller): add authenticated dynamic tool transport`** | Qualified app-server handler, three-tool schemas, dispatcher origin binding, framed pipe. Calls remain disabled until lifecycle authority exists. Test malformed, duplicate, cancelled, foreign, and oversized calls with zero submissions; prove the synthetic pipe. | **850–1,300** |
| **3 — `feat(controller): enroll finite slots and bind child lifetime`** | Closed-phase preallocation and enrollment; immutable grant and slot records; fixed prompt paths; production bootstrap-to-runner bounded tools, single-attempt settings, turn gate, and absolute-deadline checks. **Run an intentionally unfinished goal through the actual foreground CLI and executor with small N. Capture every `turn/start` and prove N+1 never starts after slice exhaustion; inject a retryable failure and prove no second invocation, cycle, or attempt.** Test conflicting effective settings, the default five-cycle path, deadline expiry before and during a wait, bounded waiter time, denied native tools, credential isolation, and cleanup request. | **1,250–1,850** |
| **4 — `fix(project-control): own keyed occupancy and submission`** | Durable keyed ledger, one active slot, exact host correlation, acknowledgment separate from wait, replay and uncertainty, persisted lifetime binding. Test concurrent and terminal replay, crashes around intent and publication, no child restart or resubmission, and stop during wait. | **1,250–1,800** |
| **5 — `fix(custody): prove scoped termination`** | Provider-unit correlation, deadline stop timer and unit limits, dispatcher termination operation and receipt, proof-backed `ORDINARY` terminal successor, disposal and restart propagation. Test ten-second timeout, signaled and surviving providers, queued start, deadline exhaustion, child stop, controller restart, and dispatcher death. Prove budget and deadline exhaustion retain occupancy until receipt. | **1,300–1,900** |
| **6 — `test(controller): qualify disposable hosted lifecycle`** | New TEST harness, release guard composition, integrated evidence and rollback instructions. Activation becomes eligible only after all gates pass. | **650–1,000** |
| **Total** | Six sequential reviews; split any PR whose reviewed diff grows beyond roughly 2,000 lines. | **6,100–9,100** |

Run focused Vitest in each implementing PR, followed by typecheck, build, boundary checks, and applicable repository gates. PR 3’s foreground test must use the production CLI entry and executor configuration path; a fake app-server transport may record turn submissions, but no test-only configuration bypass may supply the lifetime settings. PRs 5–6 provide the host receipt and disposable runtime evidence.

PR 6 uses a **new disposable TEST project and private registry**. Preallocate and enroll before `ORDINARY`; record pinned source and separate artifact SHAs. Have one isolated-write child produce a harmless artifact. Replay its key concurrently and after a dropped response to prove one unit and submission. Restart only the controller process while that child runs. Launch a second approved child, stop it twice, and verify empty runtime and provider cgroups plus the retained receipt. Exercise cross-scope handles, recursion, account and SHA overrides, secret access, turn exhaustion, deadline expiry, timeout, and surviving-provider paths. Check canaries, `/proc`, descriptors, logs, previews, operation files, and artifacts with synthetic sentinel credentials. A **real MiMo dynamic-tool call through the production route** remains the release gate.

Rollback disables new grants and dispatch, stops only positively owned units, and retains manifests, ledger, operation records, and uncertain reservations for reconciliation. It does not use installation-wide close for ordinary child cleanup.

Deferred: dispatcher takeover, arbitrary child creation, live inventory mutation, shared-token quota scheduling, ReviewRouter migration, stored-job start, model-triggered recovery, guidance consumption, and PR merge. Future commits use conventional messages, branches without `codex/`, and author and committer `iliya <iliyazelenkog@gmail.com>`.

Plan revision completed in about 3½ minutes.
