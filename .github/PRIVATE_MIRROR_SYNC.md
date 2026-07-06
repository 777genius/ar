# Private Mirror Sync

This repository pulls updates from the canonical runtime repository. The
canonical repository does not push here and does not need to know this mirror
exists.

## Secrets

Set `CANONICAL_REPO_TOKEN` in this repository if the canonical repository is not
public. Use a fine-grained token with read-only Contents access to the canonical
repository.

Publishing uses this repository's `GITHUB_TOKEN` with `packages: write`.

## Sync Flow

1. `Sync Canonical` fetches the canonical ref.
2. It merges that ref into `sync/canonical-main`.
3. It reapplies private package metadata and package scope.
4. It runs typecheck and boundary checks.
5. It opens or updates a PR inside this private repository.

Manual dispatch can override the canonical ref and package version.
