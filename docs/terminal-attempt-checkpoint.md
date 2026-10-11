# Terminal attempt checkpoint slice

Current production worker state remains **NO-GO for live backup or restore**.
The runner writes its result before executor disposal and later emits
`runner_disposed`. A new durable per-job admission gate now wraps the runner
through disposal, the ordinary manifest-update path, result reconciliation,
and configured local journal publication. Runner result, events and journal
carry an explicit execution generation. The domain selector requires that
generation, the latest real rewritten journal attempt, matching result and
successful `runner_disposed` evidence. It also requires authoritative process
ownership completion. An abandoned writer or claim is never reclaimed by age.

The gate is a bounded foundation, not a live seal. Registry create and overwrite,
controller relocation and ledger manifest publication now take job admission.
Manifest updates refuse a job-root move because admission is held for the
persisted root; moving it would publish under the wrong fence.
Other controller mutation routes do not all share it. The synthetic capture rejects
project-controller manifests. SQLite ownership and provider descendant
completion are not inventoried by a production adapter. No production
entrypoint calls a checkpoint capture. The existing host-wide
process guard is not a job checkpoint lock and must not be reused. A claim
is explicitly rejected for non-`test-*` projects until these writer routes
and ownership proofs are complete.

`sealSyntheticTerminalAttemptCheckpoint` is deliberately restricted to
`test-*` project IDs. It rejects blocked/partial/unknown results and requires
a terminal journal record and a result timestamp within the matching
`runner_starting` to `runner_disposed` event window.
The disposable fixture also supplies a fake executor witness that records its
start, run completion and successful disposal for the bound generation and
ownership epoch; an uncompleted witness is refused before capture.
Its explicit allowlist contains the registry manifest, result, runtime events,
journal and up to 256 SQLite databases. SQLite uses Python's online backup API
and integrity check; WAL/SHM files are never copied. Source and stored file
hashes, sizes and relative paths are bound to one manifest with project,
workstream, job, attempt, runtime SHA, ownership epoch and retention deadline.
The manifest checksum and exclusive output directory make accidental overwrite
detectable. A disposable restore can call
`verifySyntheticTerminalAttemptCheckpoint`; it does not activate or replay an
attempt.

For a production adapter, first add a scoped claim shared by every writer of
these authoritative files. Admission and all controller, registry, journal and
database mutation paths must either honor that claim or stop before it is
granted. The selector must then prove the matching attempt is terminal with no
unknown owner, snapshot the whole allowlist under the claim, and release it
only after immutable publication. A mere stopped systemd unit, absent PID or
latest-result status is insufficient. Archive encryption, offsite custody and
restore proof for a new test project remain separate gates.

The new `sealTestTerminalAttemptCheckpoint` uses the real rewritten journal
reader, the same production result/event/journal and registry writer adapters,
and a fake executor. Capture requires a disposable `test-*` root under the test
temporary directory, with the job beneath the matching `test-*` project and
every supplied source and destination inside that root. Its allowlist is the
selected registry manifest, result,
events, current journal, only the result's hash-bound artifact references and
declared fixture SQLite databases. The local store captures committed WAL with
SQLite online backup, switches sealed databases to a self-contained DELETE
journal, checks integrity, exact fixture schema version/columns and
identity/sequence, then fsyncs every
payload, manifest, commit marker and the directory entries that publish them.
A failure before commit leaves an incomplete
directory without `COMMITTED`; a failure after commit preserves the sealed
bytes and fenced claim. Neither changes the attempt result. A matching
published checkpoint can be returned after lost acknowledgement only with the
independently retained SHA-256. Synthetic crash injection after reservation,
payloads, manifest and commit leaves the job fenced and preserves each durable
stage for inspection. A stale claim fails closed; no age-based recovery exists.

The disposable test restore archives only this sealed directory in a generated
password local restic repository, restores it under a new `test-*` project,
verifies every payload and sequence again, and writes a receipt with snapshot,
destination, checks, elapsed time, terminal watermark, RPO and rollback
pointer. Routing remains disabled. These checks prove a synthetic encrypted
restore, not live capture eligibility or provider resumability.
Focused races exercise the production runner, result, journal and registry
writer adapters under the same claim, while another synthetic job continues.

## Feature ownership and current standard classification

`worker-core/terminal-checkpoint` owns the stable terminal selection and
refusal vocabulary. `store-local-file/terminal-checkpoint` owns durable local
job admission. `worker-codex` owns runner and registry wiring and will own
trusted inventory, ownership evidence, and capture orchestration. The gate's
fixed helpers are private feature dependencies, not independent graph nodes.
The lock order is job admission before the registry mutex. The mutex must be
held only for a brief revision check and publication; no database copy or
process wait belongs under it.

Current canonical Get Modular Consumer Module Standard evidence is the supplied
complete document bytes for `agent-teams-ai/get-modular`,
`docs/architecture/common-assembly.md#consumer-module-standard`, commit
`d6127e2d3f499b91b220a222fc3672d29dff1ab2`, complete-document SHA-256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
The retained previous bytes at `6b31f20fe3e5fb8324812aa2ee907905751cde71` hash to
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f` and the
oldest retained bytes at `03a7df64bc5e9939f7b51694a80a7f3d61453f98` hash to
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
The current document adds the optional lifecycle candidate, module resource
scopes, dynamic instances, the authoring builder with contract descriptors,
identity rules and the conformance kit (ADR-0029 to ADR-0033); the exact delta
from `6b31` is recorded in `retained-nonqualified-attempt.md`. None establishes an accepted Assembly adoption scope for this
subscription-runtime consumer. This feature uses existing typed/static
composition and does not change ADR bytes or claim consumer adoption.
This reviewed reference is a classification identity, not an accepted consumer
adoption pin. The upstream document was fetched at the exact commit above.

The narrow reusable contract is already owned by `worker-core`: terminal
identity, selection and seal metadata. Filesystem and Codex adapters depend
inward on it. A cross-repository conformance package would cost roughly
100-150 LOC and one release dependency; no independent consumer has yet
proven the same receipt and writer semantics. The local typed contract keeps
that extraction possible without sharing Host inventory, process ownership
or retention policy. This classification adds no Assembly scope.

Raw-tree backup service and timer activation remain **NO-GO**. The checkpoint
does not imply provider-session resumability.
