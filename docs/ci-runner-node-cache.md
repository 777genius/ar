# ARC Node cache and proof epochs

The shared `arc-runner-set` and metadata `arc-ci-control` pools use the same
immutable Node 22 runner image. Their deployment configuration belongs to
`vioxen/automations`, under `gitops-platform/platform/arc-runners`.

Node 22.23.3 lives in `/opt/hostedtoolcache/node/22.23.3/x64`, outside the
ephemeral checkout. Both `RUNNER_TOOL_CACHE` and `AGENT_TOOLSDIRECTORY` point to
`/opt/hostedtoolcache`. Keep the existing pinned `actions/setup-node` action:
it selects the preinstalled version and still supports a future version change.

Default CI and publish workflows select Node 26.11.1. Until the runner image
carries `/opt/hostedtoolcache/node/26.11.1/x64`, `actions/setup-node` downloads
it (no cache hit), and the image change below is still outstanding.

After changing the runner image or producer profile, qualify both pools with
the automations `Qualify ARC Node cache` workflow. Its before/after assertions
require the same executable path, version and binary checksum; the setup-node
log must report a cache hit. Bind the job's runner name to its actual pod UID
and immutable image digest. A successful image build alone does not qualify
the deployed cache.

An image or producer-profile change starts a new CI proof epoch. Obtain fresh
successful receipts for all four unit shards and eight crash lanes on the new
profile. Main may reuse them only when the existing detector verifies the
exact tested merge tree and runner identity. Keep the full-execution fallback
on a mismatch; do not relabel old receipts or weaken the detector to reuse them.

Record queue time separately from execution time when comparing runs. A cache
hit removes toolchain download work but does not establish a scheduling gain.
