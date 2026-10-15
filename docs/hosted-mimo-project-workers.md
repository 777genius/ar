# Registered project MiMo coding workers

Agents select MiMo through the existing `codex_goal_project_refill_worker` or `codex_goal_project_create_job` MCP tools. There is no separate credential argument or provider process to launch manually. The project broker reserves the account, verifies the registered manifest and launch-admission receipt, and submits the owned runtime/provider services.

Set these provider fields alongside the usual project, controller, workspace, prompt and admission inputs:

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

Each worker has one account cycle, one attempt, no reconnect/prewarm/continuation, and a finite task deadline. The registry owns the canonical durable handoff sink; callers cannot choose an external sink. Completion reconciles the same runtime/provider attempt and publishes the structured outcome plus the existing handoff artifacts. A partial or failed result remains partial or failed.

Use the existing project status and stop tools for the same registered job. A submission timeout is uncertain: reconcile its retained attempt before retrying. Never replace its job ID, remove its ownership records or launch an unmanaged replacement to work around uncertainty.

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

The wire request contains only `kind: "MimoProject"`, `schemaVersion: 1`, expected `machineId`, `projectId`, `workstreamId`, `operation` and `jobId`. Creation also carries bounded `prompt` text and an exact 40-character `sourceCommit`. It accepts no paths, controller IDs, environment, credentials, tool names, admission commands or executable arguments.

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

This is operator metadata, not an agent-supplied configuration bag. The admission template fixes ownership, packet paths, checks and execution policy before the agent requests work. The source checkout, controller, packet documents and project scope must already be onboarded and consistent; the bridge does not invent them or initialize foreign registries. Update the binding through the trusted deployment procedure when the source/admission packet changes.

For this protected bridge, child creation validates the enrolled local snapshot's root custody, standalone Git metadata, exact HEAD/ref, clean checkout and complete objects. It does not fetch the private origin again. Ordinary project-control requests with `expectedSourceCommit` still verify the remote head; callers cannot select the bridge's local validation path.

The bridge checks actual workstream YAML identity and `routing_enabled`, both project/workstream disabled markers, machine identity and current controller account scope. It derives `<stateRoot>/jobs/<jobId>` and `<scratchRoot>/workspaces/<jobId>`, then calls the normal registered refill and launch APIs. Every creation retains a private request record before effects; reusing the job ID cannot repeat uncertain creation. Control operations accept only jobs created by this binding with the same paths, MiMo backend, account and project identity. Closing routing blocks creation/start while preserving same-job status and stop.

Deployment must install the matching root-owned bridge CLI from the exact runtime release and upgrade the restricted endpoint. Merely configuring a local route or placing a project YAML on the host does not enable this bridge. Qualify the complete local-agent-to-root-to-provider route on a new TEST project before claiming it is deployed.

After project onboarding has created the purpose-owned scoped controller in the protected MiMo registry, source checkout and reviewed admission template, enroll it with the protected operator metadata file:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --onboard /etc/subscription-runtime/reviewed-mimo-binding.json
```

This root-only helper validates machine/workstream routing, current explicit account-q scope, protected runtime files and frozen source branch, then installs the binding once. It does not launch workers, widen scope, open routing or clone repositories. An existing binding is refused; revisions use the trusted deployment procedure.

Each bridge mutation runs in its own finite owned service. The endpoint returns a pending receipt quickly; poll status using the same job identity. Start is accepted after the retained creation operation has settled with a successful semantic result. Status/finalization also runs in an owned service, and a poll can return the last settled observation while scheduling a fresh one. A timeout or unresolved operation never creates a replacement service or job.

The trusted admission template's `contract.executionPolicy.sandboxRoot` must be a strict subdirectory of `sourceWorkspacePath`, for example `<source>/sandbox`. For each child the bridge preserves that relative subdirectory under the derived child workspace. Other admission fields remain unchanged, and the normal admission validator runs for that child's actual workspace; this supports multiple jobs without widening the sandbox.

MiMo authority and durable state use the dedicated root-owned `0700` namespace `/srv/worker-state/mimo-projects/<project>/<workstream>`: controller registry, job state, retained attempts and operation ledgers all live there. Provision its protected parents through trusted operator onboarding, without changing ownership or permissions of `/srv/worker-state/jobs`. The existing project YAML retains its canonical `state_root: /srv/worker-state/jobs/<project>/<workstream>` as routing metadata; the bridge checks that fixed value but never treats that shared ancestry as authority. Workspace/source paths use the separate root-owned `0700` namespace `/srv/workers/mimo-projects/<project>/<workstream>`. The YAML keeps canonical `scratch_root: /srv/workers/jobs/<project>/<workstream>` as routing-only metadata. Shared project scratch ownership remains unchanged; only protected MiMo ancestry can contain source/workspaces and admission sandboxes. A controller from a shared registry cannot be reused by changing the binding path; create an explicitly scoped purpose-owned controller in the protected registry through the normal project API.

## Preparing an existing project without launching work

For an already configured, enabled project/workstream, the initial root operator can prepare a fresh MiMo controller and isolated source from a reviewed local snapshot:

```sh
node /opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js --prepare-project /etc/subscription-runtime/reviewed-mimo-preparation.json
```

The protected JSON plan has exactly `schemaVersion: 1`, `binding` (the complete binding above), `sourceSnapshotPath`, `repositoryKey`, `repositoryUrl`, `workerJobPrefix`, `authRootDir` and `commitIdentity: {name,email}`. The repository key/URL, approved branch and exact source SHA must match the existing root-owned workstream YAML. URLs containing credentials are refused. The local snapshot must have protected root-owned ancestry, a clean checkout at that exact SHA, and the matching origin remote/ref. Supply the existing root-owned account pool directory as `authRootDir`; no credential is copied. `workerJobPrefix` is an explicit lowercase prefix ending in `-`.

The snapshot must already contain the reviewed, tracked controller/lane packets and mandatory documents/scripts/fixtures named by `binding.admission`, plus its actual sandbox directory. Canonical/base/phase source SHA fields must match the enrolled commit. Missing proof is refused; the helper does not invent a launch packet or run its checks. The binding source path must be exactly `<scratchRoot>/source`, and template sandbox paths remain source-anchored as described above.

Preparation validates enabled routing and proof before creating fresh protected state/scratch roots. It clones only the reviewed local snapshot without hardlinks, freezes the exact commit/ref, creates the purpose-owned controller through the ordinary registry API with explicit account-q and derived project-only roots/prefixes, then invokes `--onboard`. The initial scope includes `<registryRootDir>/archives` and `<registryRootDir>/consumed-output-ledger`; the ordinary controller creation API establishes their custody. Preparation also establishes the private reviewed-output workspace lock ancestry. A freshly prepared controller therefore needs no subsequent scope repair. It never launches a model or tests on the project, changes an existing scope, opens disabled routing, or changes shared ownership. A retained `preparation.json` marks partial effects; existing roots/bindings are refused and require operator reconciliation rather than replay.

Finally install the matching MCP runtime and add the credential-free local transport route described in [MiMo project client transport](mimo-project-client-transport.md). The helper does not enable a global MCP server or distribute host authentication.

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
