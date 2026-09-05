# Codex goal long-session audit

Date: 2026-09-05. Scope: goal launch, continuation, MCP monitoring, log tails and
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
| Max-turn exhaustion discarded measured usage at the provider boundary | Long-session slice failures lost their token measurements before returning a provider result | Carry sanitized usage in a typed slice-exhaustion error through failed provider telemetry; durable failed-attempt accounting remains a separate gap below |
| Event pages and append newline checks loaded the entire JSONL file | Small reads allocated memory proportional to session history | Stream event pages from a fixed file-size snapshot and stop at the requested page size; inspect only the final byte for newline separation |
| Continuation packets inserted the complete diff stat | Large generated changes could add megabytes to the next prompt | Bound the rendered stat to 8000 characters / 100 lines with an omission marker; keep task/control instructions and structured snapshot intact |
| All MCP text JSON used indentation | Formatting overhead on every tool result | Compact serialization, preserving structured result compatibility |

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

The brief regression fixture lives in
`src/worker-codex/tests/codex-goal-mcp-brief-response.test.ts`; log and pagination
fixtures are adjacent. Reducing response bytes also reduces context supplied by
clients that include these results, but the exact token effect depends on the
tokenizer, client rendering and cached input behavior.

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
- `overview`, run-watch and control-inbox inventory can still grow with registry
  size. Use explicit job/run filters and available limits; do not read a whole
  registry as a periodic single-job monitor. No safety conflict scan was capped.
- Event output is paginated and the local file store streams a stable file-size
  snapshot, stopping when a requested page is full. Selective filters can still
  scan a long prefix because the log has no secondary index. Unbounded internal
  replay remains complete so read models are not silently cut off.
- Lower-level provider callers bypassing `runCodexGoal` still need a compact
  explicit objective for a long prompt. This patch changes the goal worker
  contract without silently changing every provider consumer.
- Failed max-turn usage now survives in the provider result. Managed recovery
  still converts that failed result to a `SubscriptionWorkerError` without usage,
  and safe-execution failed attempt records have no usage hook. Durable totals
  can therefore still undercount failed slices. Do not treat this patch as
  complete end-to-end token accounting; that needs a separate failed-result
  contract and recovery regression coverage.

## Verification and delivery state

- Fresh-main port regression batch: 16 files, 161 tests passed. It covers provider
  goal usage, runner objectives, bounded logs, compact MCP responses, event pages,
  observation, CLI and continuation behavior using only fake/temp fixtures.
- Event-store focused regression: 2 files, 14 tests passed, including filtered
  pagination, UTF-8, corrupt lines, numeric cursor compatibility and append
  newline handling. Numeric cursors still require scanning preceding lines;
  this change bounds allocations, not every poll's total disk I/O.
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
- Model split observations: the goal implementation lane produced its first
  patch in approximately four minutes. Its three new objective cases passed
  initially; the complete runner suite needed one unrelated macOS temporary-path
  alias assertion correction. Medium implementation and xhigh review were used;
  no controlled cost/speed comparison was performed.
- This report records source verification. Hosted activation is recorded
  separately in each immutable release's `release.json` and
  `activation-receipt.json`, keyed by exact commit and tree SHA. No live paid
  worker or real-project runtime was used for validation.
