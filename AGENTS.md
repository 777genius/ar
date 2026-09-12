# AGENTS.md

## Architecture

- Keep Clean Architecture boundaries: core/domain code owns contracts and ports; transport, files, queues, CLI, MCP and provider details stay in adapters.
- For complex runtime features, follow balanced strict DDD with feature-sliced bounded contexts. See `docs/runtime-ddd-feature-architecture.md`.
- Prefer small focused modules over mixed orchestration files.
- Do not put orchestrator policy into runtime adapters. Runtime reports facts, normalized events and safety decisions; orchestrators decide what to do.
- Keep Temporal, JetStream, Redis, webhooks and file-system details out of `worker-core`; add them only through adapter packages/layers.
- Prefer shared runtime read models over duplicated status parsing in CLI, MCP, dashboard, daemons or orchestrators.
- When the destination is Agent Runtime contained-turn, refuse named anti-patterns `SR-AP-1` … `SR-AP-11` in `docs/architecture.md`. They describe this product's history, not a spawn template to copy.

## Type Safety

- Use strict TypeScript enums for provider/runtime/event discriminators instead of free-form strings.
- Do not model extensibility as `string` fallbacks like `"codex" | "claude" | string`.
- When a new provider, runtime status or event type is needed, add it explicitly to the enum and handle unknown legacy input through an explicit `Unknown` enum value or validation error.
- Keep JSON payloads sanitized. Never persist or print secrets, auth payloads, API keys, tokens, cookies or raw provider credentials.
- Treat provider model IDs as exact external identifiers. For GPT-5.6 Sol use
  `gpt-5.6-sol`, not `gpt-5.6`. Do not infer availability from a hardcoded
  list: use the Codex app-server `model/list` catalog for the active account.

## Git

- Use conventional commit messages.
- Do not use branch names with `codex/` prefix.

## Host Access

- Use `node scripts/ops/host-job-cli.mjs HOST MACHINE_ID SOCKET_DIR` with a JSON request on stdin for managed launches. Long-running work belongs to an owned service; respect the documented outer-job-only limitation.
- Direct SSH is limited to bounded read-only checks, status, and explicitly authorized installation/bootstrap. Reuse multiplex host aliases and combine independent checks in one bounded request.
- Never launch work using nohup, disown, setsid, or background shell children.
- A transport timeout is an uncertain result. Check status using the same jobId and expected machineId before taking further action; never create a replacement job blindly.
- Never blanket-kill sessions or unknown processes. Cancel only units whose persisted ownership has been verified.
