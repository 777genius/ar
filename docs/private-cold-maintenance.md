# Private cold maintenance boundary

This is an inert selected-job maintenance capture. Its receipt does not seal a
terminal attempt, prove provider completion, activate routing, or grant
resumability. The private helpers are fixed dependencies within the
`worker-codex` cold-maintenance feature. They create no Core/Assembly handle or
new consumer adoption claim. The canonical Get Modular document remains
`docs/architecture/common-assembly.md#consumer-module-standard` at
`6b31f20fe3e5fb8324812aa2ee907905751cde71`, SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.

`private-cold-source-observation.ts` reads actual kernel boot, mount and sysfs
block-device state. It requires an exact source mount, a read-only mount and
superblock, read-only backing devices, no nested mounts, and an exact expected
source tuple. These are observations, not offline authority. A caller can copy
the current boot ID and mount tuple into the expected fields; therefore this
helper must never authorize capture by itself. A read-only bind in a copier
namespace also cannot establish that the source is quiescent.

Trusted Host/operator rescue control is an external precondition and part of the
trusted computing base. Before calling `capturePrivateColdMaintenance`, it must
establish whole-host writer quiescence, provision the expected rescue boot and
source identity independently of the caller, and hold that state through the
capture. The private capture entry checks actual read-only mount and backing
device facts against that exact tuple before and after the finite copy. It does
not establish or enroll offline authority. No public route, real mount, ioctl,
systemd or production source operation is part of this patch.

The private capture accepts an explicit finite allowlist with byte hashes and
device/inode identities. Registry, result, journal, events, selected SQLite
roles and numbered artifacts are separate roles. DB location or a role name
does not prove schema or history eligibility: an operator must review each
schema, dependencies, and artifact digest before selecting a job. Exclude
credentials, unrelated shared trees and history trees. SQLite main DB and
present WAL/SHM sidecars are copied to raw writable staging before the Backup
API opens them. The normalized output is checked for integrity and foreign-key
violations. An optional reviewed row witness can check a committed row; a
synthetic fixture row is not part of the production data API. Raw staging is
retained on failure, and a create-only commit marker is written last.

Encrypted restore is restricted to disposable TEST roots and requires a reviewed
SQLite row witness. It verifies the
manifest digest, exact payload inventory, hashes, SQLite checks and that
committed-row witness after the restic roundtrip. Neither the snapshot nor its receipt is
an activation instruction.

Synthetic tests mock only the private source observer for the positive data
path. They also exercise the real observer against a writable local source and
pure mount-fact refusals. These tests do not qualify a Host rescue boot or an
actual cold production source. Focused validation, under the shared heavy lock:

```sh
flock /run/lock/hosted-v1-heavy.lock node_modules/.bin/vitest run src/worker-codex/tests/private-cold-maintenance.test.ts --maxWorkers=1
flock /run/lock/hosted-v1-heavy.lock node_modules/.bin/tsc --noEmit -p tsconfig.json
```
