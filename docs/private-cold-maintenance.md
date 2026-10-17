# Private cold maintenance boundary

This is an inert selected-job maintenance capture. Its receipt does not seal a
terminal attempt, prove provider completion, activate routing, or grant
resumability. The private helpers are fixed dependencies within the
`worker-codex` cold-maintenance feature. They create no Core/Assembly handle or
new consumer adoption claim. The current canonical Get Modular document is
`docs/architecture/common-assembly.md#consumer-module-standard` at
`4728b276b87378ca9d72a7be2b89a5fd49b97eea` (Git blob
`20c281b3137f5d3c198250e9f8101c0ecd4cbc75`, 54680 B), complete-document SHA-256
`859fbca1e8a0c61b6ae873bea0057735a55b80230100e6e73a74de22e123165a`.
The previously reviewed `d6127e2d3f499b91b220a222fc3672d29dff1ab2` /
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`, `6b31f20fe3e5fb8324812aa2ee907905751cde71` /
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f` and the exact
deltas (including d612 to 4728: 141 insertions, 10 deletions, diff SHA-256
`f5da152530e6c0830afb9a26f93863347eed8f76e9067aee9442db2c6c0717b6`) are recorded in
`retained-nonqualified-attempt.md` as historical records; adoption stays pending.

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
device/inode identities. `sourceRoot` is the observed rescue mount;
`selectedJobRoot` is the reviewed current selected-job subtree within that
mount. Every selected file must be inside that subtree. Directory segments
named archive, archives, archived, history, historical, worktree, worktrees,
project, or projects (including numbered or named suffixes) are excluded from
selection. Historical completed archive, worktree, and project trees are not
copied or represented by the receipt; no bulk tree walk occurs. A legitimate
SQLite filename such as `thread_history_1.sqlite` is unaffected. The receipt
records current selected-job scope and historical-tree exclusion. These path
checks and the caller's selected-job declaration do not establish that DB
content is active or eligible. A trusted operator must review selection,
schema, dependencies, history eligibility, and artifact digests before capture.
Registry, result, journal, events, selected SQLite roles and numbered artifacts
are separate roles. Credentials and unrelated shared trees are excluded.
Declared aggregate size is checked before reads; opened files and metadata are
read within fixed limits. SQLite main DB and present WAL/SHM sidecars are
retained as raw inventory, then copied to a separate writable working area for
normalization. The normalized output is checked for integrity and foreign-key
violations. An optional reviewed row witness can check a committed row; a
synthetic fixture row is not part of the production data API. The complete
raw and normalized inventory is verified before the create-only commit marker
is written last. Raw staging is retained on failure.

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
