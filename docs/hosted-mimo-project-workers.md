# Registered project MiMo workers

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

This registered Worker route is separate from global hosted activation. It does not activate MiMo controllers, child spawning or unowned ordinary MiMo launches. Hosts with conflicting installed global/managed authority continue to reject this research owner route. Only fresh registered launches with current admission authority are supported; unsupported continuation, checkpoint publishing and caller execution overrides fail before launch.

## Capabilities and completion

The MiMo worker can read, search and edit files within its admitted workspace using bounded MCP tools. Native shell execution, arbitrary command execution, browser/network tools, delegation and project instruction loading are disabled. This means it can produce code changes and reports, but cannot run a build, tests or a shell itself. The orchestrating agent runs those checks through its separately authorized execution tools. The model endpoint remains the fixed MiMo token-plan endpoint.

Each worker has one account cycle, one attempt, at most eight goal turns, no reconnect/prewarm/continuation, and a finite task deadline. The registry owns the canonical durable handoff sink; callers cannot choose an external sink. Completion reconciles the same runtime/provider attempt and publishes the structured outcome plus the existing handoff artifacts. A partial or failed result remains partial or failed.

Use the existing project status and stop tools for the same registered job. A submission timeout is uncertain: reconcile its retained attempt before retrying. Never replace its job ID, remove its ownership records or launch an unmanaged replacement to work around uncertainty.

Run qualification only in newly allocated TEST projects, not existing user repositories. A standalone worker proof does not qualify the registered project broker, scope, reservation and finalization path; validate those boundaries separately with the exact deployed revision.

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
