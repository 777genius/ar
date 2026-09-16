# Codex goal long-session audit

Updated: 2026-09-06. Scope: goal launch, continuation, MCP monitoring, log tails and
event history. Verification uses fake executors, in-memory MCP and temporary test
artifacts only. No production worker or real project runtime was launched.

## Confirmed findings and changes

| Finding | Impact | Resolution |
| --- | --- | --- |
| Runner copied the full prompt into the persistent goal objective and first turn | Duplicate task text; prompts over the 4000-character objective limit could fail before the first turn | Generate a bounded objective referring to the full initial task; preserve explicit objectives and full task text |
| Default brief returned verbose duplicate status, heartbeat ages and log text | Repeated monitoring expanded orchestrator context even when no action changed | Compact MCP projection by default, optional full diagnostics and logs, stateless `revision` / `afterRevision` |
| Tail read the entire log and limited only line count | A single large JSONL line could cause large disk reads, allocations and tool responses | Read at most 64 KiB from the suffix; at most 16 KiB raw excerpt, with truncation marker; omit incomplete leading and oversized lines |
| Event calls without a limit returned all history; projection ignored the caller cursor | Replayed history grew with the session | Default 100-event pages, maximum 500, continuation cursor, separate projection `eventLimit` |
| Goal usage snapshots were added as if they were per-turn deltas | 100 then 250 cumulative tokens appeared as 350 when turn usage was unavailable | Keep the latest defined goal snapshot; retain detailed per-turn usage precedence |
| Max-turn exhaustion discarded measured usage | Failed slices undercounted durable usage | Carry sanitized provider usage through typed worker errors, wrapped causes and the failed attempt journal; retain it across resume |
| Event pages and append newline checks loaded the entire JSONL file | Small reads allocated memory proportional to session history | Generation-aware byte cursors seek directly to a bounded page; legacy numeric cursors migrate safely; inspect only the final byte for newline separation |
| Continuation packets inserted the complete diff stat | Large generated changes could add megabytes to the next prompt | Bound the rendered stat to 8000 characters / 100 lines with an omission marker; keep task/control instructions and structured snapshot intact |
| All MCP text JSON used indentation | Formatting overhead on every tool result | Compact serialization, preserving structured result compatibility |
| Corrupt warnings and oversized event records bypassed count limits | A 100-event request could return nearly a megabyte of diagnostics | Bound the complete MCP envelope, aggregate diagnostics and expose explicit record omissions with progressing cursors |
| Every status read loaded the full runtime-event log | Polling cost grew with the session | Read at most 256 KiB from a fixed suffix; return a safe warning when the latest record cannot be established |
| Append rebuilt every event ID on every call | Repeated O(history) reads during projection | Refresh an exact process cache from the new suffix under the event-log lock; append each run's transition events together |
| MCP server versions were stale constants or caller environment values | Clients could not identify the installed package | All three MCP surfaces use the packaged runtime version |
| Event-log directory locks expired during long operations | A competing writer could reclaim a live lock and corrupt append/compaction ordering | Renew the owned directory inode; protect live same-host owners and fence recovery/release with owner tokens |
| Repeated transitions reused event IDs, including clean/dirty and unsafe/watch cycles | Replay could retain an earlier workspace or safety state | Persist a monotonic projection revision; serialize observation and projection per run; recover pending events before publishing projection state |
| Control views rescanned every receipt for every signal | Inbox processing became quadratic in history size | Index receipts once per snapshot and reuse reconciled views for observation |
| Projection state and locks used only the run ID in a shared outbox | Equal IDs from different providers or registries could overwrite state or suppress events | Scope state, pending transactions, locks, replay and compaction by provider plus registry; migrate only source-proven legacy transactions |
| Lifecycle-only observations emitted no new event | Replay could retain stale or alive status after recovery or completion | Emit semantic lifecycle observations, including cleared stale flags, without emitting heartbeat-age noise |
| Interrupt monitoring discarded the signal's attempt/session constraints | A signal for an old attempt could interrupt a newer one | Intersect monitor and signal targets; require specified registry fields to be known and equal |
| Inbox polling reread every historical payload and accepted claim | Repeated parsing and disk reads grew with retained history | Use a bounded process-local cache validated by file identity, size and nanosecond modification/change times; preserve all claim tombstones and receipt history |
| Run-watch observed the whole registry concurrently and returned every snapshot | Large registries caused process bursts and growing tool responses | Bound observation concurrency and reuse process/workspace context; return pages of 25 runs by default, maximum 100, within a 64 KiB complete MCP envelope |
| Turn usage was derived only from `tokenUsage.total`, baselined on observed thread history | A thread whose counter already carried history billed that history to the first observed turn; `tokenUsage.last` was never read | Anchor the turn baseline to `total - last` from the notification itself; bill the growth of `total` across the turn, so every model response counts once and nothing before the turn counts at all |
| A malformed `tokenUsage.last` was parsed leniently and could reach billing | An untrusted counter became a billed number, or a turn was dropped from billing with no signal | Strict exact reader rejecting the whole snapshot; the turn is poisoned, reports no usage, is excluded from goal checkpoint backfill, and raises `codex_app_server_turn_usage_untrusted` |
| Context-occupancy reports were indistinguishable from a response's cost | `fill_to_context_window` (context exhausted) and `recompute_token_usage` (successful mid-turn compaction) both emit `last` with every itemised counter zero and `totalTokens` set to a window or whole-history estimate; billing it charges that estimate to one turn | Classify the zeroed-parts shape as `occupancy`: it bills nothing, never anchors a turn's baseline, and raises `codex_app_server_turn_usage_occupancy` |
| The cumulative counter is not monotone and can be replaced mid-turn | A baseline anchored before the replacement is no longer commensurable, so its delta over-bills | Per-turn movement check: backwards-only is a redelivery (silent), backwards-and-forwards is a rewrite — latched, the turn falls back to the provider's own per-response numbers, and `codex_app_server_turn_usage_counter_rewritten` is raised |

Log redaction is also applied to direct CLI tail, the tail use case and orphan
MCP observations. The 16 KiB text limit is enforced again after redaction; JSON
escaping can increase the serialized size. Excerpts retain only a contiguous
suffix of complete lines. Full artifacts remain on disk. A truncation marker
means the excerpt is incomplete and must not be used as complete evidence.

## Reproducible size evidence

These are serialized byte counts for synthetic fixtures, not provider token
counts, account charges or measured production savings.

| Fixture | Before | After |
| --- | ---: | ---: |
| Brief payload with the same compact JSON serialization | 2087 bytes | 1180 bytes (43.5% smaller) |
| Repeated unchanged brief compared with the full fixture | 2087 bytes | 179 bytes (91.4% smaller) |
| Log containing a giant line followed by recent normal lines | 3,145,791 bytes read | At most 65,536 bytes read; 81-byte excerpt |
| Filtered 237-event history | All events in one response | 100 / 100 / 37, then empty; no gaps or duplicates |
| 10,000 corrupt lines followed by one valid event | 969,303 bytes of inner result JSON in the original reproduction | Two progressing pages; largest complete MCP envelope 5484 bytes; valid event returned exactly once |
| 1000 fake jobs observed through run-watch | 1000 simultaneous observations | At most 4 simultaneous observations; all 1000 visited through bounded pages |
| 5000 signals plus 5000 receipts, instrumented receipt-ID reads | 25,000,000 reads | 10,000 reads with equivalent signal states, ordering and filters |
| 1000 delivered signals and accepted claims, eight warm empty polls | 8016 payload reads / 15,656,960 bytes | Zero payload reads / zero bytes, with complete receipt history retained |

The brief regression fixture lives in
`src/worker-codex/tests/codex-goal-mcp-brief-response.test.ts`; log and pagination
fixtures are adjacent. Reducing response bytes also reduces context supplied by
clients that include these results, but the exact token effect depends on the
tokenizer, client rendering and cached input behavior.

## App-server protocol hardening (.39)

Synthetic provider regressions identified additional long-session failure modes:

| Fixture | Before | After |
| --- | ---: | ---: |
| Unterminated stdout frame, 32 chunks of 512 KiB | 16,777,216 bytes retained; process alive | Reject above 4 MiB by default, clear buffer and stop process |
| 10,000 unsolicited turn deltas while idle | 10,000 retained turn states | Zero retained turn states |
| Late deltas for 50 completed turns | 50 retained turn states | Zero retained turn states |
| 3,000 unsupported-method warnings | 433,891 serialized bytes | 264 bytes, including an omission count |
| Registered synthetic secret in unsupported-method or fallback warnings | Secret exposed in result warnings | Secret absent from result warnings |

The incremental decoder limits each UTF-8 JSON-RPC frame before concatenation
and parsing; a batch may exceed the limit when its individual frames fit.
Explicit output limits reserve sixfold JSON escaping headroom plus 64 KiB,
with a 64 MiB frame ceiling. Invalid or larger output settings fail validation.
Turn and alias retention is capped at 128 entries, and idle/finished state is
cleared. Protocol failure closes the process without waiting on a stuck quota
handler and does not replay work whose turn-start acknowledgement was lost.

The shared warning collector deduplicates records, bounds serialized JSON to
64 KiB and 256 entries, and reports omissions. Completed, waiting, prewarm and
fallback results redact warning fields; a sanitizer failure after execution
retains usage and the replay-unsafe marker. These are memory and response-byte
bounds, not measured provider token savings or a session-wide token budget.

## Monitoring contract

1. Read a compact brief and retain its snapshot plus revision.
2. Pass that revision to the next brief request. An unchanged reply omits both
   `brief` and `status`; keep the previous snapshot. It is not a new authorization
   to start, stop or continue a worker.
3. Back off between unchanged polls. Request the pool overview when pool state is
   relevant, and a decision before acting. Read logs for a diagnostic reason.
4. Use `detail: "full"` to retrieve the previous diagnostic shape; full replies
   are never suppressed. Explicit `tailLines` or `includeLogTail: true` requests
   a bounded tail in compact mode.
5. Paginate event history with the same filters and `nextCursor`. A full page
   sets conservative `hasMore: true`; the next page may be empty. Projection's
   `limit` selects runs and `eventLimit` bounds event output.
6. Run-watch pages expose `nextCursor` while `truncated` is true. Keep the same
   filters and registry membership while paging; a changed selection explicitly
   invalidates the cursor. Summaries describe returned snapshots on that page.
   Oversized snapshots have explicit omission records and must not be treated as
   complete evidence. Internal event projection retains complete run selection.

Revisions bind to job, resolved registry, output options and semantic state.
Heartbeat timestamps, ages and log byte growth alone do not invalidate them.
Liveness, stale status, failures, safety facts, result/artifact identity and next
action do. This is a status revision, not a content hash of the workspace.

Both text and structured MCP output remain available. The MCP specification
[recommends a serialized text copy for backward compatibility](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content).
Their presence does not prove that a particular host bills both copies as model
input; that requires client-level measurement.

The cumulative goal-counter contract was verified through `gh api` against
[Codex source at SHA 89208f0](https://github.com/openai/codex/blob/89208f09f819c0ff00c2608a33422a5f6b885c76/codex-rs/state/src/runtime/goals.rs#L499-L545).
The telemetry corrections improve accounting accuracy; they do not themselves
reduce billed tokens.

## Existing strengths and remaining limits

- In-slice app-server goal turns reuse the same thread. Retry continuation
  packets replace the prompt and keep a stable original task; they do not nest
  every prior continuation recursively.
- Controller guidance previews already cap item count and body length.
  Controlled-agent profiles explicitly restrict enabled MCP tools. Observation
  batches reuse process and workspace snapshots within a batch.
- `afterRevision` reduces returned context, not poll count or server-side status
  collection. There is no new long-poll or background scheduler in this change.
- `overview` and control-inbox inventory can still grow with registry size.
  Run-watch bounds observation concurrency and output, but listing the selected
  registry still scales with membership. Use explicit job/run filters; do not read a whole
  registry as a periodic single-job monitor. No safety conflict scan was capped.
- Versioned cursors bind generation, byte position and line position. A legacy
  numeric cursor needs one compatibility scan; a replaced log explicitly resets
  an external cursor and may replay existing event IDs. Preserve-mode compaction
  validates delivery boundaries against the current generation before removal.
- The exact dedupe cache is process-local and disposable. Cold start, eviction,
  file replacement, compaction or invalidation requires a rebuild from durable
  history. It avoids repeated full scans in a warm MCP process without creating
  a second persistent source of truth. Compaction remains an explicit operation
  governed by delivery cursors; this patch does not silently delete history.
  Its exact ID set still uses memory proportional to retained history.
- Inbox caching retains at most 4096 file entries and 16 MiB of source payload
  bytes; parsed JavaScript objects have additional memory overhead. Polling still
  scans metadata and clones records in O(history). Cold starts, edits, replacements
  and capacity eviction require fresh reads; histories larger than cache capacity
  can lose most of the benefit. No claim tombstone or receipt is deleted.
- Legacy unscoped projection state is rebuilt only from an exact-source journal
  with a provable initial observation. A compacted or ambiguous baseline reports
  an explicit migration error instead of adopting another source's state.
- Internal event replay remains complete. MCP scan/response caps apply at the
  observation boundary; a caller requesting full internal history still incurs
  work proportional to that history.
- MCP parsing skips records larger than 3 MiB with explicit diagnostics and a
  progressing cursor. Their event identity cannot be recovered through that
  bounded page; use the durable artifact or internal replay. Generation checks
  detect replacement, not arbitrary external destructive edits to the same inode.
- Event-log leases support local filesystems and same-host processes. A foreign
  hostname fails closed; this is not a shared-filesystem distributed lock.
- Lower-level provider callers bypassing `runCodexGoal` still need a compact
  explicit objective for a long prompt. This patch changes the goal worker
  contract without silently changing every provider consumer.
- Failed usage now survives the managed recovery and safe-execution journal
  path. Unknown provider usage remains absent rather than becoming zero.
  This improves internal accounting; it does not independently certify provider
  billing or measure production token savings.

## Verification and delivery state

- Fresh-main port regression batch: 16 files, 161 tests passed. It covers provider
  goal usage, runner objectives, bounded logs, compact MCP responses, event pages,
  observation, CLI and continuation behavior using only fake/temp fixtures.
- Event-store focused regression: 2 files, 14 tests passed, including filtered
  pagination, UTF-8, corrupt lines, numeric cursor compatibility and append
  newline handling. This first checkpoint bounded allocations; the subsequent
  byte-cursor checkpoint also removes preceding-history scans on warm reads.
- Pinned project TypeScript checks passed. Global `tsc7` rejects the existing
  `baseUrl` configuration, so the project compiler was used without changing
  configuration or adding dependencies.
- The production build, dist entrypoint check, diff policy, architecture
  boundaries, architecture guardrails and their self-tests passed on fresh main.
- Independent review found three P2 defects in the first optimization patch:
  discontinuous log excerpts, post-redaction size growth and volatile CPU probe
  values in revisions. All three were corrected and regression-covered; final
  reviews reported no actionable findings.
- Fresh-main streaming review additionally caught bare carriage returns being
  treated as line delimiters, which could invalidate existing numeric cursors.
  LF-only parsing and a compatibility regression fixed this before release;
  the final independent review reported no blocking findings.
- Final event-history hardening regression: six files, 40 tests passed before
  integration. Independent review covered cursor progress, compaction delivery
  boundaries, append-cache durability, complete MCP envelope limits and lock
  ownership. All identified P1/P2 findings were corrected before delivery.
- Integrated event/core/relay regression: nine files, 60 tests passed. Compiled
  canaries additionally covered warning floods, oversized escaped UTF-8 payloads
  and a 5 MiB corrupt line. Each complete MCP envelope stayed below 64 KiB and
  pagination returned the trailing valid event exactly once.
- Full CI additionally caught a projection compatibility regression: compact
  metadata had dropped the stopped worker's liveness read model. Restoring that
  small read model preserves stop/restart consumers within the response budget.
- Model split observations: the goal implementation lane produced its first
  patch in approximately four minutes. Its three new objective cases passed
  initially; the complete runner suite needed one unrelated macOS temporary-path
  alias assertion correction. Medium implementation and xhigh review were used;
  no controlled cost/speed comparison was performed.
- The 2026-09-06 follow-up used `gpt-6-astra/medium` for implementation and
  `gpt-6-astra/xhigh` for targeted review. First production patch took roughly
  ten minutes. The first focused run passed 60/61 cases; the failure was an
  expected old-default assertion. Subsequent focused sets passed 96/96 and
  49/49. Review caught cursor progress, CLI cursor forwarding, oversized
  metadata and capacity-effort consistency defects; all were corrected before
  delivery. Independent event and monitor review found no remaining P1/P2.
- The state/control follow-up used two `gpt-6-astra/medium` implementation
  agents and independent `gpt-6-astra/xhigh` review. The control patch arrived in
  roughly five minutes; its initial 10/10 targeted cases passed, with 39/39 in the
  final suite. Event implementation took roughly 35 minutes; the initial 33/35
  run required two expected lifecycle-event assertion updates, with 49/49 in the
  final suite. Review caught unknown-session matching, provider-discovery lock
  ordering, duplicate legacy-WAL recovery and unscoped SDK compatibility before
  release. These observations are not a controlled model cost comparison.
- This report records source verification. Hosted verification is recorded in
  each immutable release's `release.json`; its `activation-receipt.json` link
  resolves to the external activation journal. Both bind exact commit and tree
  SHA, and activation also binds the complete installed manifest. No live paid
  worker or real-project runtime was used for validation.

## Hosted release selection

The installed CLI and MCP wrappers resolve the immutable release through
`/var/data/runtimes/subscription-runtime/current`. A newly connected MCP process
builds new-worker commands from its own installed CLI. After activation,
reconnect the local HTTP-to-SSH MCP proxy so future launches use the new release.
Already-running workers and controllers retain their original executable; an
explicit version pin also intentionally overrides the default where supported.

New Codex goal jobs default to model `gpt-6-astra` with reasoning effort `high`.
Explicit CLI, environment, launch configuration and stored job settings retain
their documented precedence. Existing jobs are not silently migrated. Model
availability remains an active-account provider catalog concern; the runtime
does not silently substitute another model when the requested model is unavailable.

Release activation uses an exact main commit and verified Git bundle, with
separate build/verification receipts and atomic current/previous symlinks.
The previous release remains available for rollback. Updating a release never
rebuilds the live current directory in place. Failed staging cleans its temporary
directory; retries validate an existing final artifact. Activation can recover
after a symlink switch without overwriting the previous release. Runtime files,
dependencies and provenance are read-only; mutable activation receipts live
outside that payload.
