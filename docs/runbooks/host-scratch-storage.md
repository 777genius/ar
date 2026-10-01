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

Bind mounts disappear after reboot; the source data persists on scratch and
the next launch reconstructs the binding. Deleting a job should first unmount
its exact known temp/cache binds. Do not recursively delete mounted targets.

## Rollback and retention

Keep the previous immutable runtime release. To roll back admission, restore
its `current` symlink and remove the opt-in policy after verifying no new
launcher is in preparation. Existing binds and their scratch data stay intact.
Unmount only a proved inactive target; never move or delete active session
state. Shell commands outside the runtime still need an explicit scratch
`TMPDIR` and scratch workspace. This feature does not relocate arbitrary
`/tmp` contents or garbage-collect completed job journals.
