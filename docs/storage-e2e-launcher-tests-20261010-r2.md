# Development Node prerequisite correction

Task: `sr-storage-e2e-launcher-tests-20261010-r2`.
Bounded documentation successor for R2-NODE-1; ready for second independent review.

## Change and provenance

README Development now specifies Node.js 22.23.3 or a newer maintained 22.x,
or the verified Node.js 24.21.0 worker profile, with newer 24.x using the
project-supported profile. The prerequisite sits beside `npm ci` / `npm run check`
and references checked-in CI Node 22. Runtime consumer wording and package
engines `>=20` remain unchanged. Only README and this new report are edited;
the r1 report remains a historical input.

Requested broker-materialized rejected source candidate:
`33caffec9a5f27c11c3582330bf9c2139fdde56ce555a73269cea1cfcc1e7060`,
over main `c50c948535e4840ae876022430a1dfc381054b7b`.
Git common metadata is masked: local Git cannot establish commit provenance or
the full workspace diff. Parent verification of provenance and diff is required.
The three supplied source hashes were compared locally and match exactly:

| Immutable input | SHA-256 |
| --- | --- |
| `host-integration/managed-launcher/launch.node-test.mjs` | `f2751bcdf8358f7da874b19e4ae4d1137ad5b72d5c00ee3c90242b05cec8c320` |
| `package.json` | `90ef7f152442a20e3d508a320793876f476056bc307658d6cf7c42e11bb941b9` |
| `package-lock.json` | `4de8cd9332eb1c95421482d66d3f6d076ef86aeb4b780558642bf071a6ad80f5` |

## Reused evidence, no rerun

The supplied independent 6.1 xhigh source audit accepted module-mock isolation,
all 16 retained security tests, and unchanged production readers. After the
matching hash comparison above, this correction reuses the previously proved
results reported in the task instruction:

| Profile | Previously proved result, reused |
| --- | --- |
| Node 24.21.0 | Host-storage baseline 118 pass / 6 fail -> corrected 124 pass / 0 fail; full pinned typecheck exit 0; unchanged trust suite 34 pass / 0 fail |
| Official Node 22.23.3 | Corrected host-storage 124 pass / 0 fail; unchanged trust suite 34 pass / 0 fail |
| Node 20.18.0 | Test import fails with `ERR_INVALID_ARG_TYPE`: `mock.module` URL object support differs despite the API being present |

These are reused results, not tests executed by this documentation correction.
No dependency installation, new test, helper, heavy gate or full `npm run check`
was performed. This does not claim development-test compatibility for every
Node 20 or 22 version, or qualification of newer 24.x profiles.

## Local checks and artifacts

AGENTS and both linked architecture documents were read in full. Visible
preflight identified `/dev/nvme2n1p1`, ext4, with 301,003,366,400 available bytes,
above the 5 GiB floor (5,368,709,120 bytes). Machine identity was read as the
expected `d856d40da5ad4e23b4f67773e5942842`. The expected scratch filesystem UUID
is `d0f2cac1-2009-4e9d-a710-e156f417938f`; UUID is hidden in the visible mount
view and was not independently verified. No privileged probe was attempted.

Unique ignored workspace scratch `.tmp-doc-fix-r2/` holds the exact
`documentation-only.patch`, report copy, `SHA256SUMS`, visible preflight,
immutable before/after hashes and patch verification. The patch is checked and
applied to a disposable scratch copy; resulting README/report bytes are compared
with the workspace. Launcher, package, lockfile and r1 hashes remain unchanged.
No code, flags, mocks, assertions, production readers/policy or workflows were
modified; no other job content was reverted.

## Qualification boundary

R2-NODE-1 has its requested documentation correction; second independent review
and parent provenance/diff verification remain pending. Full A/B/C/P1,
dedicated verifier, exact CI and physical qualification remain separate and
unqualified. No commits, pushes, merges, installation, credentials, signing,
privileged/native actions, provisioning or real-project agent runs occurred.
