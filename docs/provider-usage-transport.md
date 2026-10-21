# Direct provider usage transport qualification

Source base: `5702c0f0` in canonical `777genius/ar`, package
`@vioxen/subscription-runtime@0.1.0-main.40`. This is **not** the older
`@777genius/subscription-runtime` package pinned by ReviewRouter at `83a7329f`.
Do not replace that pin merely because this source builds.

The optional trusted `usageRelay` engine option routes actual upstream requests
through a bounded loopback HTTP relay. Packaged Codex, pooled Codex app-server,
Claude CLI and Claude Agent SDK engines use their supported provider base URL
configuration. Codex preserves existing auth.json or MiMo env-key custody;
Claude preserves its existing OAuth environment. The caller selects the original
HTTPS provider endpoint. The child still sends authentication to that endpoint;
the relay does not return or persist credentials. The upstream target cannot be
changed through HTTP input and redirects are never followed.

The app-server option also pins one exact model and must belong to one authorized
invocation. Create a separate engine for each invocation; dispose it after child
closure. Hosted containment profiles remain unsupported by this loopback option,
because reaching the host loopback requires a separate existing confinement
contract. The source-owned hosted MiMo proxy has its own optional
`observeProviderCall` callback at the actual fetch seam instead.

Each actual HTTP dispatch receives a UUID and immutable occurrence time. The
observer receives dispatched revision 1 and one terminal revision, including
HTTP failures, stream errors and aborts. Delivery retries preserve those IDs;
a real child network retry creates another call. Observer failures cannot restart
inference. Response bodies are forwarded as received; only bounded protocol
frames are inspected for numeric usage and terminal state. Raw text, headers,
credentials, provider response IDs and errors are absent from observations.
OpenAI input/output counters are inclusive. Anthropic cache buckets are added to
its exclusive input_tokens once; subdivisions remain included in the total.
Missing/invalid usage and interrupted streams stay partial/unknown. No cost is
invented. Upstream-internal retries remain outside the observed transport and
must not be claimed as measured provider dispatches.

This runtime API reports safe facts; its authorized consumer owns durable signed
spooling, server-derived attribution, grant scope, ACK/recovery and completeness
status. ReviewRouter's public Action implements that consumer in its owning
source repository. The runtime callback is not itself an ingest credential or a
billing reconciliation source.

Release qualification must freeze the source commit, build/package its actual
exports, run the focused transport/engine contracts and packed-consumer checks,
and compare with ReviewRouter's older package surface. Any namespace/API migration
must be reviewed explicitly. Then use ReviewRouter's existing immutable Action
v2 handoff and checked release-manifest gates before registering a producer.
No rollout, tag movement, registry publication or approved-pin update is part of
this source patch. Real provider calls on a disposable test repository remain
required before claiming end-to-end provider coverage.
