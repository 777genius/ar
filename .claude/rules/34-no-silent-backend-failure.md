<!-- Keel-Rule: 34 | canonical: vioxen/multi .claude/rules/34-no-silent-backend-failure.md | distributed: keel 0.2 -->
<!-- Enforcement: advisory (mechanised slices: rust-gates' conformance clauses join at their required-since steps) -->

# No Backend Failure Goes Unnoticed (PARAMOUNT)

**Owner ruling, 2026-08-26.**

> "Whatever fails in the backend needs to be communicated. Via OTEL to our
> collectors, via messaging to our frontend, via raising alarm using Discord
> endpoints. No fail should ever go unnoticed. And all should be fail-proof."

Rule 02 says handle every error. This rule adds the harder half: **an error that
is handled but invisible is still a failure of the system.** Someone — an
operator, a dashboard, or the customer — must learn about it.

## The three channels, and when each is owed

| channel | owed when | shape |
|---|---|---|
| **OTEL** | always | span status + error event; structured attributes, trace id |
| **Frontend message** | the customer is waiting on this operation | typed error code → localized copy (see §Customer-facing) |
| **Discord alarm** | the failure is systemic, not per-request | rate-limited; a wave must not become a flood |

"Always" means always. A failure that reaches none of the three is a silent
failure regardless of how carefully it was caught.

## Fail-proof means the reporting cannot break the thing it reports on

The reporting path must never be able to fail the request:

- Contain it **at the call site**, not by trusting a helper to swallow
- **Log the containment** — swallowed for the CALLER, never for the OPERATOR
- Never `await` a best-effort side channel in a way that propagates

Worked example, 2026-08-26. A Library realtime announce was added after the row
was committed. It `await`ed the publish, so a transport failure would have
turned a **successful save into a failed request**. The binding test caught it;
the fix contains the failure locally and logs it as
`library.saveFromGeneration.announce_failed` with the item id and owner. The
customer's write succeeds; the operator still sees the transport degrading.

## The failure modes this exists to prevent

Both are real and both happened here:

**Invisible-to-operator.** A daemon failed its startup health check **364
consecutive times** over six hours and nothing paged anyone. It was found only
because a customer waited 30 minutes for a video. There was no alert because
there was no probe and no alarm on readiness — the daemon dutifully logged
"still failing" into a stream nobody watched.

**Invisible-to-customer.** The same run was debited, stalled, and refunded 30
minutes later. Correct behaviour, silently executed. The customer learned
nothing until it was over.

## Customer-facing errors have their own constraints

When routing a failure to the frontend, product law binds:

- **R9** — provider names NEVER reach the customer. Not "fal.ai", not "Tavus",
  not a provider error code.
- **§4** — errors in the customer's language, never a provider code; an
  unknown-state run is a failure.

So the pipe is: internal typed error → mapped code → localized copy. Full
context internally, generic message + code externally (rule 02, CWE-209). Never
log credentials, tokens or PII (CWE-532).

## Prefer the existing taxonomy over a new string

A typed error already carries routing. In `governors-daemons`,
`GossipError::AdmissionClosed` maps through
`services::map_gossip_publication_error` to `ErrorCode::Unavailable` / HTTP 503
**and** is recognised by `media_publication_failure_disposition` as retryable. A
bespoke string error is invisible to both. See rule 32.

## Checklist for any new failure path

1. Does it emit an OTEL error event with a trace id?
2. If a customer is waiting, does a typed, localized, provider-free message
   reach them?
3. If it can happen in bulk, does it raise a rate-limited alarm?
4. Can the reporting itself fail the operation? (It must not.)
5. If it is swallowed for the caller, is it logged for the operator?

## Relation to other rules

- **Rule 02 (error handling)** — the umbrella; this adds observability as a
  requirement, not a nicety.
- **Rule 30 (fail-open vs fail-closed)** — a fail-closed refusal must log its
  cause, or an outage looks like a wave of legitimate denials.
- **Rule 13 (logging/observability)** — the mechanics; this rule is the
  obligation.
