# Agent Runtime Task Bridge

Status: implemented

`@vioxen/subscription-runtime/agent-runtime-task` is the app-facing adapter kit for
systems that need to call a subscription-runtime worker without importing a
provider, worker, queue, store or runner implementation.

Use it for `qa-rig`, `hib-pr-reviewer` and control-layer apps when the host app
owns orchestration and wants a small JSON contract:

```txt
app adapter -> agent-runtime-task JSON bridge -> subscription-runtime provider/worker
```

The adapter layer must stay provider-neutral. Claude, Codex and future agents are
selected outside this package boundary through runtime configuration and
provider instance ids.

## Public Entry Points

```ts
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeTool,
  createAgentRuntimeTaskRequest,
  runAgentRuntimeTaskBridge,
  streamAgentRuntimeTaskBridge,
  assertAgentRuntimeTaskCertification,
} from "@vioxen/subscription-runtime/agent-runtime-task";
```

For JS/TS host apps that want an in-process local runner, use
`@vioxen/subscription-runtime/agent-runtime-task-runner`:

```ts
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
} from "@vioxen/subscription-runtime/agent-runtime-task-runner";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeResponseFormat,
  AgentRuntimeTaskKind,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/agent-runtime-task";

const runner = createLocalAgentRuntimeTaskRunner({
  provider: AgentRuntimeTaskProvider.Claude,
  stateRootDir: "/var/lib/agent-runtime",
  encryptionKey,
  workspaceRoot: "/workspace/repo",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  },
  authSource: {
    kind: AuthSourceKind.ClaudeOAuthToken,
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  },
});

const result = await runner.run({
  protocolVersion: 1,
  cwd: ".",
  timeoutMs: 120_000,
  task: {
    kind: AgentRuntimeTaskKind.StructuredPrompt,
    prompt: "Fix the failing unit test.",
    controls: {
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      responseFormat: AgentRuntimeResponseFormat.Text,
      toolPolicy: {
        allow: [
          AgentRuntimeTool.ReadFile,
          AgentRuntimeTool.EditFile,
          AgentRuntimeTool.WriteFile,
          AgentRuntimeTool.SearchFiles,
        ],
        deny: [
          AgentRuntimeTool.Shell,
          AgentRuntimeTool.WebAccess,
          AgentRuntimeTool.DelegateAgent,
          AgentRuntimeTool.WorktreeControl,
        ],
        onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
      },
      budget: {
        metric: AgentRuntimeBudgetMetric.Usd,
        limit: 2,
        onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
      },
    },
  },
});
```

### Continuous Goal execution

Protocol v1 is frozen as `SingleRun`. Protocol v2 requires an explicit
`execution` discriminator and never infers Goal from metadata:

```ts
const goalResult = await runner.run({
  protocolVersion: 2,
  cwd: ".",
  timeoutMs: 600_000,
  task: {
    kind: AgentRuntimeTaskKind.StructuredPrompt,
    prompt: "Implement every requirement in the bounded workspace.",
    execution: {
      mode: AgentRuntimeExecutionMode.Goal,
      completionCondition: "Every prompt requirement is implemented.",
    },
    controls: {
      maxTurns: 20,
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      toolPolicy: {
        allow: [
          AgentRuntimeTool.ReadFile,
          AgentRuntimeTool.SearchFiles,
          AgentRuntimeTool.EditFile,
          AgentRuntimeTool.WriteFile,
        ],
        onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
      },
      budget: {
        metric: AgentRuntimeBudgetMetric.WeightedTokens,
        limit: 100_000,
        onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
      },
    },
  },
});
```

`Goal` keeps provider-native continuation inside one `run()` call. Certified
backends are Codex App Server and the Claude Agent SDK. Codex uses native Goal,
native turn and rollout-budget bounds, provider-native tools disabled, and the
bounded-workspace MCP file surface. Claude maps the completion condition to its
native Agent SDK loop. A runtime-owned completion-report tool plus the native
`Stop` hook prevents a normal text response from completing the Goal before the
agent explicitly reports verification evidence. Claude also enforces native
`maxTurns`, `maxBudgetUsd`, an explicit tool allow-list, and workspace guards.
The Claude Background backend remains `SingleRun` only
because it cannot yet prove the same hard USD bound. Unsupported
provider/backend/control tuples fail before provider execution.

A v2 failure includes lifecycle evidence. `preflight_failed` is the only state
that can authorize a compatible transport fallback. `execution_failed` never
replays the task through another backend. `cleanup_unconfirmed` reports pending
provider process/session/tool-server authority and is always fail-closed.

Protocol v3 adds durable autonomous Goal continuation through a logical
`thread.id` and caller-stable `executionId`. Exact replay of a completed
execution is allowed only while its Git-visible workspace effect still matches
the durable receipt. That effect is defined as:

- the current `HEAD`;
- staged and unstaged tracked diffs;
- nonignored untracked paths, modes, file contents and symlink targets.

Git-ignored files and other filesystem state intentionally remain outside this
contract. Hosts must keep every task-relevant durable effect tracked or
nonignored; otherwise a change to ignored state cannot invalidate a replay.
The fingerprint is replay evidence, not a workspace snapshot or rollback
mechanism.

Logical-thread file locks are deliberately non-reclaiming. A process crash
leaves the thread busy until an operator reconciles the workspace and durable
execution record, then removes the orphaned lock. The runtime does not use a
time-based stale-lock takeover because it cannot prove that provider or
workspace side effects stopped, and automatic reclamation could duplicate
those effects.

The authorized live V3 certification harness uses only a fresh temporary Git
workspace and state root:

```bash
npm run e2e:live-agent-runtime-goal:codex
npm run e2e:live-agent-runtime-goal:claude
```

Each command performs two Goal executions with distinct `executionId` values
in one logical thread. The first prompt supplies a random context token without
writing it to disk; after the runner is disposed and recreated, the second
prompt must recover that token from provider-native context and write it to the
sandbox. Exact completed-result replay is then run with a trap worker whose
`start()` and `run()` methods fail, proving replay does not reach the provider.
The harness also verifies durable replay after restart, Git-visible receipt
invalidation and restoration, provider-checkpoint redaction, timeout/cancel
lifecycle probes, the exact workspace diff and an outside-workspace canary.
It requires `--allow-live` internally and must never be run against a real user
or Quanta project.

The module runner validates the request at the runtime boundary, so JS callers
and older TypeScript builds get the same protocol validation as the CLI. It does
not silently borrow the interactive Claude or Codex profile. Pass credentials
explicitly through `authSource`, or use
`AuthSourceKind.PreseededSession` when the durable
state already contains a session for the selected `providerInstanceId`.

Claude uses the Agent SDK backend by default. Native `maxBudgetUsd`, exact tool
availability and provider hooks enforce the hard task bounds. The OS sandbox is
enabled as defense in depth when the host platform supports it, but access
enforcement does not require privileged container namespaces. The legacy
background backend remains an explicit provider-specific option:

```ts
providerRuntime: {
  backend: ClaudeAgentRuntimeBackend.Background,
  runtimeDistDir: process.env.CLAUDE_RUNTIME_DIST_DIR,
}
```

For the CLI, select it explicitly with
`--claude-backend claude-background`; merely setting
`CLAUDE_RUNTIME_DIST_DIR` never changes the backend. The CLI default is always
`agent-sdk`.

Codex can override its binary with `providerRuntime.binaryPath`. Keep provider
runtime wiring in the composition root, not in review/fix business logic.

`toolPolicy.allow` and `toolPolicy.deny` use provider-neutral
`AgentRuntimeTool` values. The local runner maps them to concrete provider tool
names only after checking provider capabilities. If a provider cannot enforce a
hard policy, the result fails with `task_mode_unsupported` unless the request
explicitly asks for `onUnsupported: "warn"`.

Claude path-scoped tools reject lexical, nested, case-variant and
symlink-resolved `.git` metadata paths through both `canUseTool` and
`PreToolUse`, including when the requested path otherwise remains inside the
workspace. Git metadata changes belong to brokered integration controls, not
provider file tools.

`AgentRuntimeAccessBoundary.ReadOnly` constrains workspace mutation; it is not
an outbound-network boundary. `AgentRuntimeTool.WebAccess` remains a separate
explicit tool opt-in. Sensitive review workloads should omit it from an
allow-list or deny it explicitly.

For Codex, an explicit allow-list containing only
`AgentRuntimeTool.ReadFile`, `AgentRuntimeTool.SearchFiles`,
`AgentRuntimeTool.EditFile`, and `AgentRuntimeTool.WriteFile` is enforced by a
host-scoped bounded-workspace MCP server. Native shell, web, delegation, app,
and environment tool surfaces stay disabled, and the worker does not fall back
to a less constrained execution engine. Write tools additionally require
`AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite`. Other Codex tool policies
fail closed.

`controls.maxTurns` is a hard control, not an observability hint. The Claude
Agent SDK and background runtime enforce it provider-side. Codex Goal execution
maps it to the App Server's provider-native `maxGoalTurns` bound. Codex
SingleRun/session execution does not expose an equivalent per-task turn bound,
so `maxTurns` in that mode fails with `task_mode_unsupported`; use its native
weighted-token budget when another hard Codex execution bound is required.

`controls.budget` describes the bound for one `AgentRuntimeTask` execution. It
does not aggregate host retries or convert between metrics. Claude supports the
`usd` metric through its native `maxBudgetUsd` control. Codex supports
`weighted_tokens` through native App Server `rollout_budget`; the current
runtime profile weights non-cached input and output tokens equally. Before a
Codex task, the local runner probes `codex features list` for
`rollout_budget`; an absent feature follows `onUnsupported`, while an
unstartable probe reports `provider_runtime_unavailable`. A provider that
cannot enforce the requested metric therefore fails closed instead of being
approximated.

`AgentRuntimeTool.WorktreeControl` covers provider tools that move the agent into
a nested/provider-managed worktree, such as Claude `EnterWorktree` and
`ExitWorktree`. Hosts that already supply an isolated worktree should usually
deny this class so edits stay in the workspace the orchestrator owns.

If the selected provider runtime cannot be loaded, the runner returns a
structured failure instead of requiring host apps to parse error text:

```json
{
  "code": "provider_runtime_unavailable",
  "details": {
    "provider": "claude",
    "missing": "claude-runtime"
  }
}
```

The package also exposes two CLIs.

Handler bridge, for apps that already have a JS/TS handler:

```sh
subscription-runtime-agent-runtime-task --handler ./handler.mjs --input request.json
```

CLI output defaults to event NDJSON. Use `--format result-json` when the caller
only needs the terminal result.

Provider worker bridge, for apps that cannot import TypeScript runtime code
directly, e.g. Python `qa-rig`:

```sh
subscription-runtime-run-agent-runtime-task \
  --provider claude \
  --state-root /var/lib/subscription-runtime \
  --input request.json
```

This CLI reads the same `AgentRuntimeTaskRequest` JSON, runs it through
`worker-claude` or `worker-codex`, and writes the same result/event protocol.
Durable mode requires `SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY` plus provider
credentials such as `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON_PATH`.
`--ephemeral` is available for sandbox tests where the caller supplies a fresh
provider credential and does not need durable session state.

## Request Shape

```ts
const request = createAgentRuntimeTaskRequest({
  runId: "review-123",
  providerInstanceId: "claude:account-a",
  cwd: "/workspace/repo",
  timeoutMs: 120_000,
  task: {
    kind: "review",
    systemPrompt: "Apply the review rubric and return JSON only.",
    prompt: "Review this diff.",
    controls: {
      model: "claude-sonnet",
      accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
      responseFormat: "json",
    },
    metadata: {
      app: "hib-pr-reviewer",
    },
  },
  context: {
    application: "hib-pr-reviewer",
    purpose: "pull-request-review",
    correlationId: "gh-pr-24",
    round: {
      roundId: "tribunal-24-r2",
      roundIndex: 2,
      totalRounds: 5,
      member: {
        id: "critic-codex",
        adapterId: "subscription-runtime-codex",
        agentType: "critic",
        provider: "openai",
        model: "gpt-5.5",
        independenceGroup: "openai:gpt-5.5",
      },
      adversaryOf: {
        id: "advocate-claude",
        adapterId: "subscription-runtime-claude",
        agentType: "advocate",
        provider: "anthropic",
        model: "sonnet",
        independenceGroup: "anthropic:sonnet",
      },
    },
  },
});
```

Requests, results and events are JSON-safe and explicitly versioned. V1 accepts
only the existing one-shot shape and normalizes it to `SingleRun`; v2 requires
`task.execution`. A v2 result and every event remain v2, including early
failures. The bridge accepts provider-native task results/events and normalizes
them to agent-runtime-task JSON.

`task.systemPrompt` carries higher-priority reviewer, tribunal or output-format
instructions separately from the user/task prompt. Host adapters should use this
field instead of prepending system text to `task.prompt`, so providers that
support separate instruction channels can preserve that boundary. This field is
a host-controlled instruction channel; do not populate it from end-user input.

`context.round.member` is the portable identity for tribunal/quorum/adversarial
rounds. The runtime does not decide policy from it, but certification can prove
that a round member is independent from its adversarial counterpart by checking
both provider/model and `independenceGroup`.

## Handler Contract

A handler module can export `runAgentRuntimeTask`, `handler`, `default`, `runTask` or
`streamTask`.

```ts
export async function runAgentRuntimeTask(request, context) {
  await context.emit({
    protocolVersion: 1,
    type: "text_delta",
    occurredAt: new Date().toISOString(),
    text: "working",
  });

  return {
    protocolVersion: 1,
    status: "completed",
    outputText: "done",
    warnings: [],
  };
}
```

For streaming adapters, prefer `streamAgentRuntimeTaskBridge` so the host can consume
events before the terminal result is available.

## Certification

Use certification in adapter tests before connecting a host app:

```ts
assertAgentRuntimeTaskCertification({
  request,
  result,
  events,
  forbiddenSecrets: [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""],
  requireRoundMemberIdentity: true,
  requireRoundMemberIndependence: true,
  requireTerminalEvent: true,
});
```

Certification checks protocol validity, completed-event consistency, event
ordering, optional round-member independence and output secret redaction. It
intentionally does not scan the request body because prompts can contain
sensitive review evidence by design.

## Boundary Rule

Apps using this bridge should import `@vioxen/subscription-runtime/agent-runtime-task`
or a host-local adapter wrapper. They should not import:

- `@vioxen/subscription-runtime/provider-*`
- `@vioxen/subscription-runtime/worker-*`
- `@vioxen/subscription-runtime/queue-*`
- `@vioxen/subscription-runtime/store-*`
- `@vioxen/subscription-runtime/runner-*`

Provider selection belongs in runtime wiring, not in app review logic.

For the cross-repository rollout plan, see
`docs/host-app-integration-strategy.md`.
