# Codex Auth

Codex subscription execution uses a local encrypted session store for backend
workers. The backend process can decrypt the session at runtime, refresh it via
Codex, and write the updated generation back to the local store.

Do not commit `auth.json` or decrypted session files. Bootstrap from an existing
local Codex login and store only encrypted runtime state under the configured
state directory.

For account status, use:

```bash
subscription-runtime-account-status --provider codex
subscription-runtime-account-status --provider codex --probe
```

The default command reads safe `auth.json` identity metadata and cached capacity
signals. `--probe` can detect revoked refresh tokens that a shallow login-status
check may miss, but it can spend provider capacity. See
`docs/account-diagnostics.md`.

Runtime refresh publication preserves the login writer's source file. Supported
readers select usable refresh bytes from encrypted custody scoped to that source
authorization. For a local artifact atomically bound to the same source path and
authorization, a selected journal refresh with validated ancestry containing that
artifact's session identity supersedes it even with older or absent refresh
timestamps. A changed byte string or a sibling publication supplies no such
proof. An unchanged source retains an unpublished local rotation. Provider
refresh ancestry does not release a confirmed invalid-source hold; independent
login replacement remains the recovery boundary, and quota holds still apply.

One `FileBackendCodexWorker` admits one session-binding operation at a time.
Both public seeding methods require quiescence: they reject with
`subscription_worker_run_failed` and reason `codex_session_binding_busy` during
seed/import IO, prewarm, run
(including streamed output), managed resume, and final failure/accounting or
refresh publication. A returned `waiting_for_input` result retains its binding
while the driver owns that managed session; only its resume can proceed on that
worker. Reseeding and other operations remain rejected until that session
settles or is disposed. Internal durable resume recovery stays within the same
reservation and binding. If resume starts with no retained provider session,
it can import the current source at admission. Separate worker instances retain
their existing concurrency.

Replacing a login file while an operation is active does not rebind that
operation. Its failure still fences the admitted session and its bound source,
and its successful refresh publishes only in that source's custody. After the
operation settles, an explicit public reseed or the next ordinary import can
accept independent login replacement. Shared quota holds continue to apply.
There is no automatic retry of a rejected reseed.

Older job-local stores (including pre-binding 058 stores) can contain an encrypted
rotation with no source binding. When its bytes differ from the effective source,
automatic migration cannot distinguish a stale original login from a new owner
login. Runtime retains that local artifact without guessing from clocks, emits
`codex.auth_path.unbound_local_retained` with reason
`codex_source_binding_recovery_required`, and grants no source publication right.
If that unbound session fails, its invalidation attaches to its actual session,
not the independently observed login. Identical local and effective bytes can
acquire their source binding atomically without replacing the artifact.
Unchanged local use can complete; a further unbound rotation reports refresh
publication failure and retains the new encrypted local artifact for recovery.

For explicit recovery after an independent login, retain the old encrypted state
directory and its encryption key in existing trusted recovery custody, then use
the existing worker configuration to start a fresh job-local state directory and
provider instance with that login source. Keep the same shared account-capacity
root; this does not reset invalid-session or quota holds. Do not delete or reset
the old store to recover, copy its rotation over the login file, or probe live
credentials to infer ancestry. Recovery with a distinct local store is supported;
automatic inference for a differing unbound artifact remains unsupported.
