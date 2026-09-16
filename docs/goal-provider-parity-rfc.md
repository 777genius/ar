# Goal Provider Parity RFC

Status: accepted (implementation in progress)

## Problem

The goal orchestration platform (goal MCP server, job lifecycle, project
control, continuation/resume, prewarm, account capacity) is Codex-first.
Claude participates only as a controlled controller brain through
`providerKind: "claude"` branches in three files. Claude cannot be a
first-class executable goal worker: no goal job lifecycle, no
continuation after quota/session interruption, no dependency
bootstrap/prewarm, no admission-gated project child workers.

The adapter half for Claude already exists and is production-shaped:
`FileBackendClaudeWorker` (control inbox, run artifacts, capacity
tracking, logical threads with transcript bundles),
`ClaudeRunObservationAdapter`, `claude-controlled-agent-provider`,
`rate-limit-telemetry`, and the bounded goal protocol in
`provider-claude/process/claude-agent-sdk-goal-protocol.ts`. What is
missing is the orchestration layer on top, and a composition layer that
selects providers through ports instead of `if (providerKind === ...)`.

## Decision

Extend the existing goal MCP server to be provider-neutral instead of
forking a parallel `claude-goal-mcp`. Providers are selected through a
registry of runtime adapters; Codex remains the default so existing
manifests, tools and tests keep their observable behavior.

Public MCP tool names (`codex_goal_*`) and bin names are kept
backwards-compatible. Neutral aliases may be added later as a separate
product decision; renaming is not part of parity.

## Target ports (worker-core/provider-runtime)

```ts
interface ProviderRuntimeRegistry {
  get(kind: RunEventProviderKind): ProviderRuntimeAdapter;
  supported(): readonly RunEventProviderKind[];
}

interface ProviderRuntimeAdapter {
  readonly kind: RunEventProviderKind;
  observation(): RunObservationPort;
  controlledAgent(): ControlledAgentProviderFactory;
  controllerProfile(): ControllerProfileFactory;
  accountReservation(): AccountReservationPort;
  prewarm(): DependencyPrewarmPort;
}
```

`RunObservationPort`, `ControlledAgentProviderPort`,
`ProviderEnforcementCapabilities`, `AccessBoundary`,
`ProjectAccessScope` and the integration ports in
`worker-core/integration/ports` are reused as-is.

Three ad-hoc branching sites migrate onto the registry:

- `codex-goal-project-controller-profile.ts` (4 branching functions →
  `ControllerProfile` methods);
- `codex-goal-mcp-project-controller-provider.ts` (`if/else` provider
  construction → `ControlledAgentProviderFactory`);
- `codex-goal-mcp-run-events.ts` (bespoke `watchClaudeRuns` with a
  divergent response shape → the shared `RunObservationService` over the
  registry).

## Manifest evolution

`CodexGoalJobManifest` gains an optional `providerKind`
(default `"codex"` for stored manifests) and provider-specific
configuration moves behind that discriminator over time. Manifest
schema stays backwards-compatible: existing on-disk manifests load
unchanged.

## Slices (one PR each, Codex behavior frozen by existing tests)

1. `provider-runtime` ports + registry in worker-core; migrate the three
   branching sites; unify run-event observation shape. No behavior
   change for Codex.
2. Project-control host access through ports: replace raw
   `execFile("git"|"df")` and direct `node:fs` in
   `application/project-control` with `GitPort` /
   host-command/filesystem ports already defined in core, removing the
   second git implementation. No behavior change.
3. Claude goal jobs: manifest `providerKind`, job lifecycle
   (create/start/status/stop) executing through
   `FileBackendClaudeWorker` + the bounded goal protocol; continuation
   after quota/session interruption through the existing worker control
   inbox and logical-thread handoff.
4. Claude capacity and prewarm: `AccountReservationPort` +
   `DependencyPrewarmPort` implementations backed by
   `file-backend-claude-capacity` and rate-limit telemetry; admission
   and refill accept Claude children.
5. Project-control generalization: admission/verifier/refill flows and
   MCP tools accept `providerKind` for child workers; oversized
   admission/reservation files are split only where the generalization
   touches them.
6. E2E: mirror every live Codex scenario with Claude as the executing
   worker (sandbox run, broken-auth rotation, quota continuation,
   command-policy bypass denial, raw-push denial, manifest liveness,
   controller starts real Claude child), plus HTTP transport coverage.
7. Docs: promote `claude-worker-pool-rfc.md` out of draft, add Claude
   goal operations runbook and agent quickstart, update
   `architecture.md`.

## Non-goals

- Renaming `codex_goal_*` MCP tools or bins.
- Cloning Codex-specific continuation edge-case fixes that encode
  app-server behaviors Claude does not have; Claude continuation is
  specified from the worker control inbox + logical thread model.
- Changing `agent-runtime-task-runner` (single-task CLI primitive;
  orthogonal to goal orchestration).
