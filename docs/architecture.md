# Architecture

The package is split by Clean Architecture boundaries. `core` defines ports and
runtime policy. Providers, stores, queues and runners are adapters.

Allowed dependency direction:

```txt
provider-codex -> core
provider-claude -> core
account-diagnostics -> worker-core types only
worker-core -> core
worker-local -> core
worker-codex -> core + provider-codex + worker-core + worker-local + store-local-file
worker-claude -> core + provider-claude + worker-core + worker-local + store-local-file
queue-core -> worker-core types only
queue-bullmq -> queue-core + worker-core
stores -> core
runner-github-action -> core
```

`core` must never import Claude, Codex, BullMQ, GitHub or file-system custody
adapters. Providers are sibling modules, not special cases inside `core`.

Managed `systemd-run` recipes are confined to the managed launcher, the trusted
custody launcher, and the exact dependency provider launcher adapter. The latter
requires a live host fence, retained origin, current Running owner and protected
provider reservation before synchronous submission into a finite root. Its TEST
qualification profile is opt-in; this exception permits no adjacent module or
request-selected systemd properties. Native qualification is a separate gate.

`account-diagnostics` is a provider-neutral application module. It owns the
status model, merge policy and cached capacity bridge, while Codex and Claude
diagnostic adapters live under their worker modules. See
`docs/account-diagnostics.md`.

`packages/agent-account-observability` is a separate DDD package for deeper
provider account facts such as Codex app-server rate-limit buckets and Claude
Code statusline quota snapshots. It reports facts only; scheduler policy stays
in `subscription-runtime`. See `docs/agent-account-observability.md`.

See `docs/pluggable-agent-runtime.md` for the proposed Claude, Codex and
multi-agent reviewer/tribunal architecture.

Agent Runtime (sibling repo) is the canonical contained-turn launch model.
Ordinary default there is user-session; contained-turn Host Custody is an
optional profile. Darwin sudo/seatbelt is a live-canary, not Desktop default.
This package is a protocol encyclopedia for that runtime, not a spawn template.

The names below are product history that is valid *here* and forbidden as a
contained-turn template *there*. Cite the IDs in reviews. Full write-up:
`/Users/belief/dev/projects/agent-teams-ai/agent-runtime/docs/architecture/subscription-runtime-port-candidates.md`
and
[agent-teams-ai/agent-runtime `docs/architecture/subscription-runtime-port-candidates.md`](https://github.com/agent-teams-ai/agent-runtime/blob/main/docs/architecture/subscription-runtime-port-candidates.md).

| Id | Anti-pattern | SR shape not to copy into contained-turn |
| --- | --- | --- |
| SR-AP-1 | Provider owns the process | Default Claude SDK spawn / provider `child_process` |
| SR-AP-2 | Silent second attempt | App Server → `codex exec` fallback |
| SR-AP-3 | Provider session as continuation | `resume` / `forkSession` / `persistSession`, Claude BG |
| SR-AP-4 | Process reuse across operations | Slot pool / prewarm |
| SR-AP-5 | Timeout becomes terminal | Timeout / `not_found` → failed / cancelled / retry |
| SR-AP-6 | Canonical project is the provider cwd | Hosted readonly mounts as provider workspace |
| SR-AP-7 | Privilege as the product path | host-jobs / systemd-run; Darwin sudo canary as Desktop default |
| SR-AP-8 | Second policy plane | `canUseTool` / goal MCP beside Runtime Security + Host |
| SR-AP-9 | God worker module | `src/worker-codex/` mixing MCP, control, hosted, ledger |
| SR-AP-10 | Filesystem job architecture | File-backend pool, tmux goal runner, ledger as operation store |
| SR-AP-11 | Orchestrator intents in the runtime enum | `ProjectScopedControl` / CreateJob as contained-turn commands |

See `docs/claude-worker-pool-rfc.md` for the original design background for the
implemented Claude Code backend worker pool, including prewarm,
capacity-aware slot selection and limit rotation.

See `docs/host-app-integration-strategy.md` for the cross-repository adapter
contract for `qa-rig`, `hib-pr-reviewer`, `quanta-pr-reviewer` and
control-layer apps.

See `docs/project-access-boundaries.md` for the provider-neutral worker access
model used to separate read-only observers, isolated workspace writers,
project-scoped coordinators and explicit full-access escape hatches.

See `docs/runtime-ddd-feature-architecture.md` for the balanced strict DDD,
Clean Architecture and feature-slice rules for complex runtime features such as
project-scoped control and policy-controlled integration rights.

### Retained nonqualified attempt disposition

Project Control also exposes a narrow root-admin adapter that retains custody of a
stopped original attempt whose terminal result is absent or genuinely failed, as a
dedicated `retained_nonqualified` terminal disposition with an immutable receipt.
It claims no approval, stop, result, output or qualification and authorizes no
replay; admission honors it only while the exact retained originals are unchanged.
See [retained-nonqualified-attempt.md](retained-nonqualified-attempt.md). It adds no
module boundary, SPI, graph node or runtime routing; the shared part is a small
receipt validator next to the terminal-output contract.

### Approved output archive disposition

Project Control exposes a narrow root-admin adapter for recoverable archival of an obsolete approved output through its existing terminal ledger and evidence custody. Original approval and source remain intact; archived does not mean integrated or rejected. See [the owning operation documentation](published-output-reconciliation.md#retain-an-obsolete-approved-output). No new module boundary, shared contract, graph node, schema migration or runtime routing is introduced.

The native terminal writer retains ledger/items descriptors through no-follow
publication and invokes its existing mutation guard after staging/fsync. The
archive adapter binds full first-consumption validation to that guard under the
source workspace lease. Result and progress observations use canonical custody
reads. The immutable decision note anchors receipt digest and archive identity;
a separate immutable checkpoint under the pinned evidence root binds interrupted
preparation. These are local IO and archive checks in the existing owners, with
no changes to shared terminal semantics or orchestrator policy.
