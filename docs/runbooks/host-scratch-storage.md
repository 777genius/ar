# Opt-in scratch storage for retained worker homes

The managed launcher already puts its whole job layout under the configured
storage root. Direct legacy launches may retain their job journals and Codex
session homes on durable RAID. For these launches, the host can opt in to
putting new temporary files and reproducible plugin caches on another volume.

The runtime retains the logical `jobRoot/tmp` path required by the provider
sandbox. A root operator binds a private directory on the scratch filesystem
at that path. For preserved session homes, only `plugins/cache` and
`cache/remote_plugin_catalog` get separate private binds. Auth, sessions,
SQLite databases, checkpoints and job journals keep their existing location.
Ephemeral homes and trusted managed launches keep their original layout.

## Host policy

A root-owned `/etc/subscription-runtime/scratch-temp.json` without group or
other write permission enables the policy. The scratch root must be an actual
mountpoint with the configured UUID and filesystem root `/`. Provision the
root-owned `runtime-tmp` and `runtime-caches` parent directories on that
filesystem with mode `0711`. Admission rejects a missing or replaced mount
and less than 5 GiB available on either root or scratch.

```json
{
  "schemaVersion": 1,
  "root": "/srv/workers",
  "uuid": "REPLACE-WITH-ACTUAL-FILESYSTEM-UUID",
  "legacyTemps": {}
}
```

Existing nonempty directories are never hidden. Before rollout, an operator
may inventory exact existing temp/cache directories into `legacyTemps`, keyed
by canonical absolute target path, with numeric `device` and `inode` values
from `lstat`. Those exact directories remain on their existing filesystem;
an inode replacement invalidates the exception. This compatibility inventory
is not a cache deletion or migration policy.

Do not turn this on for non-root direct launchers. New bindings require host
mount privilege. Repeated launches reuse only an exact matching bind. A
per-target preparation mutex rejects competing preparations; it does not
recover abandoned locks automatically. A root operator must prove no owner
remains before clearing a stale preparation lock.

## Where the binds live

Binds are created only in a namespace owned by the runner that uses them. A direct goal runner (tmux
pane, in-process hosted run, broker tool) is started by `codex-goal-cli` or `codex-goal-mcp`, which first
calls `enterScratchPrivateMountNamespace()` (not for `--help`). On a scratch-policy host, for root with
CAP_SYS_ADMIN and outside managed launches and research units, it re-executes the same process (same PID,
fds and signals) under `unshare --mount --propagation slave` and sets
`SUBSCRIPTION_RUNTIME_SCRATCH_NS_PID` to its own PID. The decision does not depend on PID 1's namespace:
a process that inherited another runner's namespace (its marker names a different PID) re-executes again
and gets a nested namespace of its own. The runner's binds exist only there and disappear when its last
process exits, including SIGKILL or OOM; the source data stays on scratch and the next run re-binds it.
Slave propagation lets a host-side unmount still reach live runners, while runner mounts never propagate back.

The tmux server outlives its first runner, so `startCodexGoalTmux` starts it with
`nsenter --mount=/proc/1/ns/mnt` when called from a runner namespace. Operator tmux sessions and the shared
server therefore stay in the host namespace. If `nsenter` is missing the start fails with
`scratch_host_namespace_launch_unavailable`.

Requirements: Node 22.15 or newer (`process.execve`), `/usr/bin/unshare` (util-linux, `--propagation`) and
`/usr/bin/nsenter`. Without `process.execve` or `unshare` the runner refuses with
`scratch_private_namespace_unavailable` before any exec; it never falls back to a shared namespace.
Inside the Codex sandbox (root without capabilities) the helper does nothing and no bind is attempted. As a
second line of defence a new bind is refused with `Scratch bind requires a private mount namespace` unless
the process owns its namespace (marker equals its PID) or is a research unit; reusing a bind that is
already visible stays allowed.

Library consumers and other binaries that run as root on a scratch-policy host (for example the agent task
runners) must call `enterScratchPrivateMountNamespace()` first thing, or start under
`unshare --mount --propagation slave` with the marker set, or they fail with the error above.

Runs whose Codex provider is a separate `subscription-runtime-hosted-*` unit skip both preparations: that
unit is created from PID 1's namespace and could not see the runner's binds. Their home is
`<jobRoot>/home` under the unit's ReadWritePaths. Research units keep their own binds in the unit namespace.

## Garbage collection and diagnostics

New binds are not in host mountinfo. A source is in use if any `/proc/*/mountinfo` mentions it or its job is
alive. GC and diagnostics must scan all `/proc/*/mountinfo`, never only the host table, and must not delete
scratch source data on the evidence of the host table alone. Release host binds of terminal jobs only.

Preparation runs on every session materialize and every run start (resume). The 5 GiB free-space check on
`/` and the scratch root applies only when a new bind or source must be created; a resume whose binds are
already in place does not fail on low disk.

Failure mode when a host GC releases a bind of a live owner: the host unmount propagates into the runner,
Codex keeps writing into the bare target directory on the underlying disk, and the next materialize or
resume fails with `Refusing to hide nonempty legacy scratch directory`. Recovery: stop that job (do not kill
unknown processes; use the job's owner), move the stray files out of the target (they are not the scratch
source and are usually reproducible cache), then resume so the runner binds the source again.
The platform GC releases registered binds only for terminal jobs and unregistered ones only after 72 h of
quiet, so this should only appear when that rule is bypassed.

Binds made by older releases live in the host namespace and are collected only by an operator; nothing creates
new ones. Do not recursively delete mounted targets. The privileged check is
`scripts/test-scratch-private-namespace.mts` (disposable container, scripts as PID 1).

## Rollback and retention

Keep the previous immutable runtime release. To roll back admission, restore
its `current` symlink and remove the opt-in policy after verifying no new
launcher is in preparation. Existing binds and their scratch data stay intact.
Unmount only a proved inactive target; never move or delete active session
state. Shell commands outside the runtime still need an explicit scratch
`TMPDIR` and scratch workspace. This feature does not relocate arbitrary
`/tmp` contents or garbage-collect completed job journals.
