# Codex native web transport receipts

`ProviderTaskTelemetry.nativeWeb` carries finite transport observations separately
from model text and structured output. Host owns qualification. Each observed
turn names the targeted thread and the exact `turn/start` ACK ID; each receipt
names the native item ID. An empty, non-degraded turn means no trusted native
completion was observed, not proof that no web request was attempted. Missing
telemetry means this result path supplied no native evidence.

`completion_only` proves a recognized app-server `item/completed` API event,
not successful page retrieval. `failed` rejects an item carrying an error;
`unknown` rejects malformed items or duplicate conflicts. Turn `unknown` and
turn/envelope `truncated` flags prevent interpreting degraded or partial evidence
as exhaustive. Requested URLs are labeled `requestedUrl`, never returned sources.
Opaque `results` prove only a returned JSON payload observation. Neither they nor
an `openPage` reference ID establish an official page.

The attached official rust-v0.161.0 schema defines `WebSearchItem` with `id`,
`query`, optional `action`, and defaulted `Option<Vec<JsonValue>>` `results`.
Both core WebSearch and Extension WebSearch retain those results in v2
`ThreadItem::WebSearch`. Optional top-level and nested action members may be
omitted; invalid present values remain unknown. Actions are `search`, `openPage`, `findInPage`, and `other`.
There is no typed nested CodeMode native-web ThreadItem or returned-source schema
in this transport. This implementation does not infer either from command output,
function output, model JSON, or opaque results. It exports no source titles, page-content lengths/digests, queries, patterns,
snippets, diagnostics or result bodies.
Only anonymous HTTP(S) request targets without userinfo, query or fragment survive.

`resultSummary` distinguishes `absent`, `null`, `array` and `invalid`. Arrays carry
an actual `count` from array length, `observedJsonBytes`, SHA-256, `digestScope`
and `truncated`. Bytes/digests cover UTF-8 JSON reserialization in observed
property order, not raw wire bytes and not a canonical key-sorted representation.
`complete_reserialized_json` covers the entire observed result array;
`prefix_reserialized_json` covers only the observed prefix. Its byte count is
never the total payload length. Prefixes can end inside an escape or UTF-8
codepoint. Opaque results never imply page retrieval or identified returned URLs.

The inbound decoder bounds each parsed frame (4 MiB default, maximum 64 MiB).
Capture additionally caps each result serialization and private whole-item
fingerprint at 64 KiB, total serialization/hash bytes at 1 MiB per turn, and
projection attempts at 256 per turn (including duplicates). Serialization streams
bounded fragments without retaining bodies and stops at depth 128. Action query
arrays are validated only up to 64 entries. Wrong identities and capacity overflow
are rejected before projection/hash work after ACK; pre-ACK safe projections
remain bounded. Budget/depth/cap loss is explicit through truncated/unknown flags.
Incomplete private fingerprints cannot establish identical duplicates; a repeat
revokes the record rather than comparing partial hashes as complete evidence.

Capture starts before sending `turn/start`; the synchronous response observer
binds its ACK before the next notification in the same decoded wire burst.
Early observations are buffered as safe projections and private conflict hashes,
then filtered by exact ACK identity. Existing model-output turn aliases confer
no native receipt authority. Terminal events fence late items before and after
ACK. An unmatched terminal makes the observation unknown. Capture is removed in
the turn's `finally` block. At most 64 early events and 64 unique item IDs survive
per turn; identical duplicates dedupe and conflicts permanently revoke the first
receipt. Goal aggregation caps both turns and total records at 64 and reports loss.
Known-secret redaction rejects completed output; failure export reports finite
truncation instead of leaking or silently presenting missing receipts as absence.

The necessary propagation extends beyond client/clean runner: goal and logical
thread aggregation, waiting and error paths, engine redaction, both driver result
paths, core telemetry, and both existing task/event codecs. The managed worker
mapping validates the provider-created telemetry before exposing `nativeWeb`.
Managed failures carry a typed ephemeral error property, separate from failure
strings. The actual Codex goal Host serializes validated observations into
`RuntimeResultEnvelope.details.nativeWeb` as finite JSON, alongside its existing
job/task/execution-generation binding. This is Host metadata, separate from
`workerReport`. Model summaries, structured output and failure detail strings
cannot fill this reserved key. Durable failure replay without the typed channel
remains absent rather than inventing observations. Existing absence remains
compatible. No new runtime trace registry, artifact system or qualification
mechanism is introduced. The new parser is a
private static feature helper, not a composition graph node. The consumer pin
remains the supplied 8fe924 input; no standard adoption or central prose changes
are included.

Tests exercise actual framed fake-peer client notifications, ACK ordering,
wrong identities and aliases, malformed/error items, conflicts, overflow, late
items, fresh turns, safe URL rejection, opaque completion semantics, clean and
logical engine/driver propagation, rejected first/later turn timeouts after
notifications, bounded opaque result summaries, redaction, task codecs, managed
projection and actual goal latest-result JSON export. Comments
identify each regression. The correction regressions exercise the exact d38 checkpoint gaps through behavior
assertions; runtime export uses the existing executor port and real result writer. Live Host qualification is a later,
deployed-candidate operation; no native web/model call is part of these tests.

Implementation verification for NEWTEST r3014 used exact starting HEAD
`d38b2ce6a856457b67b4710c02c12ae94e382c56` (tree
`c0d6058c430cb7e17e3d4f5a9135009125ada6d4`). Nine selected regressions failed
against the checkpoint's original production bytes: opaque summaries (including
an independent populated-results case), omitted optional fields, first/later
rejected-turn evidence and five actual Host latest-result exports. Candidate
production bytes were restored and verified after that comparison.

The corrected source passed the own workspace observability package build,
`tsc --noEmit -p tsconfig.json`, `npm run check:boundaries` (including architecture
and managed-launch guardrails), and 106 tests in seven focused Vitest files:
`native-web-receipt.test.ts`, `native-web-transport-export-regression.test.ts`,
`native-web-host-export.test.ts`, `file-backend-codex-managed-run-failure-usage.test.ts`,
`codex-app-server-goal-usage.test.ts`, `codex-goal-runtime-result-io.test.ts` and
`codex-goal-runner.test.ts`. Tests used the supplied Node 26.10.0 fixture; its
SHA-256 matched `ab9c8eecf9f82d6693cdc3accced17034065c8d96213b0aa76a7e803d20ae1da`.
These are implementation checks, not independent Host gates or native seventh
qualification. No live probe, activation or production installation occurred.
