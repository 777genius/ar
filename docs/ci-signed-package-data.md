# Reproducing The Signed CI Package Image

The H1 DATA test intentionally consumes one previously qualified package vector.
Its 41 package versions, archive sizes and SHA-256 hashes are pinned in
`scripts/dependency-retention-os-test/current-h1-qualified-package-image.ts`.
This is a reproducibility fixture for a disposable CI job, not an update policy
for a deployed host.

On 2026-10-23, [main CI run 39968646995](https://github.com/777genius/ar/actions/runs/39968646995)
failed in `exact-five-seed-solver-and-download`. The retained `command-18.json`
reported that `zlib1g=1:1.3.dfsg-3.1ubuntu2.2` was absent. Its authenticated
moving indices contained `1:1.3.dfsg-3.1ubuntu2.3` instead. Repeating that fetch
cannot restore the pinned version to a moving mirror.

The test now uses the official Ubuntu snapshot `20261022T180000Z` for all three
pockets (`noble`, `noble-updates`, `noble-security`). All 41 pinned identities
were verified against the snapshot's complete main package indices, after
`gpgv` verification with the existing independently fixed Ubuntu archive key.
The package vector and its digest remain unchanged.

Ubuntu documents [snapshots for reproducible package selection](https://snapshot.ubuntu.com/)
and [verification of old package versions](https://documentation.ubuntu.com/security/software-integrity/archive-verification/#validating-old-versions).

## Invariants

- Keep the fixed Ubuntu primary signing fingerprint and `gpgv` success check.
- Authenticate each complete `Packages` and `Sources` index against its signed
  `InRelease`; retain the original expiry check when `Valid-Until` is present.
- Match downloaded archive identity, version, architecture, size and SHA-256
  against one authenticated stanza and the unchanged qualified vector.
- Read source-extraction transfer URLs only from the same fixed snapshot;
  reject another host, timestamp, credentials, query, fragment or path escape.
- Preserve the root test inventory, physical qualification, data limits and
  fail-closed outcomes. A network failure still fails the job.

When changing the qualified image, review and requalify the package vector and
its dependent source/physical evidence together. Do not substitute whatever
version a current mirror offers or disable authentication to make CI pass.
