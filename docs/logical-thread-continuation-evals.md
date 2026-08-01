# Logical-thread continuation evals

The live Goal V3 evaluation measures durable provider context across three
separate executions of one logical thread. It always creates a temporary Git
workspace and must never be pointed at a user or Quanta project.

The three rounds prove progressively stronger behavior:

1. Start a fresh thread, retain an opaque token only in provider context, and
   make one bounded workspace edit.
2. Restart the runtime, recall the first token exactly, retain a second token
   without writing it, and replay the completed execution without provider work.
3. Restart again, recall both tokens cumulatively, verify exact replay, and
   prove a tampered workspace fails closed before provider execution.

The command emits a machine-readable score from 0 to 10. A run needs at least
9/10 and every required continuity, recall, leakage, and workspace-boundary
criterion. Normal unit tests cover scoring behavior without provider calls.

```bash
npm run eval:logical-thread-continuation:live:codex
npm run eval:logical-thread-continuation:live:claude
```

These commands use real provider credentials and are intentionally not part of
the default test suite. Run them only with explicit approval for live provider
usage. The default suite remains deterministic and offline.
