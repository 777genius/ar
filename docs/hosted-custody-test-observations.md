# Bounded custody observations (TEST)

`worker-codex` uses one private Linux collector for production kernel and the
finite TEST observer. It runs only fixed, bounded, read-only `systemctl show`
and `list-jobs` calls with the existing fixed environment. Boot and process
birth come from fixed `/proc` paths; hosted cgroup events come from the fixed
`/sys/fs/cgroup` hierarchy. The collector reports present or absent events
explicitly. It never treats an absent cgroup as terminal. The production kernel
retains its operator guard, whole-host inventory, constructor/composition,
creator → queue → terminal order, mutex, mutable commands, and post-fence
absent-cgroup behavior. No launcher or authority record is added here.

The private helper `src/worker-codex/tests/fixtures/hosted-custody-test-observer.ts`
selects one externally owned `subscription-runtime-hosted-<startId>.service`.
Its caller creates a `test-custody-observer-*` directory directly under the
process's private `TMPDIR` (normally `/tmp`), owned by its UID,
mode 0700, with `identity.json` containing exactly `startId`, `bootId`, and
`creatorPid`. The caller must have exclusive ownership of that directory for
the whole two-phase observation and prohibit concurrent writers. The helper
also creates an exclusive observer lock and fails if another cooperative
observer holds it. It checks the root identity before and after each collection.
Input and evidence descriptors use nonblocking, no-follow opens, `fstat`,
bounded reads or writes, and mutation/identity rechecks. A claimed PID or file
content does not authenticate a creator.

Call `observeTestCustody(root, "initial")` while the selected creator process is
live. It verifies boot, exact unit and group, manager InvocationID, no queued
start, the unit's MainPID, and process birth before and after collection. It
writes `initial-evidence.json` exclusively. The declared creator or supervisor
PID is observed separately from the unit's
MainPID; its birth and actual `/proc` cgroup must stay stable during this first
phase. Neither the PID nor that group is an independent ownership witness.
After an independently authorized
creator/launcher has finished and fenced its work, call
`observeTestCustody(root, "terminal")`. This phase checks the same boot,
unit and InvocationID, no queued start, MainPID zero, and an actual
`cgroup.events` record with exactly one `populated 0`. It writes
`terminal-evidence.json` exclusively. It does not require the departed PID to
remain alive. A reused unit or changed identity fails closed. Missing events
fail in TEST even though production may accept absence after its existing
creator and queue fences. Bus and permission errors propagate.

Both records say `live_observation_only`. They are observations from OS reads,
not authoritative custody receipts. The external trusted launcher and creator
fence must be reviewed independently. Real disposable systemd qualification
remains **NO-GO** until that review; no real fixture is run by this patch.
JSON snapshots remain only in parser unit tests and are never offered as live
proof. TEST directory cleanup belongs to the orchestrator.

Production parsing is deliberately stricter: exact `Id`, positive bounded PID
birth ticks, boot-ID shape, and every `cgroup.events` row are validated.
Whitespace-prefixed, duplicate, or malformed `populated` rows now refuse,
including `populated 0\n populated 1\n`. This can refuse malformed legacy
observations that the old filter ignored.

The private/static boundary classification and Consumer Module Standard
reference is now `4728b276b87378ca9d72a7be2b89a5fd49b97eea` (blob
`20c281b3137f5d3c198250e9f8101c0ecd4cbc75`, complete SHA-256
`859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`);
it was `d6127e2d3f499b91b220a222fc3672d29dff1ab2` (`49d08b6d...`) and before that
`6b31f20fe3e5fb8324812aa2ee907905751cde71` (`d5bb71e5...`). The deltas (d612 to
4728: 141 insertions, 10 deletions, diff SHA-256
`f5da152530e6c0830afb9a26f93863347eed8f76e9067aee9442db2c6c0717b6`) are
recorded in `retained-nonqualified-attempt.md`. The classification is unchanged.
There is no Assembly adoption pin.
