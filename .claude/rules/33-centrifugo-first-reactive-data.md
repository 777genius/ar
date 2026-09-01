<!-- Keel-Rule: 33 | canonical: vioxen/multi .claude/rules/33-centrifugo-first-reactive-data.md | distributed: keel 0.2 -->
<!-- Enforcement: advisory -->

# One Transport: Centrifugo → Store → Reactive Props

**Owner ruling, 2026-08-26.** Applies to quanta-tech and everywhere else with a
Centrifugo-capable frontend.

> "Everything (data, events) should come via Centrifugo data channel and only
> then reflect onto the page from the store via reactive properties. Always use
> one bidi transport (Centrifugo), route it via store, reflect via reactive
> props. This way, whatever comes from the server side is supposed to be
> rendered in a respective place automatically, without a need to update and
> poll."

## The shape

```
server change → Centrifugo publish → client subscription → STORE → reactive prop → DOM
```

Three obligations, in order:

1. **One bidirectional transport.** Centrifugo. Not polling, not an ad hoc
   refetch timer, not "reload on navigate".
2. **Route through the store.** A subscription handler must write to a Pinia
   store, never straight into component-local state. The store is the single
   place the truth lands.
3. **Reflect via reactive props.** Components render store state. They do not
   fetch on a timer, and they do not need to know an update happened.

The consequence is the point: **anything that changes server-side while a page
is open renders itself.** No manual refresh, no polling, no "pull to see it".

## What this rule forbids

- `setInterval` / `useIntervalFn` used to discover server-side change
- "fetch on mount and hope" as the only path to fresh data
- a subscription whose handler mutates a component ref directly
- telling a user to reload to see something the server already knows

## Why (the incident, 2026-08-26)

The PO reported an empty Library. Nothing was lost: her item existed, the query
was correct, her requests succeeded. But `library.vue` fetched **only** in
`onMounted` and on filter change — no polling, and **no subscription anywhere in
the app** for library or asset channels. The one Centrifugo call on that page
was an `rpc` (pull). A generation completing while she watched was invisible.

The owner's reaction is the rule's justification: *"We fucking have Centrifugo
and a reactive webpage but can't refresh on change???"*

Compounding it, a PWA service worker was serving her a stale bundle. Between a
page that never refreshes and a cached bundle, she had two independent ways to
see an empty Library while holding a good one.

## Adding a channel is cheaper than it looks — check before assuming otherwise

In quanta-tech, per-user subscribe authorization
(`grpc-proxy.controller.ts`) requires only that `channelParts[1]` equal the
caller; third-and-later parts are documented there as *"sub-keys owned by the
namespace handler"*. So a **new suffix under an existing namespace needs no
infrastructure change**: `social:{quantaId}:library` authorizes exactly as
`social:{quantaId}:account` does.

A **new namespace** does not — it is rejected at subscribe until an automations
config change and redeploy land (the QT-259 precedent, recorded in
`useAccountEventsRealtime`). Reuse a namespace, add a suffix.

⚠️ **One handler per channel.** The Centrifugo client keeps a single handler per
channel name — mount exactly one consumer, or give the new consumer its own
suffix. `social:{qid}:account` is already owned by `TgAccountEventToasts`.

## Realtime is an ENHANCEMENT, never a correctness dependency

Non-negotiable, and it comes from the existing guardrail: backend state stays
the refreshable source of truth. Socket down ⇒ **silent degrade**, never a
broken page or a SILENT failed write (§9-Q15: a write that fails because the
transport is down must still surface to the operator — rule 34 — even while
the page degrades gracefully for the customer).

Concretely, on the publish side: use the failure-swallowing `publish`, **never**
`publishChecked`, for announcements — the row is already committed, and a
transport outage must not fail the request. Contain it at the call site rather
than trusting the callee, and **log the failure** (rule 34): swallowed for the
caller, never for the operator.

## Relation to other rules

- **Rule 34 (no silent backend failure)** — the publish side of this pipe must
  be observable when it breaks.
- **Rule 32 (modular by default)** — use the existing `$centrifugo.subscribe`
  and `CentrifugoPublisherService`; do not hand-roll a second transport.
