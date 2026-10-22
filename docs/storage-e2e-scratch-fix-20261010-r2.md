# Storage observation fixture correction, round 2

Task: `sr-storage-e2e-scratch-fix-20261010-r2`. This fixes only the
observation-cost fixture regression in the broker-materialized rejected input.
Admitted main: `c50c948535e4840ae876022430a1dfc381054b7b`.
Supplied rejected patch: `edba9216a9643511a74134e3d7b8b6a73ea24a25c4de5f062de0fd798090a002`.
Supplied reviewed output: `12b50137f250dd7acffd9931a16d3dfea47554fcabf35d7d26da48e401e9b2ca`.
Git's common worktree directory is sandbox-inaccessible; these provenance
identifiers require controller verification. No Git mutations ran.

## Reproduction and correction

Before editing, the unchanged normal Vitest configuration and an explicit real
private TMPDIR reproduced **60 passed, 15 failed, exit 1** across mount, temp
and observation-cost tests. All 15 failures were in the cost fixture: the
adapter used the explicit directory, while the fixture recognized only `/tmp`.
This independently confirms the supplied failure; its original log SHA-256
`c7296f63705f8a6d5fe85cc7cd66d81610a76503e7044c573ff35ec0255cf7d3`
is supplied evidence, not a log re-read in this sandbox. The r1 custom cost
configuration hid this regression by unsetting TMPDIR.

The fixture now owns the deterministic synthetic snapshot path
`/NEWTEST-observation-snapshot`, binds TMPDIR with `vi.stubEnv` in `beforeEach`,
restores it with `vi.unstubAllEnvs` in `afterEach`, and recognizes exactly that
path in its existing filesystem mock. No expected value comes from process.env.
Every test and topology, FD, current-state, namespace, error and closure
assertion remains. No tests, assertions or filters were added or removed.

Only `src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts` and
this new report change. Production source, strong native mount tests, unowned
temp tests and the historical r1 report remain byte-identical. Explicit existing
TMPDIR selection, unset-only `/tmp` default, FD-selected authority, exact
O_TMPFILE/O_EXCL/O_NOFOLLOW behavior and no retry remain unchanged.

## Environment and commands

Read AGENTS.md and both linked architecture documents fully. Before dependency
downloads, machine ID matched `d856d40da5ad4e23b4f67773e5942842`.
Findmnt and kernel mountinfo showed ext4, `/dev/nvme2n1p1`, device `259:1`;
workspace verification directories had matching device 66305 and mode 0700.
Available space was 301344088064 bytes, above the 5368709120-byte floor.
UUID `d0f2cac1-2009-4e9d-a710-e156f417938f` is **unverified here**:
findmnt's UUID field is empty and `/dev/disk/by-uuid` is inaccessible/absent.
Protected host configuration was not read. See `logs/environment.log`.

All downloads, dependencies, caches, builds, real TMPDIR and logs are in this
job's newly created ignored workspace directory; no other job artifacts were
reused. No native mounts, quota/cgroup/key/signing/host installation, credentials,
or real-project agent/provisioning operations ran. No handwritten harnesses or
custom Vitest configurations were used.

```sh
V=/srv/workers/jobs/subscription-runtime/storage-prevention-20261007/workspaces/sr-storage-e2e-scratch-fix-20261010-r2/.tmp-verification-r2
export PATH="$V/tools/bin:$PATH" TMPDIR="$V/temp" npm_config_cache="$V/cache" XDG_CACHE_HOME="$V/cache/xdg" NODE_COMPILE_CACHE="$V/cache/node"
cd "$V/verify"+npm ci --ignore-scripts --no-audit --no-fund > "$V/logs/npm-ci.log" 2>&1
node node_modules/vitest/vitest.mjs run src/worker-codex/tests/host-scratch-mount.test.ts src/worker-codex/tests/host-scratch-temp.test.ts src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts --maxWorkers=1 > "$V/logs/red-combined.log" 2>&1
# Copy the corrected cost fixture into this otherwise unchanged verification copy.
node node_modules/vitest/vitest.mjs run src/worker-codex/tests/host-scratch-mount.test.ts src/worker-codex/tests/host-scratch-temp.test.ts src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts --maxWorkers=1 > "$V/logs/green-combined.log" 2>&1
npm run typecheck > "$V/logs/typecheck.log" 2>&1
```

Node 24.21.0; newly downloaded scratch-local npm 11.6.2; locked TypeScript
6.0.3 and Vitest 4.1.8. Unchanged lock SHA-256:
`4de8cd9332eb1c95421482d66d3f6d076ef86aeb4b780558642bf071a6ad80f5`.
The normal combined gate after correction passed **75/75, exit 0**, with zero
skips (26 mount, 25 temp, 24 cost). Final pinned `npm run typecheck` ran once
and passed, exit 0, including artifact-pack, package build/typecheck, root
source, host-transport and lifetime-pin checks. Matching `.exit` files record
the actual statuses.

| Evidence under V | SHA-256 |
| --- | --- |
| `logs/red-combined.log` | `2136af90e978645c15dc364dae69ed51129858048d7bac6858998a238c888440` |
| `logs/green-combined.log` | `eccfe4454d9ba4502d75c4906507689916f55cb4625385e32a212e95ac688946` |
| `logs/typecheck.log` | `ba8354f349cee2822c178114e9056b3e90160b1f22aa4ecc2971b61d5092c460` |

## Handoff

The exact incremental unified patch against the materialized input is
`$V/artifacts/fix-r2.patch`; `artifacts/hashes.sha256` includes its digest and
the report digest. Original bytes are retained under `original/`. Workspace
before/after manifests verify preservation of all other existing files.

| File | Input SHA-256 | Final SHA-256 |
| --- | --- | --- |
| `src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts` | `af997670abfc4a500d4897fd483b6df789a581134a11babcbfd408f554ccdc3c` | `3455984c6ff39d720c7bb335e45251f75119514cf4a8b4accd65a5875332792c` |
| `src/worker-codex/host-scratch-mount.ts` | `022482531a8dbc0ad290d6cab1afc68e79c82b52aa9957cf3fbfe17030e98993` | unchanged |
| `src/worker-codex/tests/host-scratch-mount.test.ts` | `a3fb865d461e5e93ee8ea550cde1eccfd15f104af43d973932fd5db44dde7a83` | unchanged |
| `src/worker-codex/tests/host-scratch-temp.test.ts` | `b8e7039669b709e666f6fd2cd37a544587d78edead922934068ec9a212c1adbe` | unchanged |
| `docs/storage-e2e-scratch-fix-20261010-r1.md` | `ed927964ffbd877ff5c4678cdcf1fc8d9d9f9f073233ba363683a2aa927c22fc` | unchanged |

Remaining: independent second-round review, controller provenance/apply and
integration, full hosted storage E2E and native storage qualification.
**Full A/B/C/P1 remains incomplete.** Production's configured TMPDIR must still
exist and support anonymous files; this fixture correction changes no runtime
storage guarantees.
