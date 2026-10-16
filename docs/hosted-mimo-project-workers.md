# Registered project MiMo coding workers

Agents select MiMo through the existing `codex_goal_project_refill_worker` or `codex_goal_project_create_job` MCP tools. There is no separate credential argument or provider process to launch manually. The project broker reserves the account, verifies the registered manifest and launch-admission receipt, and submits the owned runtime/provider services.

For direct native broker calls on the Linux host as the initial root operator, set these provider fields alongside the usual project, controller, workspace, prompt and admission inputs. Remote agents using `mimoProjectId` and `mimoWorkstreamId` must use the narrower [MiMo project client DTO](mimo-project-client-transport.md); the host derives these provider fields, and the remote client rejects caller-supplied account, engine, cycle and prewarm overrides.

```json
{
  "modelBackend": "xiaomi-mimo-token-plan",
  "accounts": ["account-q"],
  "model": "mimo-v2.6-pro",
  "executionEngine": "app-server",
  "maxAccountCycles": 1,
  "prewarmOnStart": false
}
```

For newly created MiMo manifests, omitted model, engine and cycle count resolve to the values above; prewarm defaults to false. Explicit conflicting settings are preserved and rejected by the registered execution contract. Do not send `mimoAccounts`, credential environment variables, auth paths, custom process factories, report-mode overrides or lifecycle policy overrides. The trusted runtime derives its finite contained turn and structured report.

## Project authorization and host setup

The controller's `projectAccessScope.allowedAccountIds` must explicitly contain `account-q`. Existing scopes do not gain it automatically. A trusted operator can use `codex_goal_project_update_controller_scope` to preview and confirm an updated scope preserving its existing roots, project identity and other allowed accounts. Adding the shared MiMo slot checks only the root-owned credential metadata; it does not require a ChatGPT `account-q/auth.json` or expose key bytes. The worker's inherited scope and current admission receipt are validated again at launch and finalization.

The broker must run as the initial root operator on the Linux host with the exact installed runtime and fixed shared MiMo credential prepared by the supported host installation procedure. Namespace-local root, a local macOS MCP process and an unprivileged SSH session cannot submit this native route. Credential bytes are admitted independently at provider launch and delivered through the owned stdin frame. Do not copy them into a project, prompt, environment argument or account auth file.

This registered CodingV1 route is separate from global hosted activation. It does not activate MiMo controllers, child spawning or unowned ordinary MiMo launches. Hosts with conflicting installed global/managed authority continue to reject this research owner route. Only fresh registered launches with current admission authority are supported; unsupported continuation, checkpoint publishing and caller execution overrides fail before launch.

## Capabilities and completion

Fresh registered MiMo workers use the source-owned CodingV1 profile with exactly 64 goal turns. The independently authenticated origin and sealed process factory enable native shell, unified execution and code editing in the admitted workspace, so the worker can run project builds and tests. Managed public Internet access remains separate from filesystem and credential containment: host-private, loopback, link-local and metadata destinations are denied. The raw shared credential remains in the host-owned proxy, outside the provider process and workspace. Arbitrary MCP servers, apps, hooks, memory, delegation, recursive children and interactive input remain disabled. A caller-selected profile or tool flag does not authorize execution.

Each worker has one account cycle, one attempt, no account reconnect/prewarm/continuation (in-turn stream retries inside Codex, described below, are separate), and a finite task deadline. The registry owns the canonical durable handoff sink; callers cannot choose an external sink. Completion reconciles the same runtime/provider attempt and publishes the structured outcome plus the existing handoff artifacts. A partial or failed result remains partial or failed.

Use the existing project status and stop tools for the same registered job. A submission timeout is uncertain: reconcile its retained attempt before retrying. Never replace its job ID, remove its ownership records or launch an unmanaged replacement to work around uncertainty.

Dropped streams are retried inside the turn. The generated Codex configuration sets `stream_max_retries = 8` (Codex backs off 200 ms doubling, about 50 seconds in total per sampling request) and `stream_idle_timeout_ms` at the smaller of 10 minutes and the request budget. When the MiMo stream breaks mid-response, Codex rebuilds the request from its recorded history and attaches the outputs of tool calls that already ran, so tools are not executed again. Status may show `Reconnecting... n/8` warnings for a job that then finishes normally. `request_max_retries` stays 0 so the transport 5xx retry is not nested in the stream loop. A capacity 429 is proxied as 502 and is retried by the same loop: the refusal now arrives after about a minute and 9 requests, with the same classification as before. The idle timeout and the client reconnect grace are both 10 minutes on purpose; a retry that hangs ends at whichever fires first, and a single message that takes longer than the idle timeout to generate will hit it, because the proxy holds message text frames until the item closes. The job still has exactly one attempt: a turn that exhausts the stream retries fails and is continued as a new job from the preserved patch, never replayed. Each retry re-sends the prompt and history (extra input tokens) and uses one of the 256 proxy requests of the Start. Any failed request still invalidates the capacity-recovery proof, which fails closed. After a reconnect, any turn-scoped activity (tool items, deltas, token usage, diff or plan updates) clears the reconnect grace timer, so long tool-only work no longer ends in `codex_app_server_reconnect_timeout`.

### Shared current runtime and retained attempts

A retained native start that failed before submission can lack the durable handoff pin required by normal cancellation. Keep that start fenced; do not reconstruct pins, delete its active slot, or replay Start. The trusted native composition exposes `abortUnsubmittedRegisteredResearchLaunch` for this distinct case. It requires the exact retained start/spec/request and a process-local proof from a reviewed finite owner adapter that the original submitting service has terminated. Under the original controller, workspace, registry and job fences, it verifies that no runtime/provider submission or pin mount exists, publishes an explicit abort witness, and releases the matching active slot last. Its `abortedBeforeSubmission` result is reservation settlement, not a completed model task, a clean-workspace claim or a worker result. The compatible writer reader independently revalidates the retained witness and physical closure. This contract is not a serialized bridge operation; missing or uncertain owner evidence remains blocked.

Trusted routing activation uses the single root-private file `/etc/subscription-runtime/mimo-project-runtime-routing.json`. Schema 1 retains controller-origin routing. Schema 2 has exactly `schemaVersion: 2`, `legacyRuntimeDirectory`, `legacyArtifactSha256`, `currentRuntimeDirectory` and `currentArtifactSha256`. Both directories name immutable `/opt/subscription-runtime/releases/<40-character revision>` artifacts; the current directory must exactly match the protected `/opt/subscription-runtime/mimo-project-bridge-current` purpose pointer. This is host composition, never project YAML or caller authority.

Use the existing reviewed installation/activation procedure: qualify and install the common release, activate its purpose pointer, then compare-and-swap the protected routing metadata from the reviewed previous bytes to schema 2 with the matching artifact digest. Until schema 2 is published, the new bridge conservatively retains schema 1 behavior. Later releases require the same paired pointer/metadata transition; drift refuses operations until they agree. There is no per-project runtime installation or controller provenance rewrite.

With schema 2, new Create uses the common current runtime. Start may select current only with an exact protected no-first-effect birth, positively absent native and ordinary writer namespaces, and a fresh admission check. Before submission, it exclusively publishes a private exact-job origin intent in the fixed state-root `mimo-runtime-starts` depot. An uncertain pre-spec submission retains that origin. Status, Stop and retained Start use the protected native execution origin, then the exact intent, then original job birth or the qualified legacy baseline. An incomplete native namespace cannot fall back without an exact retained intent; an intent never grants writer release. Metadata, pointer, executable bytes and original authority witnesses are checked again before calls.

After an owned failed Start has settled, a trusted host operator can explicitly call `recoverHostedMimoProjectPreEffectStartIntent` with the exact job selection, prior intent and manifest SHA256, qualified schema-2 routing and its current metadata/pointer witness. Recovery requires a released compatible birth and absent native, ordinary and both lexical/physical first-effect namespaces under protected publication. It preserves the original intent bytes in private `mimo-runtime-starts/pre-effect-history` before publishing the current origin. It does not launch the model or alter admission, birth, execution or account state. Reconcile a transport timeout against the same intent and receipt; do not replay an uncertain Start. Any executed or unknown owner remains fenced.

An exact retained `protected_job_birth_publication_busy` Start can be explicitly submitted again with the identical request after its owned unit is cold, has zero PID, an empty cgroup and no queued job. The bridge rearms only when the current canonical controller, immutable binding, clean worker workspace at the configured source commit and original admission receipt still match, the receipt is `validated_not_launched` with zero launch authorizations, both compatible positive birth records remain intact, and account reservation, native authority, ordinary writer authority and both first-effect records are absent. It exclusively persists the proof and archives the old request, owner and result as the previous generation. The next owned unit revalidates the proof before invoking the unchanged normal Start handler. Unknown/consumed authority, another failure code or a partial rearm publication refuses recovery; it never deletes claims or births, rewrites admission or launches a provider from the proof itself.


For a never-launched job with a verified admitted input patch, the first-launch admission proof accepts an absent progress PID only while the prepared job remains free of execution artifacts. The exact patch receipt, ownership, workspace lease and staged bytes are still checked; this does not authorize continuation of an earlier attempt.

The current runtime reads compatible protected v1 birth witnesses under its own publication mutex. Native writer observations remain owned by the original runtime, prepared outside that mutex and rechecked through cold protected byte witnesses inside it. Existing scope, source, route and writer guards remain authoritative. Unknown provenance cannot be promoted to a fresh Start. Mixed controller/job origins still fail the existing controller-repair equality guard; this change does not authorize that repair or mutate old leases. Retained artifacts must remain installed until their attempts can be safely closed.

Deploy this capability only after exact-artifact native sandbox qualification and an uninstrumented real model Coding E2E, including native shell/build/tests, canonical handoff and owned shutdown. A TEST-only instrumented artifact does not qualify a production release. Run qualification only in newly allocated TEST projects, not existing user repositories. A standalone worker proof does not qualify the registered project broker, scope, reservation and finalization path; validate those boundaries separately with the exact deployed revision.

## Remote agents and the trusted bridge

A local macOS agent uses the configured project bridge rather than submitting native services locally. The bridge runs through the existing restricted `sr-transport` SSH ingress, with no remote shell text or caller-selected executable. Its finite operations are `create`, `start`, `status` and `stop`; creation and start are separate so an uncertain response can be reconciled against the same job.

The wire request contains `kind: "MimoProject"`, `schemaVersion: 1`, expected `machineId`, `projectId`, `workstreamId`, `operation` and `jobId`. Creation also carries bounded `prompt` text, an exact 40-character `sourceCommit`, and optional `thinking`, `reasoningEffort` and `ownedPaths`. Only Create/refill can narrow ownership through exact relative files or trailing-slash directories within the enrolled scope; omission inherits that scope. Start, Status and Stop reject these Create-only fields. Caller-selected host/workspace paths, controller IDs, environment, credentials, tool names, admission commands and executable arguments are refused.

The operator installs a root-owned protected purpose binding at `/etc/subscription-runtime/mimo-projects/<projectId>/<workstreamId>.json`, using these exact fields:

```text
schemaVersion: 1
projectId, workstreamId, machineId
routingEnabled
stateRoot: /srv/worker-state/mimo-projects/<projectId>/<workstreamId>
scratchRoot: /srv/workers/mimo-projects/<projectId>/<workstreamId>
registryRootDir: <stateRoot>/registry
controllerJobId: purpose-owned scoped controller in this protected registry
sourceWorkspacePath: existing source checkout within scratchRoot
sourceCommit: exact reviewed source commit
sourceRef: approved origin/<branch> resolving to sourceCommit
codexBinaryPath: installed absolute executable
taskTimeoutMs, appServerStartupTimeoutMs, operationTimeoutMs
admission: reviewed existing serial-builtin launch admission template
```

This is operator metadata, not an agent-supplied configuration bag. The admission template fixes ownership, packet paths, checks and execution policy before the agent requests work. The source checkout, controller, packet documents and project scope must already be onboarded and consistent; the bridge does not invent them or initialize foreign registries. Move the binding forward with the `--advance-source` operation (see [Advancing the source of an enrolled workstream](#advancing-the-source-of-an-enrolled-workstream)) when the base commit moves forward; never edit it by hand. A change of the admission template alone at the same commit is not an advance (`mimo_project_bridge_advance_not_forward`) and needs a new workstream.

For this protected bridge, child creation validates the enrolled local snapshot's root custody, standalone Git metadata, exact HEAD/ref, clean checkout and complete objects. It does not fetch the private origin again. Ordinary project-control requests with `expectedSourceCommit` still verify the remote head; callers cannot select the bridge's local validation path.

The bridge checks actual workstream YAML identity and `routing_enabled`, both project/workstream disabled markers, machine identity and current controller account scope. It derives `<stateRoot>/jobs/<jobId>` and `<scratchRoot>/workspaces/<jobId>`, then calls the normal registered refill and launch APIs. Every creation retains a private request record before effects; reusing the job ID cannot repeat uncertain creation. Control operations accept only jobs created by this binding with the same paths, MiMo backend, account and project identity. Closing routing blocks creation/start while preserving same-job status and stop.

Deployment must install the matching root-owned bridge CLI from the exact runtime release and upgrade the restricted endpoint. Merely configuring a local route or placing a project YAML on the host does not enable this bridge. Qualify the complete local-agent-to-root-to-provider route on a new TEST project before claiming it is deployed.

After project onboarding has created the purpose-owned scoped controller in the protected MiMo registry, source checkout and reviewed admission template, enroll it with the protected operator metadata file:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --onboard /etc/subscription-runtime/reviewed-mimo-binding.json
```

This root-only helper validates machine/workstream routing, current explicit account-q scope, protected runtime files and frozen source branch, then installs the binding once. It does not launch workers, widen scope, open routing or clone repositories. An existing binding is refused; a new base commit on the same repository and branch moves it with `--advance-source`.

Each bridge mutation runs in its own finite owned service. The endpoint returns a pending receipt quickly; poll status using the same job identity. Start is accepted after the retained creation operation has settled with a successful semantic result. Status/finalization also runs in an owned service, and a poll can return the last settled observation while scheduling a fresh one. A timeout or unresolved operation never creates a replacement service or job.

The trusted admission template's `contract.executionPolicy.sandboxRoot` must be a strict subdirectory of `sourceWorkspacePath`, for example `<source>/sandbox`. For each child the bridge preserves that relative subdirectory under the derived child workspace. Other admission fields remain unchanged, and the normal admission validator runs for that child's actual workspace; this supports multiple jobs without widening the sandbox.

MiMo authority and durable state use the dedicated root-owned `0700` namespace `/srv/worker-state/mimo-projects/<project>/<workstream>`: controller registry, job state, retained attempts and operation ledgers all live there. Provision its protected parents through trusted operator onboarding, without changing ownership or permissions of `/srv/worker-state/jobs`. The existing project YAML retains its canonical `state_root: /srv/worker-state/jobs/<project>/<workstream>` as routing metadata; the bridge checks that fixed value but never treats that shared ancestry as authority. Workspace/source paths use the separate root-owned `0700` namespace `/srv/workers/mimo-projects/<project>/<workstream>`. The YAML keeps canonical `scratch_root: /srv/workers/jobs/<project>/<workstream>` as routing-only metadata. Shared project scratch ownership remains unchanged; only protected MiMo ancestry can contain source/workspaces and admission sandboxes. A controller from a shared registry cannot be reused by changing the binding path; create an explicitly scoped purpose-owned controller in the protected registry through the normal project API.

## Preparing an existing project without launching work

For an already configured, enabled project/workstream, the initial root operator can prepare a fresh MiMo controller and isolated source from a reviewed local snapshot:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --prepare-project /etc/subscription-runtime/reviewed-mimo-preparation.json
```

The protected JSON plan has exactly `schemaVersion: 1`, `binding` (the complete binding above), `sourceSnapshotPath`, `repositoryKey`, `repositoryUrl`, `workerJobPrefix`, `authRootDir` and `commitIdentity: {name,email}`. The repository key/URL, approved branch and exact source SHA must match the existing root-owned workstream YAML. Preparation supports GitHub repositories only, using `https://github.com/<owner>/<repo>` or `git@github.com:<owner>/<repo>`, with optional `.git`; other hosts and URLs containing credentials are refused. The local snapshot must have protected root-owned ancestry, a clean checkout at that exact SHA, and the matching origin remote/ref. Supply the existing root-owned account pool directory as `authRootDir`; no credential is copied. `workerJobPrefix` is an explicit lowercase prefix ending in `-`.

The snapshot must already contain the reviewed, tracked controller/lane packets and mandatory documents/scripts/fixtures named by `binding.admission`, plus its actual sandbox directory. Canonical/base/phase source SHA fields must match the enrolled commit. Missing proof is refused; the helper does not invent a launch packet or run its checks. The binding source path must be exactly `<scratchRoot>/source`, and template sandbox paths remain source-anchored as described above.

Preparation validates enabled routing and proof before creating fresh protected state/scratch roots. It clones only the reviewed local snapshot without hardlinks, freezes the exact commit/ref, creates the purpose-owned controller through the ordinary registry API with explicit account-q and derived project-only roots/prefixes, then invokes `--onboard`. The initial scope includes `<registryRootDir>/archives` and `<registryRootDir>/consumed-output-ledger`; the ordinary controller creation API establishes their custody. Preparation also establishes the private reviewed-output workspace lock ancestry. A freshly prepared controller therefore needs no subsequent scope repair. It never launches a model or tests on the project, changes an existing scope, opens disabled routing, or changes shared ownership. A retained `preparation.json` marks partial effects; existing roots/bindings are refused and require operator reconciliation rather than replay.

Finally install the matching MCP runtime and add the credential-free local transport route described in [MiMo project client transport](mimo-project-client-transport.md). The helper does not enable a global MCP server or distribute host authentication.

## Advancing the source of an enrolled workstream

A binding pins one exact source commit, and Create refuses any other. Bindings are never edited by hand. Until a runtime release containing `--advance-source` is installed on the host, a new commit needs a new workstream. Reuse one workstream per project and branch line: when the same branch has a newer reviewed commit, move the existing binding forward instead of preparing a new workstream. Use a new workstream for another branch or repository, a force-pushed branch (the move is forward-only), a wider ownership scope, or review/remediation work whose admission differs; the admission template (packets, review kind, lane, phase, checks) is fixed per binding and Create can only narrow `ownedPaths`. A reusable line uses a generic admission: `AGENTS.md` (or `README.md`) as both packets, `reviewKind: implementation`, one fixed lane/phase/packet revision, broad `ownedPaths` and SHA-free `requiredChecks`; task instructions go into the prompt.

Refresh the reviewed snapshot first. The root operator never talks to the network and never runs Git inside a repository it does not own:

1. As an unprivileged user, fetch the branch anonymously over HTTPS into a staging clone and write an incremental bundle of `refs/remotes/origin/<branch>` that starts at the snapshot's current commit (`git bundle create <bundle> <current>..refs/remotes/origin/<branch>`).
2. As root, copy the bundle into a root-owned `0700` directory and run `git bundle verify` in the snapshot. Fetch the branch ref from the copied bundle into the snapshot with the same inert flags the bridge uses (`--no-replace-objects`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1`, no `HOME` configuration, `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= -c core.attributesFile=/dev/null -c fsck.skipList=/dev/null`) plus `-c transfer.fsckObjects=true -c fetch.unpackLimit=1 -c gc.auto=0 -c maintenance.auto=false`.
3. Move the snapshot's `refs/remotes/origin/<branch>` forward with a compare-and-swap `git update-ref <ref> <new> <current>`, then `git checkout --detach <new>`. The snapshot must end clean, with HEAD and that ref at the new commit.

The binding directory `/etc/subscription-runtime/mimo-projects/<project>/` must be root-owned `0700`, the same requirement the binding publication has; the operation checks it before any effect (`mimo_project_bridge_advance_binding_directory_invalid`). Then write the plan as a root-owned `0600` file in the root-owned `0700` directory `/etc/subscription-runtime/mimo-advance/`:

```json
{
  "schemaVersion": 1,
  "projectId": "<project>", "workstreamId": "<workstream>", "machineId": "<32 hex>",
  "expectedBindingSha256": "<64 hex of the current binding bytes>",
  "expectedSourceCommit": "<40 hex of the current binding sourceCommit>",
  "newSourceCommit": "<40 hex>",
  "sourceSnapshotPath": "<the refreshed snapshot>",
  "acknowledgedJobIds": [],
  "admission": "optional: a complete replacement template"
}
```

Without `admission`, the new template is the current one with its `canonicalSha`, `baseSha` and `phaseStartSha` set to the new commit. If a `requiredChecks` command contains the old commit or any 64-hex digest, the plan must carry an explicit reviewed `admission` instead (`mimo_project_bridge_advance_admission_pinned`). Review the dry run, then apply it:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --advance-source --dry-run /etc/subscription-runtime/mimo-advance/<plan>.json
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --advance-source /etc/subscription-runtime/mimo-advance/<plan>.json
```

The dry run changes nothing and prints the state, the would-be binding digest and every blocker. The operation refuses, before any effect, when: the binding digest or commit differs from the plan; the route is closed by anything other than the project or workstream `.route-disabled` markers, or a controller-recovery guard exists; the controller scope is no longer project-only with `account-q`; the snapshot is dirty, not at the new commit, has another `origin` URL than the source checkout, or holds a commit that is not a descendant of the old one or not on the branch; the new commit lacks a tracked packet, document, script, fixture, sandbox directory or `requiredChecks` working directory; the resulting binding would be larger than 64 KiB, which every binding reader rejects (`mimo_project_bridge_advance_binding_too_large`), or the receipt larger than 1 MiB (`mimo_project_bridge_advance_receipt_too_large`); or binding-dependent work is in flight. The last means a running Create, Start, Status, Stop, repair or finalize operation (a unit that has not yet taken its activity lease would otherwise meet the fence and stay unresolved; the operation waits for it and checks again once the fence is held), a Create that is unresolved, a created job whose Start has not launched successfully (a pre-launch or admission-denied Start cannot be rearmed after the commit moves), or an unresolved repair. Running provider workers do not block an advance: their worktrees, branches and Git access are untouched. A job in `acknowledgedJobIds` is exempt from all but the running-operation rule, loses its binding-dependent recovery, and is listed in the receipt. A job whose Create was made at another commit than the current binding was already stranded by an earlier advance: it needs no acknowledgement again and is listed as `staleJobIds` in the dry run and the receipt.

Under the workstream maintenance fence the operation fetches the new objects from the snapshot into the source checkout by ref name into a loose temporary ref, moves `refs/remotes/<sourceRef>` with a compare-and-swap, checks out the new commit detached, runs the same sealed-source check Create uses, replaces the binding (same key set, new `sourceCommit` and admission) and writes `<stateRoot>/source-advances/<old>..<new>.json`. It never runs `pack-refs`, `gc`, `repack` or `prune`, never touches job worktrees, `refs/heads/*`, the controller, the workstream YAML or other workstreams, and uses no network. An agent that polls Status often can keep a unit running at every check, so the advance may end with `mimo_project_bridge_advance_busy`; quiesce the line first with the project or workstream `.route-disabled` marker, which the advance tolerates, and retry. Bridge Create/Start/Status/Stop may report `controller_maintenance_fence_active` while the fence is held, which is a few seconds for a normal fetch and bounded by the Git timeouts (5 minutes for the fetch and 5 for the checkout) on a very large one; retry with backoff, nothing is persisted. Create with a superseded `sourceCommit` is refused with `mimo_project_bridge_source_mismatch` before its job ID is consumed, so pass agents the new commit from the receipt. Workers and checks must diff against the job's recorded `baseSha`, never `origin/<branch>`, because the source's remote-tracking ref moves.

If the process dies, or fails with an ordinary error after the first change to the source checkout (the fetch), its maintenance fence stays and keeps ingress and owned units closed (Create also fails closed through the sealed-source check while source, ref and binding disagree). A replay that finds the source already moved keeps the fence on any failure as well. The command line process exits after the error, so the fence it leaves is a dead one that the next advance recovers by itself. Replay the exact same plan; this is the only recovery and it needs no file edits, because the advance is forward-only and completes from every state after the fetch (fetched, ref moved, checked out, binding replaced, receipt missing), which the kill-and-replay test covers step by step: every step is additive or a compare-and-swap, a stale source `*.lock` is removed under the fence only when no Git process names the checkout, and replaying after completion reports `alreadyAdvanced`. A different plan is refused while source, ref and binding disagree. An interrupted checkout that leaves the source tree modified is refused (`mimo_project_bridge_advance_source_dirty`) for inspection instead of being reset. To recover, inspect `git -C <source> status` as the root operator, bring the tree back to a clean checkout of the old or the new commit by hand without touching job worktrees or branches, then replay the same plan. Refusals that happen before the first change (a dirty tree while HEAD and the ref are still at the old commit, a diverged ref, a running unit, a failed check) release the fence at once.

## Resources

The provider unit of a CodingV1 job has `MemoryHigh=7680M` and `MemoryMax=8G`; every other profile keeps `MemoryHigh=2G` and `MemoryMax=4G`.
Swap is disabled, `CPUQuota` is 200% and `TasksMax` is 512. The limit is shared by the provider runtime, Codex and every command the model runs.
Above `MemoryHigh` every process in the unit, Codex included, is throttled. A command that suddenly slows down sharply is near the limit: stop it instead of waiting.
The unit sets `OOMPolicy=continue`: at `MemoryMax` the kernel kills the largest process in the unit, which is not necessarily the command that crossed the limit.
Usually that is the heavy command, and it ends with exit 137 (usual, not guaranteed) that the model sees; the job keeps running.
If the killed process is Codex or the runtime itself, the job still fails.
Run heavy commands (type checks, builds, test runners) one at a time and split large inputs into batches.
`NODE_OPTIONS=--max-old-space-size=3072` limits Node tools only, not native binaries such as the TypeScript 7 `tsc`; type check one package at a time.
There is no per-project or per-line memory budget yet.

For operators: a job can use 8G in the provider unit plus 6G in the outer unit, and there is no per-host limit on parallel jobs.
Check `MemAvailable` before starting another job.

## Operator troubleshooting

On a Linux root host with scratch isolation enabled, the ordinary `codex-goal-cli` main entry can enter a private mount namespace.
Lifecycle commands in that namespace cannot satisfy the host MiMo initial-root namespace contract.
Use the [trusted hosted bridge](#remote-agents-and-the-trusted-bridge) in its finite owned initial-host-root service.
Do not bypass namespace checks with environment markers or edit reservations, leases or ownership records manually.

For a generation-zero Create interrupted before registration, an operator can explicitly retain a failed attempt through
`hosted-mimo-project-bridge-cli --reconcile-interrupted-create /absolute/private-plan.json` in a finite owned initial-host-root service.
The root-owned mode-0600 plan has exactly `schemaVersion: 1`, `machineId`, `projectId`, `workstreamId`, `jobId`,
`expectedBindingSha256`, `expectedOwnerSha256`, `expectedRequestSha256`, `expectedBootId` and `expectedInvocationId`.
The runtime derives the original unit and paths. It requires structured PID-1 timeout evidence for the same boot/invocation,
physical process and queue absence, unchanged builtin admission partials, and no manifest, birth, first effect or Start authority.
Missing proof refuses reconciliation; a collected unit or default systemd success alone is insufficient.
The canonical failure becomes settled only with its matching complete settlement receipt. Incomplete publication stays unresolved.
This preserves all partials and reports `project_control_interrupted_create_timeout`; it never replays Create, adopts a root,
permits Start or clears orphan debt. Preserve the original ID and receipts rather than replacing an uncertain attempt.

Status can mutate canonical state. With a retained candidate, it reconciles the same native/provider attempt,
publishes the canonical result and handoff, then releases the active reservation last.
Without a candidate, Status reporting native `terminal` does not prove writer release.
Use one qualified same-job Stop: the [registered cancellation contract](../src/worker-codex/research-launch-lifecycle.ts)
returns `cleanWorkspace: true` for a clean workspace without requiring a handoff packet.
The project adapter exposes `cleanWorkspace: "true"`; verify exact start/spec in `last-terminal.json` and absent `active.json`.
Keep the retained failure evidence; cancellation does not fabricate a candidate or successful result.

A bootstrap exit 70 before any provider can be a scratch admission failure.
Read only the [finite startup diagnostics](../src/worker-codex/research-launch-diagnostics.ts), including the volume role and available/required bytes.
Reserve the 5 GiB floor plus expected workspace/materialization cost, and recheck actual capacity immediately before Start.
Preserve the exact job/start/spec identity on failure or timeout; improved capacity does not authorize replay of an immutable Start.

For fresh enrollment, preload the reviewed source through the [protected snapshot preparation contract](#preparing-an-existing-project-without-launching-work).
Keep the exact source and prerequisite proofs; do not replace source preparation with a base64 seed embedded in the worker prompt.

## Recovering an unlaunched legacy controller

If a legacy controller reports `controllerWriterAuthority: unknown`, the initial root operator can use the bounded recovery command:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --recover-controller /etc/subscription-runtime/reviewed-mimo-recovery.json
```

The strict plan contains `schemaVersion: 1`, project/workstream/machine IDs, `expectedBindingSha256`, `expectedControllerManifestSha256`, `newControllerJobId` and the existing historical attestation fields, excluding `destinationWorkspacePath`. Its confirmation is `I attest complete never-run controller history through this recovery maintenance fence`. Evidence must be protected files with exact SHA-256; the operator must attest complete history, including custom/direct launches and state movement. Missing authority files alone do not establish that history. The replacement ID starts with the old ID followed by `-r`.

Recovery refuses registered children, prior controller execution authority or first effects, active/queued operations, successful mutation receipts, changed source or mismatched plan bytes. It closes ingress with an owned maintenance fence and durable recovery guard, creates a fresh controller through canonical job birth, archives the old registration under `registry/.project-control/superseded-controllers`, and changes only the binding's controller ID. Source, old job root, manifest bytes and retained attempts remain intact; the old controller's writer authority stays unknown. Both cold writer observers must report `released` for the replacement.

A partial transition remains closed. Reconcile or resume the same exact plan; do not submit a replacement plan or delete its guard. Controllers with previously launched child jobs need a separate reviewed migration or isolated workstream. Prepare and recover controllers using the release that will serve their admission: birth provenance is tied to the exact runtime artifact.

If creation was interrupted after the new job root appeared but before canonical manifest publication, exact-plan replay returns `mimo_project_bridge_recovery_reconciliation_required`. Keep the guard and old controller; further reconciliation requires operator review. Recovery never adopts that existing root or publishes an uncertified replacement manifest.

Preparation requires the owner identity exactly `iliya` / `iliyazelenkog@gmail.com`. Before privileged Git inspection it validates the complete local `.git` metadata tree, rejects linked/external Git stores and executable transport/include/filter configuration, and uses inert Git environment/flags that disable fsmonitor, hooks and inherited configuration. The source sandbox must be an actual directory represented by tracked files, and must still exist after clone; an empty or ignored-only directory is refused.

## Availability across projects

The capability applies to every enabled project enrolled through the protected preparation/onboarding procedure above. It does not silently enroll projects, widen existing controller scopes or override disabled markers. Install the exact qualified runtime and restricted ingress closure, enroll each project/workstream with its reviewed source and explicit account-q scope, then configure its local route. Agent requests use the ordinary Create/Start/Status/Stop tools; no credential, profile or shell argument is required. Legacy retained research Worker attempts remain compatible with their original eight-turn file-tool policy and are not Coding workers.

For future projects, use this same preparation and client-route procedure as part of trusted worker onboarding. Reuse an appropriate existing logical workstream; a new universal workstream name is not required. A closed legacy production flow stays closed. If a separate coding flow is needed, stage and review its own canonical manifest and enforceable isolated scope before enabling it. Reuse exact-artifact sandbox qualification evidence where its host and permission profile still match; project enrollment is not a reason to repeat model qualification on a real project. Source packets belong to that repository and exact commit. Updating the shared runtime does not fetch newer project source or require a project-specific SDK patch.
