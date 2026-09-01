<!-- Keel-Rule: 32 | canonical: vioxen/multi .claude/rules/32-modular-by-default.md | distributed: keel 0.2 -->
<!-- Enforcement: advisory (mechanised slices: cargo-deny wrappers and clippy disallowed-methods enforce the shared-facility boundary in Rust from keel 0.1a) -->

# Modular By Default (PARAMOUNT)

**Owner ruling, 2026-08-26: "the most paramount rule — everything must be
modular."** Never write ad hoc. Address things systematically.

The reference implementation is **`governors-daemons`**. Read how it is built
before adding anything anywhere:

> "Please make sure that you always try to find an existing set of functions
> realizing some functionality before attempting to add your own code."
> — `aux/governors-daemons/.claude/CLAUDE.md`

## Why modularity is a correctness rule, not a tidiness rule

A shared facility **enforces a set of behaviours everywhere it is used.** A
bespoke reimplementation enforces nothing, and silently opts its caller out of
every guarantee the shared one carries. That is the failure mode — not
duplication, but *divergence in behaviour that nobody notices*.

Worked example, 2026-08-26. A capability-admission gate was written for the
governor with a bespoke `CAPABILITY_UNAVAILABLE` string error. It compiled, it
was tested, it looked fine. But the shared taxonomy already had
`forge_gossip::GossipError::AdmissionClosed`, and using the bespoke error meant:

- `services::map_gossip_publication_error` did NOT map it to
  `ErrorCode::Unavailable` / HTTP 503 — the customer would have seen a generic
  internal error instead of a retryable one
- `media_publication_failure_disposition` did NOT recognise it as the retryable
  publication failure — so the retry logic was silently bypassed

Nothing was "duplicated". Two guarantees were simply lost. That is what ad hoc
costs, and it is invisible in review unless you know the shared facility exists.

## The rule

1. **Search before you write.** For the behaviour you need, find the existing
   crate / service / helper / error type. `grep` for the concept, not just the
   name. If a shared facility exists, use it — even if writing your own is
   faster today.
2. **Extend the shared facility rather than bypassing it.** If it *almost* fits,
   add the variant there (see rule 30's `acquireLock` / `acquireLockStrict`
   idiom: add a sibling, don't fork the behaviour).
3. **Errors, logging, telemetry, health, config and CLI all have shared homes.**
   In `governors-daemons` these are mandatory: `forge-gossip`
   (`WorkerDaemonRunner`, `WorkStealingHandler`, `WorkerConfig`), `forge-core`
   health (`build_readiness_checker`, `validate_startup`), `forge-core`
   telemetry (`init_from_env`, `shutdown`), `forge_core::cli::WorkerDaemonArgs`,
   `DaemonLauncher`. Daemon code holds **only daemon-specific logic**.
4. **A new bespoke type in a domain that already has a taxonomy is a review
   finding.** Say which shared type you considered and why it did not fit.
5. **Systematic beats local.** When you find a defect, ask whether the *class*
   exists elsewhere before fixing the instance. One-off fixes to a systemic
   problem produce a long tail of near-identical bugs.

## When a bespoke implementation IS right

- The shared facility genuinely cannot express the requirement, **and** extending
  it would break existing callers. Say so explicitly, in the code and the PR.
- A deliberate, documented boundary (e.g. a settlement-evidence path that must
  not be mutable by an operator, where reusing a live-mutable config would be
  wrong).

Both are arguments you must *make*, not defaults you may assume.

## Relation to other rules

- **Rule 19 (no self-driven simplifications)** — writing your own is often the
  silent quality cut; the shared path carries guarantees yours will not.
- **Rule 10 (code consistency)** — consistency of *style*; this rule is
  consistency of *behaviour*, which is stronger.
- **Rule 31 (guard-binding oracle)** — its "inverse failure" (a real, working
  control the author did not know about) is exactly what searching first
  prevents.
