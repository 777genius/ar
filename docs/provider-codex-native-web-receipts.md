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
Opaque `results` and an `openPage` reference ID cannot establish an official page.

The inspected transport was generated using the public r2991 Codex binary's
`app-server generate-ts` (no model invocation). Its v2 `ThreadItem.webSearch`
intersects `WebSearchItem`: `id`, `query`, nullable v2 `action`, and nullable opaque
JSON `results`. Actions are `search`, `openPage`, `findInPage`, and `other`.
There is no typed nested CodeMode native-web ThreadItem or returned-source schema
in this transport. This implementation does not infer either from command output,
function output, model JSON, or opaque results. It exports no source titles,
content lengths/digests, queries, patterns, snippets, diagnostics or result bodies.
Only anonymous HTTP(S) request targets without userinfo, query or fragment survive.

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
paths, core telemetry, and both existing task/event codecs. The new parser is a
private static feature helper, not a composition graph node. The consumer pin
remains the supplied 8fe924 input; no standard adoption or central prose changes
are included.

Tests exercise actual framed fake-peer client notifications, ACK ordering,
wrong identities and aliases, malformed/error items, conflicts, overflow, late
items, fresh turns, safe URL rejection, opaque completion semantics, clean and
logical engine/driver propagation, redaction and task JSON roundtrips. Comments
identify each regression. The standalone transport/export regression file uses
only pre-existing APIs so the same tests can demonstrate failure on exact base
`84ebaac4174d60e50140fc1447b769fe6c8e4363`. Live Host qualification is a later,
deployed-candidate operation; no native web/model call is part of these tests.
