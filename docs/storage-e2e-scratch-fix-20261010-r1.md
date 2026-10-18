# Storage E2E observation scratch fix

Task: `sr-storage-e2e-scratch-fix-20261010-r1`. Admitted main:
`c50c948535e4840ae876022430a1dfc381054b7b`.

## Failure and implementation

The isolated sandbox has no `/tmp`. The original two native mount tests fail
with `ENOENT` there. A separately compiled original adapter also throws
`ENOENT` opening `/tmp`, despite an existing explicit job-owned `TMPDIR`.

The adapter now opens its anonymous observation snapshot in the current
process's explicit `TMPDIR`. When that variable is absent, it retains the
existing `/tmp` default. An explicitly empty or relative value is refused;
an unavailable, non-directory, symlink leaf or unsupported filesystem propagates
its error. There is no retry in another directory, implicit HOME selection,
directory creation, named snapshot, or socket transport fallback. Only the
snapshot-directory selection and absolute-path check changed in production.

`O_TMPFILE | O_RDWR | O_NOFOLLOW | O_EXCL`, mode `0600`, descriptor closure,
and descriptor-based findmnt stdin remain intact. `O_EXCL` prevents relinking.
The full bounded topology before/after the query, unique original FD-selected
row, held/current named descriptors, device/inode/mount IDs, namespace identity,
propagation checks and malformed-query refusals remain intact. Missing inspected
paths and authenticated containing ancestors still report intentional absence;
snapshot-storage failure at an exact mount still refuses observation.

## Call sites and bootstrap

`host-scratch-temp.ts` installs `inspectVisibleScratchMount` as the system
host's synchronous mount observer. `readPolicy` observes the configured physical
scratch root before granting its UUID/fsroot authority. `preparedTarget`, cache
observers and bind verification also call it. Bootstrap can inspect an absent or
unprepared logical job temp target before creating/preparing it. The inspected
root or target therefore cannot justify its own use as writable observation
storage. This fix derives no writable location from that path, its returned
tuple, its source, HOME, or an expected scratch UUID.

`prepareHostScratchTemp`/`prepareHostScratchCaches` receive `sourceEnv` for their
managed-launch checks, but the mount-observer port receives only a path.
`withCodexGoalCheckpointWriter` invokes temp preparation before its effect;
provider temp creation is a separate step. CLI/research launch configurations
derive `sourceEnv.TMPDIR` as `jobRoot/tmp/agent`; that object is not proof the
directory exists, nor does it mutate the observer process's environment. Managed
launch sets process `TMPDIR` explicitly. The observer requires its own existing
configured temporary directory; it does not pre-create or infer a new one from
a future launch configuration. Direct propagation-test scripts retain the same
one-argument observer API.

## Verification environment

Read `AGENTS.md`, `docs/architecture.md`, and
`docs/runtime-ddd-feature-architecture.md` fully. Changes stay in the three
owned files. No native mounts, cgroup/quota mutations, signing, credentials,
host installation, project agent/provisioning/terminal flows, or Git writes ran.

Observed machine ID: `d856d40da5ad4e23b4f67773e5942842`, matching the request.
Kernel mountinfo and statfs show ext4 on device `259:1` (`/dev/nvme2n1p1`)
for both the workspace and admitted job-owned agent scratch. Initial available
scratch space exceeded 314 billion bytes; sandbox `/` had 33,597,190,144 bytes
available. Both exceeded the 5 GiB floor. Initial available memory exceeded
48 billion bytes; tests used one worker. The device UUID is **not independently
observable** here: `/dev/disk/by-uuid` is absent and findmnt reports an empty
UUID. Expected UUID `d0f2cac1-2009-4e9d-a710-e156f417938f` remains the operator's
prior check, not a newly verified claim. Protected host config was not read.

All dependency downloads, npm cache, test caches, temporary data, copied sources,
package builds, single-module builds and handwritten TypeScript harnesses live
under this newly created private verification directory:

```text
/srv/workers/jobs/subscription-runtime/storage-prevention-20261007/jobs/sr-storage-e2e-scratch-fix-20261010-r1/tmp/agent/sr-storage-e2e-scratch-fix-20261010-r1-verification
```

Below, `V` denotes that absolute directory. Commands ran in `$V/verify` with
`TMPDIR=$V/temp`, `npm_config_cache=$V/cache`, and scratch-local npm on PATH.
Dependencies came from the unchanged package lock through npm 11.6.2
`ci --ignore-scripts --no-audit --no-fund`; Node was 24.21.0, TypeScript 6.0.3,
Vitest 4.1.8. Lock SHA-256:
`4de8cd9332eb1c95421482d66d3f6d076ef86aeb4b780558642bf071a6ad80f5`.

| Check | Result | Evidence under V |
| --- | --- | --- |
| Original focused mount/cost/temp tests | 66 pass, original two mount tests fail `ENOENT /tmp` | `logs/baseline-focused.log` |
| New regression against original implementation | 17 pass, 9 fail; explicit-private-TMPDIR regression fails opening `/tmp` | `logs/red-regression.log` |
| Original compiled adapter, real absent `/tmp`, explicit existing TMPDIR | Expected `ENOENT /tmp` reproduced | `logs/built-red.log` |
| Final mount tests | 26 pass | `logs/final-mount.log` |
| Temp preparation tests | 25 pass (51 total with mount tests) | `logs/green-mount-temp.log` |
| Observation cost/topology/current-state tests | 24 pass | `logs/green-cost.log` |
| Full pinned `npm run typecheck` | Exit 0, including package, artifact-pack, host-transport and lifetime-pin checks | `logs/typecheck.log` |
| Final source `tsc --noEmit -p tsconfig.json` after final test adjustment | Exit 0 | `logs/final-source-typecheck.log` |
| Final compiled adapter, real absent `/tmp`, explicit existing TMPDIR | Root tuple matches independently opened native root mount ID | `logs/built-green.log` |

Final focused commands (all in `$V/verify`):

```sh
node node_modules/vitest/vitest.mjs run src/worker-codex/tests/host-scratch-mount.test.ts src/worker-codex/tests/host-scratch-temp.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts --config cost-fixture.config.ts --maxWorkers=1
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

The unchanged observation-cost fixture mocks all native filesystem operations
and hardcodes its synthetic snapshot syscall at `/tmp`. Its scratch-only
`cost-fixture.config.ts`/`cost-fixture-setup.ts` temporarily unset TMPDIR inside
those tests and restore it afterward, exercising the retained legacy default.
No actual system `/tmp` storage is used. The real mount and temp tests use the
normal configuration and actual scratch filesystem.

The new regression supplies a private mode-0700 directory, makes `/tmp` opens
fail independently, uses real anonymous-file/procfs/findmnt operations, checks
the returned mount ID against a separate root FD, asserts anonymous `nlink=0`,
mode 0600, exact O_TMPFILE/O_NOFOLLOW/O_EXCL flags, closed snapshot FD and empty
directory afterward. Refusal cases cover missing path, regular file, symlink
leaf, empty/relative TMPDIR, and an injected ENOTSUP error. They verify no
findmnt query or `/tmp` retry and preserve intentional absent/ancestor results.
Unsupported-filesystem refusal is fault injection, not a new native filesystem
qualification.

Compiled-adapter commands used the pinned compiler with `--ignoreConfig`,
`--module NodeNext --target ES2022 --types node --skipLibCheck` on only
`src/worker-codex/host-scratch-mount.ts`, writing `$V/build-baseline` and
`$V/build-green`. `$V/built-adapter.mts` loaded each emitted adapter directly;
this was not a full packaged runtime E2E.

## Handoff, hashes and limits

The linked-worktree common Git directory is masked. One `git status` attempt
failed; no escalation or add/commit/push/merge occurred. Main provenance is the
admitted base and must be verified by the parent. Original bytes were captured
before editing. The exact unified patch at `$V/artifacts/fix.patch` compares
those originals with the final owned sources, and adds this report.
`$V/artifacts/hashes.json` records originals, final files, lock and patch hashes.

| Owned source | Original SHA-256 | Final SHA-256 |
| --- | --- | --- |
| `src/worker-codex/host-scratch-mount.ts` | `c033ddc7c7c091c1b1cd791efc56dfc81712c3ca3078590920c54b05e2a9e23c` | `022482531a8dbc0ad290d6cab1afc68e79c82b52aa9957cf3fbfe17030e98993` |
| `src/worker-codex/tests/host-scratch-mount.test.ts` | `a2868bdcdb8633a1d2f69fc1e9793b88ab4f044fd2196c8c53d1d9e8442c2710` | `a3fb865d461e5e93ee8ea550cde1eccfd15f104af43d973932fd5db44dde7a83` |

Tradeoff: exact-mount observation now depends on the independently configured
existing TMPDIR supporting Linux O_TMPFILE. A bad configuration deliberately
refuses rather than spilling. With TMPDIR absent, the original `/tmp` default
still fails if `/tmp` is unavailable. This change does not validate scratch
volume policy using the observation directory or alter native storage authority.

Remaining gates: parent Git provenance/apply/integration, complete hosted
storage E2E, native mount propagation/namespace/cgroup/quota/lifetime behavior,
and broader storage acceptance. **Full A/B/C/P1 is not qualified by this fix.**
