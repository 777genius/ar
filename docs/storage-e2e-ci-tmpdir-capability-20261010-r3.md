# PR369 private TMPDIR capability repair

This is a TEST-only repair for task `sr-storage-e2e-ci-tmpdir-capability-20261010-r3`, intended for source branch `fix/storage-scratch-launcher-e2e` at published head `a3e4b6893fcc7c7748608889e78c043ac8effaf3`. The supplied worktree's Git metadata is masked: read-only `git rev-parse HEAD`, branch and status inspection failed with `fatal: not a git repository` for its linked-worktree metadata path. The exact published-head identity therefore remains unverified locally. No Git mutation, installation, production change, policy change or native B1/C2 work was performed.

The retained negative capability evidence is the task's actual GitHub CI observation: PR369 run `38006936107`, job `114077775145`, unit shard4, approximately four minutes; 144 files / 1603 tests passed and exactly one test failed. The case previously named `unavailable system /tmp uses explicit private TMPDIR for anonymous observation only` failed with `ENOTSUP`, syscall `open`, path `/tmp/scratch-mount-observation-r3W7ZW` (test line67 → adapter line117 → test line84). This evidence was supplied in the task, not fetched or rerun here. The production strict refusal is correct; this local ext4 observation does not reproduce that CI filesystem's negative capability.

Only `src/worker-codex/tests/host-scratch-mount.test.ts` and this report are source deliverables. The existing case now independently opens its newly created mode0700 private directory with exactly `0x410000 | O_RDWR | O_NOFOLLOW | O_EXCL`, mode0600, before installing the open spy. It closes a successful probe FD. Only the kernel's exact `ENOTSUP/open/configured-directory` selects the unsupported branch; unexpected errors propagate and fail.

The supported branch still invokes the real adapter, independently witnesses the real root FD/mountId, uses real kernel topology and real findmnt, checks anonymous-open flags/mode0600, nlink0, snapshot closure/EBADF, an empty directory and no `/tmp` fallback. The unsupported branch invokes the real adapter with the same configured directory and `/tmp`-unavailable fault, requires exact `ENOTSUP/open/that-directory`, checks flags/mode before the attempted real open fails, requires zero findmnt calls, no `/tmp` attempt and no named leftovers. Both branches explicitly assert that the adapter attempted the selected directory. No fake FD, successful anonymous-file emulation, unsupported-environment skip or TMPDIR unsetting was introduced. Existing other cases remain intact.

The named red condition is **old hardcoded-/tmp adapter ignores selected private TMPDIR**. It fails the supported branch through the injected `/tmp` fault instead of producing the required real result. It fails the unsupported branch because that fault is `ENOENT` rather than the required `ENOTSUP/open/configured-directory`; the common selected-directory/no-fallback assertions also reject hardcoding. This is a contract argument, not an executed mutation test in this environment.

Host evidence is retained under the ignored workspace directory `.tmp-ci-tmpdir-r3`. The independent TypeScript helper `host-capability.ts` read machine ID `d856d40da5ad4e23b4f67773e5942842`, associated the real directory FD with visible mount ID187528 on ext4 `/dev/nvme2n1p1`, and checked available space248735285248 bytes against floor5368709120 bytes (5GiB). The duplicate same-target mount ID187511 is explicitly recorded as **hidden**, not used as visible authority. Mount IDs are namespace-local observations from that helper invocation. The exact anonymous syscall succeeded with nlink0 and mode0600, closed its FD and left the private directory empty. Expected scratch UUID is `d0f2cac1-2009-4e9d-a710-e156f417938f`; UUID verification remains incomplete because the bounded findmnt query returned no UUID. Filesystem type alone does not prove UUID identity or capability.

All created temporary directories, logs, evidence, helper and patch files are under this job's own ignored workspace `.tmp-ci-tmpdir-r3`. TMPDIR and cache locations for checks were explicitly set there; no HOME/system fallback or global install was used. No dependencies or builds were created. Existing pinned lock bytes were preserved.

Actual required checks used normal repository configuration with no custom worker configuration:

| Command | Exit | Evidence and result |
| --- | --- | --- |
| `node .tmp-ci-tmpdir-r3/host-capability.ts` | 0 | `logs/host-capability.log`, `logs/host-capability.exit`; real independent host/capability observation |
| `node node_modules/vitest/vitest.mjs run src/worker-codex/tests/host-scratch-mount.test.ts src/worker-codex/tests/host-scratch-temp.test.ts src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts` | 1 | `logs/targeted-vitest.log`, `logs/targeted-vitest.exit`; `MODULE_NOT_FOUND` for absent local Vitest; no tests executed |
| `npm run typecheck` | 127 | `logs/typecheck.log`, `logs/typecheck.exit`; installed npm unavailable (`npm: command not found`); no typecheck executed |
| `node --check src/worker-codex/tests/host-scratch-mount.test.ts` | 0 | `logs/syntax-check.log`, `logs/syntax-check.exit`; syntax only, does not resolve imports or check types |
| `patch --dry-run --reverse --strip=1 < .tmp-ci-tmpdir-r3/repair.patch` | 0 | `logs/patch-integrity.log`, `logs/patch-integrity.exit`; both owned deliverables match the patch; dry run made no source changes |

Node is v24.21.0. The visible `/usr/local/bin/npm` symlink points to an unavailable npm binary in `/opt/nodejs/node-v24.21.0-linux-x64/bin`. `node_modules` is absent. Installation is explicitly prohibited, so neither missing dependency nor missing supported npm was substituted. No unrelated full suite was repeated.

Continuation audit: the previous goal turn made concrete progress by implementing the repair and collecting host/failed-check evidence. A fresh bounded availability check still finds no `node_modules` or npm binary. The additional syntax and patch-integrity checks pass, but they do not satisfy the required Vitest/typecheck gates. The goal remains active and acceptance remains unproven pending those external prerequisites.

Source SHA256 evidence (`sourcehash-before.txt` and `sourcehash-after.txt`):

| File | Before | After |
| --- | --- | --- |
| `src/worker-codex/tests/host-scratch-mount.test.ts` | `a3fb865d461e5e93ee8ea550cde1eccfd15f104af43d973932fd5db44dde7a83` | `dec8265526862543808f9e3ec7f6eaa2a7621c7fa67b40c7240c0e83b6becf11` |
| `src/worker-codex/host-scratch-mount.ts` | `022482531a8dbc0ad290d6cab1afc68e79c82b52aa9957cf3fbfe17030e98993` | same |
| `package-lock.json` | `4de8cd9332eb1c95421482d66d3f6d076ef86aeb4b780558642bf071a6ad80f5` | same |

The exact two-file handoff patch is `.tmp-ci-tmpdir-r3/repair.patch`; the test-only diff is also retained as `test-repair.patch`. `commands.txt` records verification commands and `handoff.sha256` records patch/report hashes. These workspace artifacts survive provider exit. No commit/push/merge was attempted. AGENTS.md and both linked architecture documents were read; the change adds no runtime orchestration or provider/domain coupling.

Ready for separate independent6.1xhigh review of the concrete test patch, with explicit validation limitations. Before acceptance, the controller must verify the pinned source head and scratch UUID and run the prescribed targeted tests and pinned `npm run typecheck` using available installed dependencies/npm. Neither required check is green here. Full A/B/C/P1/CI/rollout remains incomplete; this repair alone does not establish integration or rollout readiness.
