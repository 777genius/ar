# Subscription Runtime public source

`777genius/ar` is the public source repository for reproducible Subscription
Runtime builds. New development and pull-request delivery use this repository. Existing source
synchronizations retain their provenance. The current integration additionally preserves
the authorized private commit history through an ordinary merge parent.

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
at that historical stage private Git objects and commit ancestry were excluded.
That source-only history policy is superseded by the all-history integration below;
runtime state and credentials remain excluded.
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

## October 16 shared-history integration

The owner explicitly requested preserving all private commits and other PR history,
with the same original commit IDs. The reviewed integration is prepared to compose public development
parent `6fc333b7230412e4919681db5a7be2e64789d3b5` and private main parent
`211945742cb7a09f7b133419effa37a6530fb79f` through an ordinary two-parent merge.
On that normal merge commit, the 1,510 private commits absent from the public parent
will remain reachable through
the private parent; there is no squash, rebase, force rewrite or synthetic history.

Source composition uses reviewed private source anchor
`f97607a56c2a5e1c39cd98572beb858525eb82b2` to distinguish intentional public
translation and subsequent public development from later private source changes.
All 798 endpoint differences were classified: 682 paths retain private anchor
bytes while public source evolved, and 116 require private post-anchor carry or
explicit semantic resolution. Public architecture, retention and error handling,
Apache licensing, repository metadata and CI/publication separation are preserved.
A public extracted factory receives the corresponding private changes in its
current module. The integration records an exact reviewed final tree rather than
claiming equality to either parent.

A bounded automated scan covered all 6,112 private-only historical blobs
(101,915,061 bytes), with no skipped blobs. Its 22 private-key-marker matches were
verified as synthetic test sentinel literals without key bodies. This records the
scan's explicit pattern scope, not a universal guarantee about arbitrary secrets.
Runtime state and provider credentials are never migrated as source assets.

The final public integration must be merged back into the latest private main
through an ordinary merge, retaining the public commit IDs and any newer private
commits. Fetch and reconcile both tips before that backsync. Package publishing
remains private; no public package-publishing workflow is introduced.

This provenance does not establish successful exact-head CI, completed native
TEST execution, all-eight retention acceptance, production activation or merge
readiness by itself. Historical native `057204e44575a507c2168d7bdb0d3750e21329f0`
receipts retain their original source/package identities and may support only
explicitly unchanged properties; the integrated package adds the reviewed private
`undici` dependency and requires its own source/build/consumer-closure validation.
