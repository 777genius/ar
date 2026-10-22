This generated TEST fixture freezes the original writer observation composition
from source commit `00bbb0f060779a884c307c3d4a95a84a9ffd38ae` (tree
`1c9f5cd0e902b24e3b331b156884ad19f9f30bca`). It is never installed or deployed.

`bundle-inputs.json` records every source/dependency input hash, the pinned
Rolldown 1.0.3 version, all seven output hashes and their relative import closure, and each original module's installed path.
All static dependencies are bundled; the remaining imports are Node builtins.
Workspace dependencies resolve to that commit's TypeScript source, rather than
mutable generated workspace output. Every output passed Node syntax checking.
The generated bundle is deliberately kept
separate from handwritten tests.

The TEST entry wrapper increments one namespaced module-load counter and adds
one readonly export alias for the original installed-runtime
getter. Each inlined module retains its original `import.meta.url` location
relative to the relocated TEST artifact. The test asserts the original getter
sees the historical runtime while the current observer sees a different runtime.
Only the exact historical writer module URL receives a TEST backing-file route.
The counter records actual entry execution, not cached import attempts; the
second admission also requires zero old material qualification traversals.
Its reader executes original native authority code; no Released callback or
closure receipt is substituted.

The pinned bundler requires multiple chunks for this cyclic graph; its single-chunk
output contained invalid async initialization and was rejected before acceptance.
This bundle differs from deployed artifact packaging. Proc, systemd, root
custody and mount observations use the existing explicit offline Host fixture.
Passing this regression proves the composition and fresh-read invariant, not
native Linux execution, production artifact qualification, or measured speedup.
