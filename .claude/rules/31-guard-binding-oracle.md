<!-- Keel-Rule: 31 | canonical: vioxen/multi .claude/rules/31-guard-binding-oracle.md | distributed: keel 0.2 -->
<!-- Enforcement: advisory (mechanised slices: gates/selftests + the nightly gates-selftest matrix record each gate's last red) -->

# The Guard-Binding Oracle

**Standing acceptance criterion, ruled by M 2026-08-21.** Two definitions, one
trigger. Both are cheap; both were untested here until a real leak proved it.

## Trigger

**Work that adds or changes a guard** — a redaction list, an allowlist, a policy
table, a gate over N actions, a fail-closed branch, a validation boundary.

Deliberately **narrower** than "security-shaped work". Dependency bumps,
config/infra changes and trust-model documents are security-shaped with no guard
to bind; applying this there produces ritual, or arguments about exemptions.

Explicitly **not extended to infrastructure**. A NetworkPolicy has no producer to
derive from, and the failure it had here was not fixed by any test — that one
needed *"exercise every rule you claim to have verified"*, which belongs in the
deployment runbook.

## Definition 1 — the binding oracle

**A name or docblock asserting a security or behavioural property gets a test
named for that property, driven through the real producer shape.**

The load-bearing property is not the technique. It is:

> **The test must fail when the guard is removed.**

Provenance — driving real producer output — is a *technique* for reaching that,
and it is neither sufficient nor necessary. You can read real producer output and
still assert something that holds with the guard gone (not sufficient); the
step-up lockout's fail-closed test uses a stub and is a genuine binding proof
(not necessary). Stating the AC as the technique makes it satisfiable by a test
that proves nothing.

Three clauses:

1. **A guard change ships with a test that fails when the guard is removed, and
   the PR shows the mutation output — not the intention.**
2. **Where the guard enumerates a surface** — a gate over N actions, an
   allowlist, a policy table — **the test derives that surface from the
   producer, never from a hand-written list.** A copied list stops covering the
   surface the moment someone adds to it, silently.
3. **Where a suite mixes binding tests with explanatory ones, say which is
   which.**

Reference implementation: `config-logger.factory.redaction.spec.ts`
(`@vioxen/client`) — chains the real `CustomPinoLogger` output into the real
redact config, and was mutation-tested twice.

## Definition 2 — disclosure

**A test whose mock erases the property it appears to assert must say so.**

Reference: `transactions.topup-callback.spec.ts` (quanta-id-server), which states
outright that it proves *"CONTROL-FLOW rollback … NOT DB-level atomic rollback
(partial persist prevention)"*.

This is what clause 3 looks like in practice. The 2026-08-20 sweep found the
feared population was essentially empty — of 14 specs stubbing a pass-through
`runInTransaction`, **zero** claimed what the mock erased — so the fix is
disclosure where it is genuinely ambiguous, not a comment on all 14.

## Running a mutation test correctly

A mutation test has **three** parts, not two. Skipping the first is how a vacuous
green gets recorded as evidence — it has happened twice here, in two repos, in
one session:

1. **Assert the mutation APPLIED** — an occurrence count, or a `git diff`. A
   mutation string that matches nothing leaves the suite passing and proves
   nothing.
2. **Observe the FAILURE, with its message.**
3. **Restore, and observe green again.**

Two real instances, both caught only by step 1:
- The mutation was run on a branch that did not contain the change under test.
  The contract passed for lack of drift and the mutation matched zero
  occurrences — and had already begun to support the wrong conclusion that a CI
  failure was pre-existing.
- The mutation string appeared in two tests, so a `count == 1` assertion fired
  and nothing was mutated; the subsequent "ok" was meaningless.

Same family: a build reporting `Finished in <2s` twice looks like a cached no-op.
Confirm the toolchain is live by injecting a deliberate error and watching it
fail.

## What this rule is NOT for

**The inverse failure is not an instance of this pattern, and must not be filed
as one.** This rule addresses *a name asserting a property it does not have*. The
inverse — **a real, working control that the person planning the work did not
know about** — is a different failure with a different fix.

The worked example: a card asserted "no cumulative per-company cap, no
round-robin, no ageing" against `quanta-tech-server`. Two of the three were
already implemented and shipping (QT-496 and QT-497); only "no ageing" held. That
is cured by **reading the code before writing the card**, not by adding a test.

M's sharper version of the same lesson, from getting a factual question wrong
three times in two hours:

> The question was *"is this enforced"*, and the only artefact that answers it is
> the one that **names the enforcement**. Constants describe intent. A PR body
> describes a decision at a moment. Neither is the running contract.

## Relation to other rules

- **Rule 06 (testing)** — general discipline; this specialises it for guards.
- **Rule 19 (no self-driven simplifications)** — a test that cannot fail is the
  most common silent quality cut.
- **Rule 30 (fail-open vs fail-closed)** — clause 1 is what proves a fail-closed
  branch actually closes; that branch never runs in development and is therefore
  the one that rots.
- **Rule 21 (external-docs-verification)** — the "read the artefact that names
  the enforcement" lesson above is the same discipline applied to our own code.
