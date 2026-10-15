# Subscription Runtime public source

`777genius/ar` is the public source repository for reproducible Subscription
Runtime builds. New development and pull-request delivery use this repository. Existing source
synchronizations retain their provenance without importing private Git history.

- Consumers must pin a full reviewed commit SHA and build that source.
- Package publication remains temporarily owned by
  `vioxen/subscription-runtime` while existing consumers are migrated.
- This repository intentionally contains no package-publishing workflow.
- Existing tags are retained so previously published builds remain
  reproducible.

## Reviewed source synchronization

The October 2026 synchronization uses reviewed source commit
`f97607a56c2a5e1c39cd98572beb858525eb82b2`, tree
`d2966ece9dede4b1aeba9c07210e975f74450949`. It copies tracked source files only;
private Git objects, commit ancestry, runtime state and credentials are excluded.
The public Apache license, security policy and secret-scanning configuration are
preserved. Package metadata points to this repository; package publishing
workflows remain excluded. The CI observer mount gate keeps the same executable
body on a stock Ubuntu 24.04 runner.


## October 15 retention composition

The retention port composes public parent
`da1eac3290530857f65b97c1ecb08f581ea43335` with reviewed retention source
`88fb4a926a5a28649334323fc5f57822e624837e`, using the actual common source
ancestor `3a7fe6bdfb3589f5aa9819fe5b17c22badfd1737`. This is a source composition,
not a claim that the whole public tree equals the retention tree. Public-only
source changes, Apache licensing, repository metadata, secret-scanning policy
and existing reproducibility anchors are retained.

CI composes the retention SOURCE/root, observer, unit, crash and package gates
with public Ubuntu 24.04 fallback runners, pinned actions, authless checkouts and
the scrubbed public legacy-ledger fixture
`7d6d19a096f2cd0e3772f8369e6e09034c8b4280`. The retention TEST
workflows use disposable GitHub-hosted Ubuntu VMs without provider credentials;
private-only RPC diagnostic upload is excluded. Package publishing workflows
remain excluded, and the public lockfile is retained because dependency inputs
are unchanged. This source port does not establish native qualification,
production activation, completed TEST execution or successful CI.

The bounded MiMo diagnostics are composed from reviewed source
`a8db35fc4b29e35393768d0faed72d3e63033e60` relative to its diagnostic base
`ba1b2814a4dbbae216ad905ef04d4d09ba83bc12` (15 source/test paths), retaining the public driver and validation
behavior. These source IDs describe inputs, not the identity or qualification
of the resulting public commit.

## Shared development history

New changes are committed and reviewed in `777genius/ar`. When the private
package-publishing repository needs those changes, merge the public commits
there so their original public commit IDs remain intact. Existing private and
public branches, tags and pull requests remain available; source translations
record their original source IDs and do not claim identical commit IDs. Do not
rewrite either repository history or replace public-only fixes when bringing
over an older private pull request. Package publication remains separate from
this source-development transition.

The standalone npm local-input and Vite/Vitest cache TEST workflows are retained
from source `88fb4a926a5a28649334323fc5f57822e624837e`, with pinned actions and
exact public-head checkout. They use fresh Ubuntu TEST filesystems, retain their
original assertions, and grant no runtime admission or eviction authority.
