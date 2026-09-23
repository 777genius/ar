# Terminal attempt checkpoint slice

Current production worker state remains **NO-GO for live backup or restore**.
This slice does not change production runner or observer behavior. The runner
currently writes its result before executor disposal and later emits
`runner_disposed`. Controller operations, registry publication, journal writes
and SQLite databases do not share an attempt-scoped fence. The existing
host-wide process guard is not a job checkpoint lock and must not be reused.

`sealSyntheticTerminalAttemptCheckpoint` is deliberately restricted to
`test-*` project IDs. It rejects blocked/partial/unknown results and requires
a terminal journal record and a result timestamp within the matching
`runner_starting` to `runner_disposed` event window.
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

The reusable seam is the identity and hash-bound manifest shape plus fixture
checks (roughly 100-150 LOC in a shared conformance package). Ownership stays
in the product Host until another independent consumer proves the same writer
semantics. Project policy, file layout, Python backup adapter, retention and
controller orchestration stay here. Extracting a general runtime manager now
would couple consumers to this Host's lifecycle without evidence.
