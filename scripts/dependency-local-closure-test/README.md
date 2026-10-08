# Exact npm local closure TEST qualification

This fixture qualifies actual **npm 10.9.9** semantics for the accepted local capture/key contracts. It is source-only until independent review and exact-head CI succeed. It adds no production dependency, grant, profile issuer, Ready receipt or cleanup operation.

The dedicated workflow uses a new Ubuntu 24.04 hosted VM and Node 22.23.3. It installs the exact npm release in the disposable CI toolchain, builds the repository and typechecks these TypeScript files against the built declarations before running Node type stripping. No local execution or real user project belongs to this lane.

The harness refuses non-Linux/non-x64/non-GitHub-CI execution. It registers one new private `dependency-local-closure-TEST-*` filesystem under the actual runner temp directory. Two bounded original input projects and separate lock generators are authored only there. No pre-existing project is copied or accepted. npm stdout/stderr and inherited credentials/configuration are not persisted. Uncertain commands fail without a retry, replacement launch or cleanup; TEST data remains for the disposable VM lifetime.

Both fixtures use the exported `dependencyLocalNpmArgv` and fixed no-lifecycle npmrc contents, separate user/global config files, umask 022 and a clean environment. HOME/cache/config/TMP paths are fresh standalone CI leaves, rather than the managed namespace's logical paths. That explicit transport difference prevents this semantic proof being mistaken for a contained installer certificate.

The workspace fixture has a literal `packages/a` workspace depending on a packed leaf via `file:../b`. The root-only fixture directly depends on `file:packages/b`. Actual npm generates each lockfile in its separate fresh generator; no lock entries are synthesized or normalized. Original source setup receives those lock bytes before its preservation baseline. Each original is a real new Git repository with an empty template and no commits. `git check-ignore --no-index --quiet` proves the needed packed output is ignored by its actual root `.gitignore`.

The two initial npm ci invocations and one changed-ignored-input reinstall run directly on these new TEST originals. The complete original inventory excludes only deliberately generated root `node_modules`. Every other file/link/directory, including actual `.git`, keys/state/results/source sentinels, package manifests, locks, ignored outputs and unselected source, must retain bytes, physical identity, mode and membership across each npm invocation. Explicit source edits between observations are test stimuli; the fixture does not describe those authored changes as preservation.

| Independent assertion | Concrete regression it catches |
|---|---|
| Exact actual npm CLI/package version, full canonical npm-tree hash, Node/ELF/libc facts before and after | Wrong toolchain or changed npm implementation produces an apparent pass |
| Generated lock qualifies the actual production capture/key unchanged | Synthetic lock assumptions differ from npm 10.9.9 output |
| Actual `a` link has raw target `../packages/a` and resolves to the original workspace; real Node require reads original code | Wrong declaring-package topology, packed workspace or incorrect link coordinates |
| Complete installed membership is root-only and no workspace-local node_modules exists | Claimed hoisting actually needs nested output or installs packed development edges |
| Independently authored mandatory README/COPYING/LICENSE/LICENCE case/extension variants and executable consumed leaf are installed byte-for-byte with exact modes | A mandatory original input is omitted by capture/pack selection or mode identity is lost |
| Editor backup variants and unselected source are absent | A broader pack closure enters installed dependencies |
| Actual ignored dist output is installed, remains unchanged in the original and a changed byte produces a key miss/new installed behavior | Ignored consumed inputs are omitted from identity or npm still consumes stale bytes |
| Pure workspace code edit changes real require behavior while its key stays stable; local manifest edit misses | Pure linked source is over-keyed or dependency metadata is under-keyed |
| Packed dev metadata remains present in installed package.json but has no installed development graph; its original metadata edit misses | Packed metadata is discarded or incorrectly treated as installed dev closure |
| Full original inventories match after every npm ci | Source/Git/sentinel changes are hidden behind a dependency-output exception |

The complete fixed expected installed set comes from independently authored fixture expectations, not from capture's returned file list. Captured package membership is compared to that same original expectation before npm; staged-subset-only pack validation cannot hide missing mandatory originals. A regular-file mode of 755 tests actual packing mode retention. Each resulting canonical key uses observed tool inputs, not synthetic hash values.

CI uploads `dependency-local-closure-evidence/qualification.json` and both actual generated locks. The evidence records the exact source commit, repository lock SHA, public npm tarball/integrity metadata, actual tool hashes/runtime/library versions, command statuses/timings, selected argv, generated-lock hashes, keys, output digests and installed values. Only successful completed assertions produce `passed`. TEST scan bounds are failure bounds, not production defaults or measured retention budgets.

This does **not** prove admission, source mutation exclusion, readonly materialization topology, private grants, managed installer completion, descendant drain, protected immutable source-binding history, source-link unlink safety, eviction or cold restore. The final owned OS local install/eviction lifecycle remains mandatory. Root/local lifecycle scripts (including prepare), nested workspace output, packed-declarer local edges, selector/config backfill and arbitrary source mounts remain outside this closed no-lifecycle semantic fixture. The full plan's needed root-prepare profile remains a separate required deliverable.
