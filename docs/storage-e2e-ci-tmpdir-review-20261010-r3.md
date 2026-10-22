# Independent PR369 private TMPDIR repair review — r3

**ACCEPT for the exact two-file TEST-only source repair and focused Linux verification.** Both required gates passed independently: 75 tests in the three specified files, with zero skips, and the complete pinned `npm run typecheck`. No source defect requiring a change was found. Native A/B/C/P1, C2, full E2E, new CI qualification, CI billing and host rollout remain unqualified.

This review owns only this report. The author deliverables are `src/worker-codex/tests/host-scratch-mount.test.ts` and `docs/storage-e2e-ci-tmpdir-capability-20261010-r3.md`. The test postimage was applied only inside this reviewer's ignored verification copy. Producer sources, the immutable input packet, other workers, root local drafts and production files were preserved. No commit, push, privileged installation, mount, quota/cgroup operation, signing/key operation, provider execution or real-project mutation was performed. Auth, sessions, registries and SQLite/WAL data were neither inspected nor changed.

The workspace is `/srv/workers/jobs/subscription-runtime/storage-prevention-20261007/workspaces/sr-storage-e2e-ci-tmpdir-review-20261010-r3`. All review-created data, TMPDIR, npm/cache data, downloaded tooling, dependencies, build output, mutation patches and logs are under its own `.tmp-ci-tmpdir-review-r3`; the verification cwd is `.tmp-ci-tmpdir-review-r3/verification`. The existing `.gitignore` already excludes `.tmp-*`. This report is the sole source handoff file.

The root supplied `.tmp-ci-review-input-r3` before review execution. I verified every supplied SHA256 and byte count, checked the untracked archive contains only the author report and equals its supplied postimage, and verified the patch with `patch --dry-run --batch --fuzz=0 --strip=1`. Applying it to the verification copy reproduced the test postimage byte for byte. The author report was read, never applied to that copy. Final checks repeated the input hashes and source comparisons after all verification.

The base binding is the immutable root packet's HEAD/base `a3e4b6893fcc7c7748608889e78c043ac8effaf3`, selected from the completed source workspace as instructed. Independently recomputing Git blob/tree objects from all **2,292 exported source files**, including executable modes and directory ordering, produced tree `1ec022fd0be0b8a2c0352e9a82f72957dedfbd92`, exactly the packet's HEAD tree, both before copying and at final audit. Patch blob identities also matched `0f7332f43febee3403f0cdecd6a4ca53575c8995` → `679b62fc5e547abea150673f19815dd571da2077`. Hidden Git metadata supplied no verification: `git status` failed with the masked linked-worktree gitdir unavailable. The commit-to-published-PR association comes from the supplied root packet and task; no independent remote publication/signature check is claimed.

Integrity anchors:

| Input | SHA256 |
| --- | --- |
| Root input manifest | `5c74d53f2424eefd3c58d562f3e67fa4be3d94bf2c3788be4b25ed66364f1996` |
| Terminal packet manifest | `97ef23a8b0be5f3fc07ec136ea291805e031617c3d11a956c121245a60385e38` |
| Exact test patch | `75b960863f616abc630e198c0fb298496526a03a1bcb90e442ab54964fbd8929` |
| Untracked author-report archive | `d0c100da58797f25298ebea881cf612227e3fdab8ad85af01f459825955f7329` |
| Author report | `5f8a0b22e862fc7c2095ffec88d0382b237b94ae2740c78ee1835020fb1bbf5b` |
| Base test | `a3fb865d461e5e93ee8ea550cde1eccfd15f104af43d973932fd5db44dde7a83` |
| Reviewed/restored test | `dec8265526862543808f9e3ec7f6eaa2a7621c7fa67b40c7240c0e83b6becf11` |
| Production adapter, unchanged everywhere at handoff | `022482531a8dbc0ad290d6cab1afc68e79c82b52aa9957cf3fbfe17030e98993` |
| Project lock, unchanged | `4de8cd9332eb1c95421482d66d3f6d076ef86aeb4b780558642bf071a6ad80f5` |

The packet reports author terminal status `failed_checkpoint_unprotected`. The author report accurately admits its Vitest command failed with `MODULE_NOT_FOUND`, npm was absent, and neither tests nor typecheck ran. Its successful syntax check is not acceptance evidence. Those author limitations remain recorded; the green results below are this independent review's checks.

Historical negative capability evidence is the supplied actual CI run `38006936107`, job `114077775145`, unit shard4: only the new private-TMPDIR test failed with `ENOTSUP/open/configured-directory`, while 144 files / 1,603 tests passed. I did not refetch or rerun that CI job. Production's strict refusal was correct and is unchanged.

The repaired case makes a mode0700 private directory under the review TMPDIR and probes that exact directory with `O_TMPFILE | O_RDWR | O_NOFOLLOW | O_EXCL`, mode0600, **before installing either spy**. A successful probe FD closes in `finally`. Only an actual `Error` with the exact `ENOTSUP`, `open` and selected-directory triplet selects the refusal branch. Other errors propagate. The raw syscall flags equal decimal `4391042`; no filesystem-name assumption chooses the branch.

| Reviewed behavior | Evidence and assessment |
| --- | --- |
| Supported branch | Passed locally with real anonymous FD, kernel topology and real `findmnt`. The mutable builtin-export wrappers retain native operations; the execution spy has no replacement implementation. The test independently opens the real root and reads its FD mount ID, checks the adapter's root target/mount ID, flags/mode0600, nlink0 and snapshot closure (`EBADF`). Existing real-root coverage also checks the complete tuple. |
| Unsupported branch | Source requires the real adapter to throw the same exact error triplet, zero external executions, an actual selected-directory open attempt with the exact flags/mode, no `/tmp` attempt and no named leftovers. Returning success, absence, or an unrelated error would fail. No fake FD, successful anonymous-file emulation, skip or environment fallback was added. Historical CI supplies real unsupported-kernel evidence; this branch was not natively reproduced here. |
| Common assertions | Both branches require an attempted selected directory, an empty directory and no `/tmp` fallback. These assertions remain outside the capability conditional. |
| Unexpected errors | Independent copy-only injections of probe `EACCES`, `ENOTSUP/stat`, and `ENOTSUP/open/wrong-path` each failed the repaired test at the classifier, exit1. These are error-propagation checks, not claimed unsupported-kernel qualification. |
| Cleanup and restoration | The test's outer `finally` removes its own directory; existing `afterEach` restores mocks and all stubbed environments. An extra temporary reviewer witness passed after the native green case and after every induced failure, confirming original TMPDIR/open/exec functions and no private-directory leaks. The witness was removed before the final 75-test run. |
| Meaningful red regression | Replacing only the verification adapter's selected observation directory with hardcoded `/tmp` made the repaired test fail with injected `ENOENT: System /tmp unavailable`, exit1. The restoration witness still passed. On an unsupported kernel, the same mutation would fail the required `ENOTSUP/open/selected-path` assertion; that second-branch conclusion is source reasoning, not an executed native result. |
| Other tests and production scope | Final full-source hashing found zero changes to the original 2,292 source files and exactly one changed source path in the verification copy: the supplied test. Both other requested test files, package/config files and the production adapter retain their original hashes. No tests were removed. |

Machine/device/capacity checks preceded creating review scratch or downloading data. `/etc/machine-id` matched `d856d40da5ad4e23b4f67773e5942842`. An independently opened directory FD selected the visible ext4 scratch device `/dev/nvme2n1p1`, major/minor `259:1`, with **239,754,059,776 available bytes** against the **5,368,709,120-byte (5GiB) floor**. This is a capacity floor, not a claim of a 5GiB volume. RAM was 67,194,380,288 bytes total and 45,958,832,128 bytes available. Hidden duplicate same-target mount rows were not used as authority. Mount IDs are namespace-local and change between sandbox invocations. `findmnt` returned no UUID/label values; no expected UUID match is claimed and UUID/label values are withheld here. These checks verify the visible device and capacity for review storage, not native volume qualification.

The separate `native-capability.mjs` helper again verified that device/memory floor and executed the exact syscall inside an owned private directory. It observed success, nlink0/mode0600, closed FD/EBADF, no named leaks and directory removal. Both writable owned roots expose the same ext4 scratch device; no owned writable alternate filesystem was available. I did not mount anything or adopt a foreign path to manufacture a native unsupported run.

Installed-tool inspection found Node v24.21.0, no usable npm and no installed project dependencies. Under the explicitly authorized scoped bootstrap, I downloaded npm **11.6.2** from its exact public registry version endpoint and verified the tarball's registry SHA512 integrity and SHA1 before extraction. Its retained SHA256 is `585f95094ee5cb2788ee11d90f2a518a7c9ef6e083fa141d0b63ca3383675a20`. The downloaded generic npm shell launcher initially failed looking for `npm-prefix.js` beside host Node; that failed attempt is retained as `logs/npm-ci.*`. A local wrapper executing the verified `npm-cli.js` solved it without host/global installation. Actual `npm --version` returned 11.6.2. `npm ci --ignore-scripts --no-audit --no-fund` installed 154 packages into the verification copy; lock bytes remained unchanged. Installed Vitest4.1.8 and TypeScript6.0.3 match the pinned project lock.

All commands below used the exact source copy and existing project configuration. No config replacement, worker override, compiler-flag loosening or syntax-only substitution occurred. The declared `npm run build:packages` supplied the workspace package's exported dist files before tests. Typecheck ran its complete declared chain: artifact-pack typecheck, package build, root source typecheck, package typecheck, host-transport typecheck and lifetime-pin typecheck.

| Actual command in verification cwd | Exit | Retained log/result |
| --- | --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | `logs/npm-ci-pinned.log`; pinned dependency install |
| `node ../native-capability.mjs` | 0 | `logs/native-capability.log`; independent real syscall |
| `npm run build:packages` | 0 | `logs/build-packages.log`; existing declared build |
| `npm run test:unit -- src/worker-codex/tests/host-scratch-mount.test.ts src/worker-codex/tests/host-scratch-temp.test.ts src/worker-codex/tests/host-scratch-mount-observation-cost.test.ts` | 0 | `logs/targeted-vitest.log`; 26+25+24 = 75 passed, zero skips |
| `npm run typecheck` | 0 | `logs/full-typecheck.log`; complete normal chain, 53.40s |
| `python3 ../mutation-checks.py` | 0 | `logs/mutation-checks.log`; native cleanup green plus four expected red failures, exact sources restored |
| Same three-file `npm run test:unit -- …` command after restoration | 0 | `logs/targeted-vitest-final.log`; 75 passed, zero skips |
| `python3 ../audit-source.py` after restoration | 0 | `logs/source-audit-final.log`; packet and full source integrity passed |

The red/hygiene runs selected two cases with `-t 'unavailable system /tmp|reviewer verifies environment'`. Their 25 filter-excluded cases are not counted as passes or acceptance skips. Each red run had one required failure and one restoration-witness pass. The unmodified final acceptance run executed all 75 cases. Mutation patches, exact source hashes, commands and exit statuses are retained, and the final test and adapter bytes equal the reviewed postimage and base respectively.

Evidence lives at [`.tmp-ci-tmpdir-review-r3`](../.tmp-ci-tmpdir-review-r3): `packet-integrity.json`, `copy-integrity.json`, `host-preflight.json`, `source-baseline.json`, `source-audit.json`, `mutation-results.json`, `tools/npm-integrity.json`, and `logs/`. Every runner invocation has an exact argv/cwd/environment `.command.json`, combined `.log`, and terminal `.exit`. `commands.json`/`commands.txt` index the commands, and `evidence.sha256` covers the retained small artifacts and report. `run-command.py`, `audit-source.py`, `native-capability.mjs` and `mutation-checks.py` retain the runnable verification logic. TMPDIR/TMP/TEMP, XDG/node/npm caches and npm config are explicitly scoped there; downloaded npm and all generated dependencies/builds stayed in the copy.

There is no remaining blocker for this narrowly scoped source/test acceptance. The missing native unsupported replay, unavailable UUID/label identity, supplied rather than remotely authenticated commit/CI association, and absence of new full CI/E2E/rollout evidence are material limits. This report independently validates the supplied source and focused Linux checks only; it grants no native A/B/C/P1/C2, billing or host-rollout qualification.
