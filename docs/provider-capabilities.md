# Provider Capabilities

This matrix describes the public implementations in this repository. A shared
interface does not imply that every provider/backend/control combination is
available. Check the selected adapter's capabilities; unsupported hard controls
must fail before provider execution.

| Capability | Codex | Claude | Entry point / limit |
| --- | --- | --- | --- |
| Single task execution | Available | Available | `agent-runtime-task-runner`; provider-specific authentication is required. |
| Encrypted local session custody | Available | Available | `store-local-file`; one host and one shared state root. |
| Bounded local worker pool | Available | Available | `worker-core` composed with `FileBackendCodexWorker` or `FileBackendClaudeWorker`. |
| Account diagnostics and capacity observations | Available | Available | `account-diagnostics`; provider quota semantics differ. |
| Run events and observation | Available | Available | Provider observation adapters feed the common read model; a read does not start or recover work. |
| Bounded `Goal` inside one task-runner call | App Server backend | Agent SDK backend | Protocol v2; each backend must enforce its requested tools, workspace and budget controls. |
| Claude Background backend `Goal` | Not applicable | Unsupported | Background supports `SingleRun`; it does not certify the same hard USD bound. |
| Durable task-runner logical thread | Available through the task-runner protocol | Available through the task-runner protocol | Protocol v3 persists execution/replay evidence; workspace fingerprints cover Git-visible effects, not ignored files or arbitrary filesystem state. |
| Durable `codex_goal_*` jobs and advanced project control | Main implementation | Partial parity | Provider-neutral observation/controller ports exist; complete executing-worker parity remains tracked by the accepted goal parity RFC. |
| OpenAI-compatible HTTP bridge | Available | No equivalent public bridge in this package | `openai-compatible-codex`. |
| Provider-native resume data | Codex thread/turn handles | Claude logical threads/transcript handoff | Handles and recovery semantics are provider-specific; do not interchange them. |
| Multi-host custody and HA | Requires external adapters | Requires external adapters | The local file backend and BullMQ adapter alone do not establish shared transactional authority. |

## Two Different Goal Surfaces

The task runner's `Goal` mode keeps continuation inside a bounded `run()` call.
Both Codex App Server and Claude Agent SDK implement that surface. The durable
job registry, goal CLI/MCP, prewarm, admission, verifier/refill and project child
workers are a larger platform. Its historical `codex_goal_*` names are retained
for compatibility, and full Claude execution parity is still a separate work
stream. Do not infer that parity from the existence of a Claude controller or a
provider-neutral watch endpoint.

## Source And Operational References

- [Public task runner and backend controls](agent-runtime-task-bridge.md)
- [Task-runner provider selection](../src/agent-runtime-task-runner/index.ts)
- [Codex worker exports](../src/worker-codex/index.ts)
- [Claude worker exports](../src/worker-claude/index.ts)
- [Provider runtime ports and registry](../src/worker-core/provider-runtime)
- [Goal provider parity RFC and planned slices](goal-provider-parity-rfc.md)
- [Local storage guarantees](backend-workers.md#local-storage-guarantees)
- [Adapter certification](adapter-certification.md)

Contract and fake-backed tests demonstrate the exercised behavior without a
provider account. Live certification additionally needs the intended CLI/SDK,
account, OS profile and disposable workspace; a passing unit suite alone does
not establish those external conditions.
