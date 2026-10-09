# Standalone hosted MiMo worker qualification

This narrow path uses the existing research owner and its runtime/provider services on a shared host with no installed global/managed activation. Controller, Child, ordinary MiMo and unowned contained launches remain closed. It is not a controller activation.

Run only in a newly allocated TEST job/workspace, with an isolated registry and root-owned private operator request. Never use a real user project. Install the built exact revision through the existing deployment/bootstrap procedure. The fixed root-only shared credential must already exist; do not copy, print or read it from a shell.

The closed request retains the existing research fields and adds:

```json
{
  "modelBackend": "xiaomi-mimo-token-plan",
  "model": "mimo-v2.6-pro",
  "accounts": ["account-q"],
  "maxAccountCycles": 1,
  "prewarmOnStart": false
}
```

The remaining fields are `schemaVersion: 1`, exact TEST `jobId`, `taskId`, `jobRootDir`, `workspacePath`, `promptPath`, private separate `authRootDir` (no auth.json is needed), installed absolute `codexBinaryPath`, `reasoningEffort`, `serviceTier: "default"`, and finite `taskTimeoutMs` (1000-86400000). Set `appServerStartupTimeoutMs` above the existing provider setup budget if supplied. Do not supply environment, credential or controller/handoff bags.

Using the installed runtime and those exact TEST paths:

```sh
node "$RUNTIME/host-integration/codex-research-egress.mjs" grant-owned-mimo-worker "$TEST_JOB_ID" "$TEST_JOB_ROOT" "$TEST_WORKSPACE"
node "$RUNTIME/host-integration/codex-research-egress.mjs" start-owned-research "$TEST_REQUEST_PATH" "$TEST_REQUEST_SHA256"
node "$RUNTIME/host-integration/codex-research-egress.mjs" status-owned-research "$TEST_JOB_ID"
```

`TEST_REQUEST_SHA256` is the SHA256 of the exact private request bytes. The existing service owner retains active/spec/grant digests, real runtime MainPID/birth/boot/namespaces/InvocationID, and provider reservation/ownership. A timeout is uncertain: inspect the same job before any retry. Use the existing `cancel-owned-research` and `revoke-owned-research` operations for that same job when needed.

A finished runtime stages a root-private candidate, not public completion. Keep the `startId` and `specSha256` returned by the start operation and finalize that exact attempt:

```sh
node "$RUNTIME/host-integration/codex-research-egress.mjs" finalize-owned-mimo-worker "$TEST_JOB_ID" "$TEST_START_ID" "$TEST_SPEC_SHA256"
```

Finalization stops and reconciles the owned runtime/providers, preserves the current dirty workspace as the existing handoff artifacts, then publishes the original normalized outcome. A failed or partial candidate remains failed or partial. Publication and cancellation share a per-job custody lock; uncertainty retains the active reservation and evidence. Cancellation of a MiMo attempt with a candidate retains its reservation for finalization. Same-boot crashed mutation locks fail closed and must not be removed based only on PID absence.

The generated MiMo home stays retained under the TEST job. The runtime does not recursively remove mounted storage. Its private service namespace ends through the existing owner reconciliation; preserve homes and evidence until separately verified disposable cleanup.

The worker derives one account cycle, one attempt, disabled continuation/reconnect/prewarm, eight maximum goal turns and a shared execution deadline. The existing execution lifetime forbids provider restart and thread fork/resume. Generated config keeps the MiMo endpoint, named filesystem permissions and disabled native tools. The only tools are the existing MCP workspace read/edit/write/search tools with enforced relative workspace paths. Native shell/delegation/network tools and project instructions are disabled. Native scan hooks are inactive because no native Bash/exec tool exists; the bounded MCP reader/search contract enforces scan scope. MCP receives only PATH/HOME/CI/CODEX_HOME, never the MiMo key or auth variables. The credential is read only at provider launch, after a separate provider-side origin validation, and sent through the held stdin frame after provider ownership/readiness. Its file never enters the provider root.

Qualification must prove one bounded MCP tool turn that writes a uniquely named TEST artifact into the admitted workspace and returns its bytes, workspace-only writes, no sibling/auth/host-private access, redacted output, retained provider ownership and clean service shutdown. Do not automatically repeat an uncertain provider invocation. Focused automated contracts: `research-mimo-worker`, `research-mimo-worker-finalization`, `research-launch-contract`, `research-launch-owner`, `research-provider-service`, `hosted-mimo-credential-source`, `codex-mimo-app-server-goal-only`, `codex-goal-mimo-launch-path-e2e`, `codex-workspace-tools-profile-mimo` and `hosted-optional-activation`.
