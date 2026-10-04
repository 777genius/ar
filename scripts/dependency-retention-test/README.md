# Disposable Linux TEST primitives

The dedicated `dependency-retention-linux-test.yml` workflow runs on a new
GitHub-hosted Ubuntu 24.04 VM, never on a configured Hetzner pool, user project,
account session or existing policy installation. It refuses pre-existing TEST
artifact/policy roots and registers a fresh protected fixture identity. No
repository dependencies or credentials are added. Every new helper is TypeScript.

The regression assertions are:

- A protected workspace path alone cannot admit an unowned consumer or create
  owner/install state.
- The actual pinned Node/npm/glibc closure and production fixed installer recipe
  execute registry-only npm lock v3, no lifecycle scripts, in a real systemd
  `RootDirectory`. Real terminal-unit and recursive cgroup observations follow
  the manager's wait return. No success/drain record is fabricated.
- A typed TEST reader mounted as one additional read-only file in that
  installer's finite root can read the installed dependency
  and cannot read source, Git, needed ignored, key, state, output or privileged
  sibling TEST sentinels. Their original bytes and inodes remain unchanged.
- A same-device bind mounted only in a fresh user/mount namespace produces the
  specific `mount_crossing` observation and blocks anchored rename before any
  destination appears. The external sentinel remains unchanged.

`evidence.json` records exact CI source SHA, actual toolchain/content digests,
owned unit names and scenario outcomes. A green job means only these primitives
passed. `qualification=native_test_primitives_only` and `status=partial_pass`
explicitly exclude positive final ordinary admission, production provider
confinement, hot reuse count, eviction/cold restore, duplicate/late/uncertain
creator handling and live provider acceptance. This probe cannot issue Ready,
Absent, owner/drain or installation authority.

Full ordinary composition remains a separate gate. The installed creator tuple
is pinned to the goal CLI. The stock Ubuntu VM's sockets/timers and enabled
foreign creators do not satisfy the installation kernel's homogeneous finite
inventory. They must not be silently trusted or stopped to turn partial evidence
into acceptance. A minimal isolated OS fixture is required before full inventory
qualification; synthetic provider protocol alone does not resolve that boundary.

Run only through the dedicated workflow after review. Its typecheck runs against
built declarations before any root execution. The VM owns and discards every
fixture at job completion; there is no broad cleanup, real host modification,
provider login or account-pool lookup.
