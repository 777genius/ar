# Logical-thread continuation evals

The live Goal V3 evaluation measures durable provider context across three
separate executions of one logical thread. It always creates a temporary Git
workspace and must never be pointed at a user or Quanta project.

The three rounds prove progressively stronger behavior:

1. Start a fresh thread, ask the provider to retain a primary and a separate
   long-horizon token, and make one bounded workspace edit. The exact workspace
   snapshot at the round boundary must contain neither token.
2. Restart the runtime, recall only the primary token, retain a third token,
   and replay without provider work. The boundary snapshot must contain neither
   token reserved for round three, and provider output must not repeat the
   long-horizon token.
3. Restart again, recall all three tokens cumulatively, verify exact replay,
   prove a tampered workspace fails closed, and compare every fixture byte with
   the expected final state.

The command emits a diagnostic machine-readable score from 0 to 10 showing how
much evidence survived. A run passes only when every replay, continuation,
recall, snapshot-isolation, fail-closed, and workspace-boundary criterion passes. Normal
unit tests cover scoring behavior without provider calls.

```bash
npm run eval:logical-thread-continuation:live:codex
npm run eval:logical-thread-continuation:live:claude
```

These commands use real provider credentials and are intentionally not part of
the default test suite. Run them only with explicit approval for live provider
usage. The default suite remains deterministic and offline.
