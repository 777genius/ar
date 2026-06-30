# Host App Integration Strategy

Status: proposed integration contract

This document defines how `qa-rig`, `hib-pr-reviewer`,
`quanta-pr-reviewer` and control-layer apps should plug into
`subscription-runtime` without copying provider glue into every repository.

## Target Boundary

```txt
host app
  -> host-local adapter
    -> @777genius/subscription-runtime/agent-task
      -> runtime composition root
        -> worker-core / queue-core
          -> worker-claude | worker-codex
            -> provider-claude | provider-codex
```

Host apps may own product orchestration, prompts, PR/QA domain data and bus
publishing. They should not own provider session lifecycle, Claude config dir
materialization, Codex auth materialization, worker slot selection, quota
cooldown or account capacity state.

## Import Rules

Preferred app imports:

- `@777genius/subscription-runtime/agent-task`
- `@quanta/contracts` for universal bus envelopes and subjects
- host-local wrapper modules that expose the app's own port names

Provider/runtime imports are composition-root only:

- `@777genius/subscription-runtime/provider-*`
- `@777genius/subscription-runtime/worker-*`
- `@777genius/subscription-runtime/queue-*`
- `@777genius/subscription-runtime/store-*`
- `@777genius/subscription-runtime/runner-*`

Existing direct adapters in `quanta-pr-reviewer` are transitional. New host-app
integrations should use `agent-task` first, then let the runtime composition
root pick Claude, Codex or a future provider.

## Round Member Contract

Adversarial reviewer and tribunal rounds must carry explicit round identity:

```ts
context: {
  round: {
    roundId,
    roundIndex,
    member: {
      id,
      adapterId,
      agentType,
      provider,
      model,
      independenceGroup,
    },
    adversaryOf: {
      id,
      adapterId,
      agentType,
      provider,
      model,
      independenceGroup,
    },
  },
}
```

Adapter tests should call `assertAgentTaskCertification` with:

- `requireRoundMemberIdentity: true`
- `requireRoundMemberIndependence: true`
- `requireTerminalEvent: true`

This is the runtime-level proof for the requirement that adversarial action is
performed by distinct models at the round-member level, not simulated by a
single model reviewing prior output.

## Idempotency And Dedupe

Use the strongest idempotency boundary available at each layer:

- NATS/JetStream producers set deterministic message ids for event publish
  dedupe.
- `queue-core` owns durable task idempotency for queued jobs.
- `worker-core` owns direct-call single-flight idempotency for concurrent
  calls with the same `WorkerPoolRunOptions.idempotencyKey`.
- Host apps still keep product-level PR/job dedupe because they understand
  whether a webhook, QA run or review round is semantically stale.

Do not rely on direct worker-pool idempotency as durable restart-safe storage.
It only prevents duplicate concurrent direct pool runs inside one process.

## Capacity And Account Policy

Claude quota belongs behind runtime worker composition:

- one Claude token/session is one quota domain unless explicitly configured
  otherwise;
- multiple local slots using the same token do not add independent capacity;
- slots sharing a `capacityAccountId`, `accountId`, `quotaGroup` or
  `subscriptionAccountId` must share cooldown and quota exhaustion state;
- host apps should not parse Claude warning text or Claude Code status lines;
- deterministic tests should simulate quota/soft-limit signals instead of
  spending real subscription quota.

For a single process, in-memory capacity state is enough. For multiple runtime
processes scheduling the same Claude accounts, use a shared capacity store.

## Repository Responsibilities

| Repository | Runtime responsibility |
| --- | --- |
| `subscription-runtime` | Ports, `agent-task`, provider adapters, worker pools, account capacity, queue/store adapters. |
| `quanta-pr-reviewer` | PR review orchestration and local transitional adapters. Target state is round members over `agent-task`. |
| `hib-pr-reviewer` | Review production and current Claude SDK reviewer. Target state is agent-task round-member adapter plus universal bus publish. |
| `qa-rig` | QA execution. Target state is request-run bridge for PR-correlated QA plus universal result publish. |
| `quanta-orchestrator` | Bus consumers/gates and loop coordination. Should consume contracts, not provider runtime details. |
| control-layer apps | Deployment/composition snapshots. They should import host adapters or pinned submodules, not provider glue. |

## Rollout Order

1. Land `subscription-runtime` provider, worker-pool, account-capacity and
   `agent-task` contracts.
2. Keep existing `quanta-pr-reviewer` direct subscription-runtime adapters as a
   verified transitional path.
3. Add host-local `agent-task` wrappers for `quanta-pr-reviewer` and
   `hib-pr-reviewer` round members.
4. Add a PR-correlated QA request-run bridge in `qa-rig`, then keep
   `quanta-orchestrator` consuming universal QA results.
5. Update control-layer snapshots/submodules only after the standalone repos
   have merged in dependency order.
6. Tighten host-app architecture checks so new provider/worker imports outside
   composition roots fail CI.

## Implementation Options

1. Boundary hardening only - add docs and static checks first.
   🎯 9   🛡️ 7   🧠 3   Approx. 100-250 LOC.

2. Staged agent-task migration - keep current direct adapters working, but make
   all new round-member adapters go through `agent-task`.
   🎯 9   🛡️ 9   🧠 6   Approx. 400-900 LOC per reviewer app.

3. Central remote runtime service - all apps enqueue work through
   `queue-core`/`queue-bullmq` and never run local provider composition.
   🎯 7   🛡️ 9   🧠 9   Approx. 1200-2500 LOC plus deployment work.

Recommended path: option 2, with option 1 enforced immediately. Option 3 is the
production scaling shape once queue ownership, shared capacity storage and
control-layer deployment topology are agreed.

## PR Hygiene

This package exports `dist/*` and is consumed as a GitHub dependency. Source
changes that affect public package output should be built and committed with
the generated `dist` changes, or consumers can install a commit whose exported
files do not match source.
