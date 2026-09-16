<!-- Keel-Rule: 30 | canonical: vioxen/multi .claude/rules/30-fail-open-vs-fail-closed.md | distributed: keel 0.2 -->
<!-- Enforcement: advisory (mechanised slices: the fail-closed-path tests rule 31 requires) -->

# Fail-Open vs Fail-Closed: Decide by Who Controls the Failure

When a control depends on something that can be unavailable — Redis, a verifier,
a policy store, a remote check — you must choose what happens when that
dependency fails. **Do not pattern-match "gates fail closed" or "availability
wins".** Decide it per threat model, and write the reasoning down next to the
code.

## The question that settles it

> **Can an adversary cause, or wait for, the failure?**

- **Yes → fail CLOSED.** Otherwise the control is bypassable by inducing an
  outage, and "the dependency was down" becomes the attack.
- **No → fail OPEN is defensible**, and often correct, because the failure is
  independent of the attacker and refusing service costs real users something.

Then weigh what refusing actually costs. A fail-closed decision is cheap when
the dependency is already load-bearing for the whole request path, and expensive
when the control is peripheral to it.

## The two worked examples in this codebase

Same mechanism, opposite verdicts. Both correct.

| Control | Verdict | Why |
|---|---|---|
| **Step-up lockout** (`StepUpLockoutService.assertNotLockedOut`) | **CLOSED** | Guards money-out. An attacker can wait for a Redis blip, and a blip would read as "not locked out". Cost of closing is near zero — Redis is already the RPC transport, so an outage is not a state in which step-up actions serve anyway |
| **Brand-memory vision ingest** | **OPEN** | The in-memory throttler surviving a Redis outage is what makes it safe. The adversary does not control that failure, and refusing ingest costs users real work |

The same in-memory-per-IP property is the *safety* in one and the *weakness* in
the other. Reputation of the mechanism tells you nothing; the threat model does.

## Silent fail-open is the common form, and it hides in helpers

The dangerous version is rarely a decision anyone made. It is inherited from a
helper written for a different purpose:

- `RedisCacheService.exists` catches and returns `false`. Correct for a cache
  lookup. For a lockout gate it reads an outage as "not locked out" and admits
  the request.
- `RedisCacheService.set` catches and returns `void`. Correct for a cache write.
  For applying a lockout it reports success while writing nothing.

**A control built on a swallowing helper fails open silently, with no log line
saying so.** Before depending on a helper inside a security path, read its error
branch. If it returns a value on failure, ask what that value means to *your*
caller.

## How to fix it

**Add a strict variant beside the existing one; do not change the default.**
Callers that want cache semantics keep them; callers that need to distinguish
"absent" from "unavailable" opt in and route the throw to their own decision.

Precedent already in the tree: `acquireLock` / `acquireLockStrict`, and now
`exists` / `existsStrict`, `set` / `setStrict`. Same idiom, so nobody has to
learn a new one.

## Requirements

1. Every fail-open or fail-closed choice in a security path is **explicit in the
   code**, with the threat-model reason — not just the behaviour.
2. The **fail-closed path is tested**. It is the branch that never runs in
   development and therefore the one that rots.
3. A fail-closed refusal **logs the cause**. Refusals are indistinguishable from
   genuine denials in the response, so without the log a dependency outage looks
   like a wave of users tripping the control.
4. Never depend on a swallowing helper in a security path without reading its
   error branch first.

## Relation to other rules

- **Rule 02 (error-handling):** swallowing is forbidden generally; this rule is
  the security-path specialisation, where the swallowed value silently becomes a
  policy decision.
- **Rule 01 (security):** "when in doubt, choose more security" — this rule says
  what "more security" means when the doubt is about availability.
