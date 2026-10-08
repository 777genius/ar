# Exact tool cache TEST qualification

Source-only fixture for Vite **8.0.16**, Vitest **4.1.8** and installed CommonJS picocolors **1.1.1**, all already present in the repository lock. No new dependency, production adapter, runtime grant or test hook is added. The initial fresh Ubuntu TEST run failed at the 256 MiB file observation bound before tool imports. The independently reviewed streaming correction requires a new exact-head CI run; the offending file identity was not recorded by that first run.

The new workflow runs only on a fresh Ubuntu 24.04 hosted runner. `npm ci --ignore-scripts` installs the exact existing repository-lock distributions in that new checkout. The harness creates and registers a new private `dependency-tool-cache-TEST-*` filesystem below `RUNNER_TEMP`, physically copies distribution bytes (dereferencing workspace/bin links, without hardlinks), and writes only approved synthetic source there. Actual tools never run against the repository checkout or a real user project. Source checkout is only the distribution/provenance input.

The workflow uses the existing Node 22 toolchain family and records the actual Node version, exact source SHA, lock digest and selected lock versions/resolved URLs/integrities in evidence. Qualification is specific to that actual runtime/distribution; the source does not claim all future Node 22 versions are accepted managed profiles. TypeScript is checked with the installed project compiler before Node stripping executes the handwritten `.ts` harness. No local execution is part of this lane.

## Closed profile

The fixture intentionally defines one new **config-free** profile. Vite receives `configFile:false`, `envDir:false`, explicit absolute private cacheDir, no source/HTML discovery and explicit installed CJS optimization. Vitest receives `config:false`, one approved Node test file, no coverage/browser/UI/custom plugins or setup, and explicit enabled `experimental.fsModuleCachePath` in another private absolute leaf. It uses the public `startVitest` API and exact-version public experimental State API to assert actual execution.

This is not silent support for arbitrary project configurations. A requested custom config is rejected before dynamic tool imports, rather than rewritten or evaluated. Legacy `test.cache.dir`, custom graphs/plugins and other output-generating profiles are not included. The two cache leaves and the per-fixture TMPDIR remain outside target node_modules and outside retention cleanup.

For this exact Vite version, public deprecated `resolveConfig` + `optimizeDeps` provides an isolated qualification seam that returns after optimizer commit. The fixture asserts persisted output and imports the generated bundle to exercise its CJS export. It does not inspect internal server optimizer properties.

## Assertions and plausible regressions

| Independent observable boundary | Regression making the assertion fail |
|---|---|
| Exact lock pins/integrities and installed versions before import | Wrong/upgraded distribution or metadata mismatch reaches execution |
| Unsupported installed version and requested executable config produce no import trace/cache/tmp effects | Qualification check moves after dependency import/config evaluation |
| Nonempty actual optimizer metadata, bundle and sourcemap under private `C/deps`; bundled CJS export behaves correctly | Empty/no-op optimization, misplaced cache, corrupt generated bundle |
| Exactly one actual Vitest module/test passes, no unhandled errors; results JSON contains that fixture with `failed:false` | Awaited start returns despite collection/test failure or swallowed result-cache write failure |
| Persistent transform metadata and hash file containing transformed actual TS payload and its cache metadata | fs cache remains disabled, writes the default tree, or only empty metadata is produced |
| Separate foreground invocations, with persisted cache outputs and working behavior after each | Result is only process-local or cold restart cannot use the same outside paths |
| Complete node_modules name/type/mode/content/membership digest before/after both children; all authored sentinel bytes/modes unchanged | Any tool write/removal inside target or a cache-name exception hides authored data |
| Physical copied identities and `nlink=1` for every regular file | Fixture accidentally shares writable dependency files with the checkout |

Authored sentinels cover `.vite`, `.vite-temp`, `.experimental`, `.experimental-vitest-cache` and `.cache`. No name/subtree is excluded from the digest. A full snapshot records directory/file/link type, modes, every file content hash and exact membership. Timestamps are checked for read stability but excluded from content identity. The 200000-entry/4 GiB-per-file/4 GiB-total/180 s observer bounds with a retained nofollow file descriptor and 64 KiB hashing buffer are TEST failure bounds, not measured production defaults or a production mutation proof.

The dependency inventory is a comparison for this isolated tool qualification, not an install attestation or proof that arbitrary cache-named data are disposable. Tool cache assertions include actual files because result writes can swallow errors. A nonempty cache directory or tool exit by itself is insufficient.

## Lifecycle and evidence limits

`run.ts` launches only bounded foreground children for its own new TEST fixture. Each positive child awaits the optimizer and public Vitest run/close; parent checks the full dependency snapshot **after child exit**. Deadline, thrown tool error or incomplete output becomes `failed_or_uncertain`, never pass. No background shell launch or blanket process kill is used. The TEST filesystem is kept for the remaining lifetime of the disposable CI VM; this slice adds no broad cleanup.

Public close and successful child exit do **not** establish production G1 admission, contained descendant/cgroup drain or future-reader exclusion. No simulated/fake runtime permit is minted. Registration explicitly means standalone tool qualification only. Cache behavior, root identity/version rejection and actual execution are the evidence produced here.

Production profile selection/grants, final permit before imports/config, all actual callers and aliases, cache/root drift under admission, contained release, two admitted hot entries with install count=1, default-fs-cache-disabled transient-write observation, native retention/rollback and arbitrary config qualification remain separate required full-plan gates. Existing dependencies/credentials/state/source are outside destructive scope. No real user workspace is qualified by adding TEST to its name.

CI retains `dependency-tool-cache-evidence/qualification.json` with passed or failed/uncertain status, actual distribution/runtime provenance, cache paths and observed counts/digests/timings. It deliberately marks runtime admission, native drain and hot install-count proof as false. There is no release/deployment/cleanup step in the workflow.
