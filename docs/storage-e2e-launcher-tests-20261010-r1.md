# Hermetic managed launcher construction tests

Task: `sr-storage-e2e-launcher-tests-20261010-r1`.
Requested base: `c50c948535e4840ae876022430a1dfc381054b7b`.
Verification performed on 2026-10-09 UTC.

## Scope and source provenance

The worker changes only `host-integration/managed-launcher/launch.node-test.mjs`,
the exact `test:host-storage` command in `package.json`, and this report.
Production launcher, policy, adapters and trust readers remain byte-identical.
All 16 existing launcher tests and their security assertions are retained.
No additional tests, handwritten harness files, production seams or environment
bypasses are introduced.

The source is the supplied linked worktree, copied before edits into job-owned
scratch. It is not an installed release or an older WIP. `git rev-parse HEAD` and
`git status` cannot access the masked common Git directory; the worker therefore
does **not** independently attest the commit identity or initial Git cleanliness.
The parent must verify the requested base and patch from the operator boundary.
`logs/source-before.json` records all 2,288 visible original source entries;
`logs/source-audit.json` records the final changed-file audit. Existing unrelated
content was preserved against that snapshot.

Original SHA-256:

| File | SHA-256 |
| --- | --- |
| `package.json` | `8b0480793816c0a3e96d8102c03fb2fdd60396c0d8ec6e819c38d60a97c498ba` |
| `launch.node-test.mjs` | `e9ed58219a1065c1ca8a4b533d3daeb6c591988b2349f436137b17f760c14a01` |

Original hashes are also recorded in `logs/original-sha256.txt`; final file and
patch hashes are in `SHA256SUMS`.

## Failure and correction

The unedited `npm run test:host-storage` reproduced **118 passed, 6 failed,
0 skipped** (124 tests, exit 1). Its six failing launcher construction tests
reached `governedFdProfile` -> `readHostedActivationMode` and raised
`hosted_activation_mode_invalid` against masked policy ancestry. The focused
unedited launcher run reproduced **10 passed, 6 failed, 0 skipped** (exit 1).
The production refusal is correct; construction tests should supply synthetic
inputs consistently with their existing trust, admission and executable seams.

The tests now use the existing Node `mock.module` facility while importing a
separate `launch.mjs?construction-test` module instance. Only that instance's
builder captures a synthetic baseline activation mode, no hosted origin, and
an explicitly absent FD inventory. For the readonly-anchor construction case,
the synchronous filesystem mock accepts only the exact fixed inventory probe
and throws a synthetic `ENOENT`; any other synchronous metadata probe fails an
assertion. It never reads Host policy, converts an actual read error to absence,
creates policy bytes, or fabricates trusted filesystem metadata.

Both mocks are restored in `finally` immediately after the separate builder
import. The original launcher, policy, payload guard, storage policy and profile
modules are imported before mocking. Existing payload guard and trust/admission
refusal assertions retain their original imports and explicit seams. Other test
files run in their normal isolated processes and install no construction mock.
The package command adds only `--experimental-test-module-mocks` to the existing
Node test invocation; no test is removed or skipped.

This uses the Node module mock API already used by the host transport tests.
It requires a Node version supporting the experimental flag/API. Verified Node
is `v24.21.0`; experimental and `namedExports` deprecation warnings remain
visible in the logs. This does not establish compatibility with every Node
version admitted by the package's broader `>=20` engine declaration.

## Isolated verification and evidence

Every dependency installation, build output, temporary file and cache was kept
under this unique job-owned scratch root:

```text
/srv/workers/jobs/subscription-runtime/storage-prevention-20261007/jobs/sr-storage-e2e-launcher-tests-20261010-r1/tmp/agent/launcher-hermetic.vpeu9paW
```

`baseline/` contains the original source and lockfile-installed dependencies;
`fixed/` contains the corrected source and shares those same scratch dependencies.
The standard `npm run build` generated the standalone policy and codec from
current source in scratch. The workspace received no generated files or
dependencies. npm `11.6.2` was downloaded into scratch and integrity-checked;
`npm ci --ignore-scripts --no-audit --no-fund` succeeded. The unchanged lockfile
pins TypeScript `6.0.3`, `@types/node` `22.20.0` and Vitest `4.1.8`.
`TMPDIR`, npm cache/config and XDG cache were explicitly directed to scratch.

Machine identity was read as `d856d40da5ad4e23b4f67773e5942842`. Initial available
memory was 43,713 MiB and disk was approximately 293 GiB. A recorded scratch
preflight showed 314,800,549,888 available disk bytes and 47,973,580 KiB available
memory, both above the 5 GiB owner floor (5,368,709,120 bytes).

| Command / gate | Result | Real log relative to scratch |
| --- | --- | --- |
| Baseline `npm run build` | exit 0 | `logs/baseline-build.log` |
| Baseline `npm run test:host-storage` | exit 1; 118 pass / 6 fail / 0 skip | `logs/baseline-host-storage.log` |
| Baseline `node --test --test-reporter=tap host-integration/managed-launcher/launch.node-test.mjs` | exit 1; 10 pass / 6 fail / 0 skip | `logs/baseline-launcher.log` |
| Fixed `node --experimental-test-module-mocks --test --test-reporter=tap host-integration/managed-launcher/launch.node-test.mjs` | exit 0; 16 pass / 0 fail / 0 skip | `logs/fixed-launcher.log` |
| Fixed `npm run test:host-storage` | exit 0; 124 pass / 0 fail / 0 skip | `logs/fixed-host-storage.log` |
| Fixed `node node_modules/typescript/bin/tsc --version` then `npm run typecheck` | TypeScript 6.0.3; exit 0 | `logs/fixed-typecheck.log` |
| Fixed `node node_modules/vitest/vitest.mjs run src/worker-codex/tests/hosted-optional-activation.test.ts --maxWorkers=1` | exit 0; 34 pass | `logs/fixed-trust-policy.log` |

The last gate exercises the unchanged production policy reader against real
disposable records with projected fixed paths and Host principal, including
invalid modes, unsafe ancestry, aliases, hardlinks, drift, retained grants and
EACCES refusal. It does not mock `readHostedActivationMode` and is independent
of the construction-module mocks. The host-storage gate also retains policy,
layout, installer and payload refusal coverage. These are source/fixture gates.

`launcher-test-only.patch` is the exact three-file patch. `SHA256SUMS` records
the three final files, patch, source manifests and real logs. The patch was
checked and applied to a disposable source copy, and its resulting three file
hashes were compared with the workspace; `logs/patch-check.log` records that
verification. No Git index, commit, push or merge operation was performed.

## Qualification boundary

The correction qualifies hermetic construction and the stated source gates
only. **Full A/B/C/P1 remains unqualified.** Synthetic activation, inventory,
trust/admission inputs and existing fixture tests are not physical qualification
or evidence of an installed Host's authority, mount lifetime, descriptor custody,
storage isolation or provider confinement. No host installation/configuration,
cgroups, mounts, quotas, credentials, signing, provisioning, real project launch
or agent runtime smoke was performed. Parent base/patch verification and any
separate physical qualification remain outside this worker's handoff.
