# Hosted public research (v1): implementation and qualification

`codex-public-research-v1` selects native live web discovery and the
`public_source_read` dynamic tool for admitted OpenAI `app-server-goal` jobs.
The tool retrieves current official source bytes with anonymous HTTPS GET and
returns URL, UTC retrieval time, status, content type, encoding and body. Source
text is untrusted data. Offline packets and local TLS fixtures do not prove live
research. Report failed retrieval and unavailable discovery accurately.

Purpose, model names, prompts, metadata and environment markers are not
admission. Model availability comes from the active account's `model/list`.
The profile preserves the requested exact model, effort and service tier;
`gpt-6.1-sol`, `xhigh`, `default` remains DEFAULT with no FAST.
The closed operator parser also accepts literal `fast`, which enables native
`fast_mode`; `priority` keeps its own value. The six prepared critics remain
FAST and this writer remains DEFAULT. Runtime does not schedule those lanes.

## Source boundary and job lifetime

The anonymous broker's exact hosts are:

| Sources | Hosts |
| --- | --- |
| PostgreSQL | `postgresql.org`, `www.postgresql.org` |
| Rust documentation and packages | `docs.rs`, `crates.io`, `static.crates.io` |
| PGlite and Drizzle | `pglite.dev`, `orm.drizzle.team` |
| Tauri and Node | `v2.tauri.app`, `nodejs.org` |

GitHub is excluded. Both `api.github.com` and `raw.githubusercontent.com` are
refused before DNS or sockets. The owner's GitHub transport is `gh`; this patch
has no gh broker. Root may provide exact gh snapshots with repository, commit,
path, retrieval time and content hash, attributed to root's retrieval. Workers
must not describe those packets as their own live reads. Do not copy tokens,
fake gh authentication or grant shell GitHub access. Existing separate TEST
managed qualification policy is unchanged and is not research authority.

Shell egress remains exactly `api.openai.com`. Native `web_search = "live"`
uses Codex's provider service, without arbitrary shell destinations. Discovery
outside the broker list does not enlarge it. Official non-GitHub source reads
and actual native live discovery satisfy research. Ordinary/API/TEST web stays
disabled; MiMo keeps its separate endpoint and disabled web. Unsupported
backend, bounded workspace and controller-only tool profiles remain closed.

The broker has no caller-controlled headers, credentials, proxy, method or host
list. URLs require HTTPS, port 443, an exact hostname, and no credentials, query,
fragment or whitespace. It refuses redirects even between approved hosts.
A separate cancelable DNS resolver collects A and AAAA answers for each admitted
read, rejects mixed/private/special/metadata addresses and pins checked addresses
while retaining TLS hostname verification. IPv6 accepts only ordinary global
unicast. It never reads auth, HOME, environment tokens, git credentials or cookies.

Fixed bounds per job executor are two concurrent source requests, 512 KiB raw
body per call, 1 MiB serialized result per call, and 4 MiB aggregate serialized
results across the executor lifetime. A full result reservation is taken before
DNS, so calls can be refused conservatively near the aggregate limit. Concurrent
work has no waiting queue. Responses must be HTTP 200, with 16 KiB headers and
a 15 second total DNS/TLS/body deadline. Text returns UTF-8; binary returns base64.
Result expansion is checked as well as raw streaming bytes. Failed/aborted calls
release reservations; successful results consume the aggregate budget.

`buildCodexGoalExecutorOptions` creates one reader shared by every account
worker. Account fallback and provider slots cannot multiply these limits. The
app-server client owns source turn scopes within its existing execution leases:
thread registration, provider-confirmed active turn id, nonempty call id and
exact tool arguments are required before reading. Duplicate and stale calls
are refused; at most 32 call ids are retained per active turn. Turn completion,
abort, thread closure, lease release, client stop and terminal protocol/process
failure abort source work and clear its scope. Pre-aborted, closed, stale,
duplicate, over-capacity and exhausted-budget calls have zero DNS/socket effects.
Private DNS answers necessarily require DNS observation, but never TLS/HTTP.
At most 128 thread registrations are retained per client. Replacing or discarding
a prepared clean thread releases its source registration, so repeated context
changes cannot exhaust admission for later research turns.

## Supported shared Host launch owner

The supplied installed-source packet's nine source bodies matched their supplied
SHA-256 values. They show legacy protected project-start -> broker ->
`admitHostedControllerLaunch` -> tmux -> `run --no-tmux`. The supplied NEW TEST
observation on machine `d856d40da5ad4e23b4f67773e5942842`, release
`dd1f6f2b1649645dfad9512d45f75769c06e852c`, records PID 1686869, birth ticks
95931337, initial host root/full UID map, host user/mount/PID/network namespaces,
full effective/permitted/bounding capabilities, NoNewPrivs=0 and
`/user.slice/user-1000.slice/session-49612.scope`. There is no dedicated job
service, global authority directory or protected legacy process/artifact/grant
owner binding. Root-owned 0600 manifests and pre-start receipts do not supply
that missing binding. These are supplied observations, not local Host inspection
or authorization. Never stop that shared session scope.

The implementation adds a concrete **initial Host-root operator owner** for
research only, through installed `host-integration/codex-research-egress.mjs`.
It creates one individually owned runtime service and separately confined
provider services. It does not send an old tmux process through a relaxed
admission predicate. Ordinary project-start/refill, TEST grants and ordinary/
exclusive global activation keep their owners. This independent route refuses
any installed or partial authority at either
`/var/lib/subscription-runtime-host-policy` or
`/run/user/0/subscription-runtime-host-policy`, including at every subsequent
auth/session/provider gate. On such installations use the existing enrolled
ordinary owner and its activation fence; this route never bypasses that fence.

The new authority lives only at the fixed root-private 0700 directory
`/run/user/subscription-runtime-research-v1`. Existing managed namespaces already
hide its entire `/run/user` parent; no unrelated profile needs widening. Its 0600 closed per-job grant binds
canonical jobId/job root/workspace, their directory device/inode identities and
a fresh grant UUID. A closed operator request, selected by its exact SHA-256,
becomes a private start spec binding that tuple, request, grant digest, installed
artifact digest, Node/native Codex executable digests and unique service start.
The artifact hash traverses dist, host-integration, package metadata and the
actual dependency closure, including internal workspace symlink targets under
packages. External links, foreign owners, writable code, hardlinks and special
files are refused. Each walk is limited to 50,000 entries, 512 MiB and a four
second elapsed-time budget; unchanged file hashes are reused only after matching
device/inode/size/ctime/mtime/mode/owner/link-count metadata, with a 50,000-entry
cache. Native executable hashes have a separate 32-entry metadata-checked cache
and a 512 MiB/four-second per-executable bound. Both use a shared local hash
primitive with a 64 KiB buffer, no-follow/non-blocking opens, regular-file/root
custody/link/mode checks and before/after descriptor and path metadata, including
on cache hits. Private JSON/prompt read bounds are unchanged. Every walk still
checks custody and traverses the tree. This is a byte
witness with bounded cached checks, not trust in `.source-commit` or a mutable
installation marker. Exact candidate timing remains a Host qualification gate.

Before starting a service, the owner pins both selected directories with private
bind mounts under its private start directory. This supports the supplied
foreign/group-writable upper project ancestry without placing authority there
or changing shared ownership. Selected leaves must be root-owned and not group/
world-writable; every path component must be a directory without symlinks.
The grant's original directory identities must still match. Runtime and provider
service namespaces bind those pinned leaves back to the exact canonical paths.
Prompt bytes are bounded selected job data read with no-follow, root ownership,
single-link and inode checks, including after pinning; prompt ancestry is not
read through the private-authority reader. Auth roots retain strong root custody
and must be separate from workspace/job roots.

The runtime bootstrap authenticates its actual MainPID, PID birth, boot,
machine, cgroup, namespace identities, transient service InvocationID and
root-custodied fragment digest before publishing its binding or reading account
state. Marker-only and mapped namespace-root launches cannot publish or select
this binding. Captured guards recheck that binding, spec, private grant,
artifact, executables and directory identities before account reads, session
materialization, provider submission and account fallback. The default plain
process factory refuses actual research service membership even when its marker
is removed. The admitted factory also fixes the native Codex executable and
confines daemon cwd/CODEX_HOME to the captured workspace or job home.

Provider reservations persist before submission. The private helper must be a
direct child of the bound runtime MainPID. It retains the actual provider service
PID/birth/boot/cgroup/InvocationID/fragment before forwarding any bootstrap frame.
Providers use the existing unshare/setpriv/Tini confinement pattern: separate
user/PID/mount namespaces, dropped capabilities, NoNewPrivileges, strict system
mounts, pinned writable job/workspace, bounded private /tmp and /var/tmp, and
hidden authority, auth-root, secret, journal, systemd, DBus and container socket
paths. Named Codex filesystem/network permissions, the global-scan tool hook,
three-pipe descriptor boundary, account homes and API-only shell proxy remain.
A provider is bound to its runtime service through BindsTo/PartOf. Runtime and
provider services have KillMode=control-group, Restart=no, resource limits and a
24-hour maximum. Provider ownership records are bounded to 1,024 files per start,
reserving four file slots per provider for reservation/owner/submission/cancel.
No extra scheduler, global inventory or TEST managed/npm authorization is added.

### Exact initial Host-root operator instructions

Root builds and stages the integrated candidate with the thirteen main fixes
and deployed scratch/temp/cache fix. Use a new immutable canonical artifact,
root-owned with `chmod -R go-w` on that candidate only. All executable dependency
link targets must be within that candidate. Do not alter the old release or
select code by a stale `.source-commit`. The Node, native Codex, systemd-run,
mount, unshare, setpriv and Tini executable paths must be canonically root
custodied; use the actual absolute native Codex binary, not a PATH alias or
symlink wrapper. No staging, launches or credentials were accessed by this writer.

Create a new TEST job/workspace with protected selected leaves and a separate
existing root-custodied TEST auth root. Put the closed request in a root-private
operator directory, for example `/root/TEST-research-r7/request.json` (directory
0700, file 0600). Substitute canonical paths and root-owned TEST account names:

```json
{
  "schemaVersion": 1,
  "jobId": "TEST-research-r7",
  "taskId": "TEST-research-r7",
  "jobRootDir": "/canonical/jobs/TEST-research-r7",
  "workspacePath": "/canonical/jobs/TEST-research-r7/workspace",
  "promptPath": "/canonical/jobs/TEST-research-r7/prompt.md",
  "authRootDir": "/canonical/TEST-auth",
  "accounts": ["TEST-a", "TEST-b"],
  "codexBinaryPath": "/canonical/native/codex",
  "model": "gpt-6.1-sol",
  "reasoningEffort": "xhigh",
  "serviceTier": "default",
  "taskTimeoutMs": 28800000
}
```

The request has exactly these fields; no environment, payload, service options,
provider backend, grant path or arbitrary tool profile is accepted. This route
runs the existing app-server-goal executor with isolated workspace writes,
restricted network, prewarm and state/home/tmp under the exact job root. Root
must use the account's actual model/list for availability. Timeout bounds are
one second through 24 hours; DEFAULT is NO FAST.

```sh
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs grant-owned-research TEST-research-r7 /canonical/jobs/TEST-research-r7 /canonical/jobs/TEST-research-r7/workspace
sha256sum /root/TEST-research-r7/request.json
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs start-owned-research /root/TEST-research-r7/request.json EXACT_REQUEST_SHA256
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs status-owned-research TEST-research-r7
```

Start returns the exact jobId, startId, service name and spec digest after
submission. It does not claim provider/turn completion. Inspect that same
identity after any timeout or failed submission; a retained active slot prevents
replacement starts. Safe status authenticates retained service ownership and
reports startId, artifact/grant digests and the finite provider unit list. It
never reads provider environments, command lines or credential payloads.

```sh
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs revoke-owned-research TEST-research-r7
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs cancel-owned-research TEST-research-r7
```

Revocation blocks later auth/session/spawn/fallback; cancellation authenticates
the retained start even after revocation. It publishes a closing record, stops
that exact creator service first, then reconciles only its reserved provider
units. PID birth/InvocationID/fragment changes refuse cancellation. A pending
submission before binding is owned by its protected unpredictable unit and
exact description; provider input is still held. Terminal checks include queued
systemd jobs. The active slot is retired only after every owned unit is terminal;
transport uncertainty retains it. A durable terminal result is written before
retiring the slot, and status rechecks the same units/jobs after a lost cancel
reply. Missing active state alone never proves termination. No shared session or unknown process is killed.
Cancellation returns startId. After that terminal proof, root may unmount only
the two retained TEST pins (workspace first, then job) under
`/run/user/subscription-runtime-research-v1/SHA256_JOB_ID/starts/RETURNED_START_ID/pins/`;
retain the protected spec/binding/records for review. SHA256_JOB_ID is SHA-256 of
exact jobId bytes without a newline. A process restart uses the same protected
job state/home with a new owned start after terminal reconciliation; it never
reuses an old PID binding. Root must prove managed resume/inherited registration.

Individual provider cancellation authenticates the retained reservation/spec
and any observed service before publishing a root-private fence, even while the
unit is not found. The helper checks it before submission and before forwarding
its held bootstrap frame. A failed kill still attempts stop. Pending transport
facts keep ownership uncertain while the creator can have a submitting helper;
creator-first cancellation and retained unit/job checks reconcile raced accepted
starts. Revoking future submission/bootstrap permission does not undo an already
accepted service request. Uncertainty retains the active slot and all ownership.

The old `grant-research JOB ROOT WORKSPACE`/`revoke JOB` operations still use the
existing `/run/user/0` ordinary-origin grant mechanism. They cannot authorize this
independent route. Do not create that old authority directory for shared-route
qualification. `observe-launch` remains a read-only diagnostic, not admission.

Research account fallback uses the executor's existing scheduling and distinct
account homes with one captured reader/guard. The account-observability package's
independent quota probe cannot inherit this process factory, so this route
refuses that separate daemon and retains capacity recheck requirements. Use
ready eligible TEST accounts; expired/inconclusive capacity remains unavailable.
The positive offline fallback test runs the real executor from one quota failure
to a second account using substituted provider transport. Its paired revocation
case fails before a second provider or another auth read. Real accounts and
native tool registration remain Root's qualification gate.

## Captured configuration and inherited dynamic tools

Captured policy reaches account slots, generated homes, prewarm, cache reopen,
auth materialization and fresh thread creation. Research-specific cache keys
separate homes from API/TEST keys. Inference prewarm with a closed tool surface
has disabled web and no source tool. Real goals register `public_source_read`.

Research fork and validated managed resume overlay the captured model/backend,
workspace/permissions, approvals, instructions, service tier, web and tool
configuration. Research forks defer autonomous goal continuation until the
runtime starts its owned turn. Disabled native tools remain disabled. Ordinary
fork/resume behavior remains unchanged.

Writer-side Codex **0.159.2** generated experimental schemas locally in a TEST
artifact directory. `ThreadStartParams` admits dynamic tools; `ThreadForkParams`
and `ThreadResumeParams` have **no `dynamicTools` registration parameter**.
They admit captured configuration overlays. `ThreadReadResponse` does not expose
a dynamic-tool catalog. This patch does not invent fields or pretend those
schemas prove inheritance. The server must persist/inherit the registered tool;
root must prove an actual call/result exchange for fork and restart resume.
Substitute provider fixtures establish adapter behavior only. Actual final tool
surfaces and inherited registration remain a release gate.

## Exact disposable TEST qualification owned by root

1. Integrate the complete final candidate against base
   `00051adaf52b7cf243ec029140dd2808295c1110`; preserve the Host fix and thirteen
   later main fixes. Compare the full changed-path inventory with the final diff,
   including the source reader, port, tool, thread-start helper, tests, operator
   entrypoint and this document. Build the exact integrated artifact. Never use
   old installation receipts or deployment-doc assertions as a source witness.
2. Stage and qualify the concrete initial-root `start-owned-research` owner
   above before issuing production research launches. Do not activate a global/exclusive
   inventory or restart unrelated creators to qualify research. If using Host Jobs
   for a new TEST outer job, use `node scripts/ops/host-job-cli.mjs HOST MACHINE_ID
   SOCKET_DIR` with its structured JSON request; retain its outer-job-only limit.
3. Provision only **new synthetic TEST projects, workspaces, grants and jobs**.
   Bind their canonical tuple and exact artifact/grant digest through the genuine
   launch owner. Use account `model/list` for `gpt-6.1-sol` availability; retain
   `xhigh`, DEFAULT and NO FAST. Confirm the safe `runner_starting` profile/tuple
   evidence, and record the actual final tool catalog.
4. Generate the target's experimental schemas into the TEST artifact root:
   `codex app-server generate-json-schema --experimental --out TEST_SCHEMA_DIR`.
   Retain binary version/digest and schema hashes. Require a fresh actual
   `item/tool/call` request carrying threadId/turnId/callId and a matching successful
   `inputText` result. Schema acceptance by itself is insufficient.
5. Through the **actual worker tool**, retrieve a small current canonical URL on
   each of the **nine non-GitHub hosts**. Root supplies current nonredirecting
   paths: PostgreSQL docs, docs.rs crate docs, crates.io canonical package page,
   static.crates.io small crate archive, PGlite docs, Drizzle docs, Tauri docs and
   Node API docs. Record URL, UTC time, HTTP 200, source/body SHA-256 and a current
   content witness. A host without a usable current canonical URL is an explicitly
   failed gate; do not change hosts or follow redirects to make it pass.
6. Ask the actual worker for native live web discovery on an official non-GitHub
   source and retain its source/citation witness. Report account/tool unavailability
   honestly. Root may supply gh snapshots separately with exact attribution; the
   worker must refuse both GitHub HTTPS hosts and raw-shell GitHub attempts.
7. Exercise fresh, clean prewarm, profile-separated cache reopen, logical fork,
   process-restart managed resume and genuine account fallback in new TEST
   identities. Record distinct account homes and actual source tool round trips
   for every reopened/forked/resumed surface, alongside disabled-surface negatives.
   Do not manufacture auth tokens or treat fake emitted calls as registration proof.
8. In further new TEST identities, prove forged launch/tuple/artifact/grant and
   mutation before fallback fail before provider/source work; stale/closed/duplicate
   calls have no network effects; a cross-slot burst exceeds neither two outstanding
   reads nor the aggregate result limit; stopping a turn/client destroys DNS/TLS/body
   work. Exercise mixed A/AAAA, redirect and oversized streaming refusals. Separately
   prove ordinary forged markers yield API-only/no source tools/disabled web and
   MiMo retains its existing endpoint/closed tools. Probe only synthetic TEST auth,
   home and sibling-project data for isolation denials.
9. Qualify six lanes using orchestration's existing scheduling/account ownership,
   actual account capacity and Host resources. This runtime enforces safety and
   reports facts; it does not schedule critics. Revoke/cancel only verified TEST
   ownership. On a timeout inspect the same jobId/machineId before acting, and
   never create a replacement blindly or kill unrelated sessions.

## Writer offline verification

Pinned local executables were used directly; npm is unavailable. The final
focused suite includes the thirteen original research/provider/worker suites
plus the new launch owner, operator, inherited-env and trusted-launch-plan suites:

```sh
node_modules/.bin/vitest run src/worker-codex/tests/research-launch-owner.test.ts src/worker-codex/tests/codex-public-research.test.ts src/worker-codex/tests/hosted-ordinary-installation.test.ts src/worker-codex/tests/hosted-test-egress.test.ts src/worker-codex/tests/hosted-test-egress-admission.test.ts src/worker-codex/tests/hosted-test-egress-factory.test.ts src/worker-codex/tests/hosted-test-egress-cli.test.ts src/worker-codex/tests/hosted-test-egress-operator.test.ts src/worker-codex/tests/hosted-test-egress-inherited-env.test.ts src/provider-codex/tests/codex-test-egress.test.ts src/provider-codex/tests/codex-provider-app-server-policy.test.ts src/provider-codex/tests/codex-provider-app-server-goal.test.ts src/provider-codex/tests/codex-logical-thread-continuation.test.ts src/provider-codex/tests/codex-mimo-session-materializer.test.ts src/provider-codex/tests/codex-app-server-client-mimo-model-provider.test.ts src/worker-codex/tests/codex-goal-runner.test.ts src/worker-codex/tests/trusted-custody-systemd-launch.test.ts --maxWorkers=1
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/tsc --noEmit -p packages/agent-account-observability/tsconfig.json
node_modules/.bin/tsc -p packages/agent-account-observability/tsconfig.json --outDir "$TEST_ROOT/build-account/dist"
node_modules/.bin/tsc -p tsconfig.build.json --outDir "$TEST_ROOT/build-root/dist"
```

Run the existing `scripts/rewrite-dist-esm-imports.mjs` with cwd set to each
TEST build root. Run `check-boundaries.mjs`, `check-boundaries-self-test.mjs`,
`check-architecture-guardrails.mjs`, `check-architecture-guardrails-self-test.mjs`,
`check-managed-launch-boundary-self-test.mjs` and
`check-managed-launch-boundary.mjs` individually. The three operator/runtime/
provider MJS entrypoints also pass `node --check`.

The writer's newly created TMPDIR/TEST_ROOT is
`/srv/worker-state/jobs/subscription-runtime/research-network-v1/jobs/sr-research-network-writer-20261001-r7/tmp/agent/TEST-research-r7`.
Build output and all test fixtures are disposable and are not installation or
Host qualification artifacts. The account package was also built at its existing
ignored dist path to satisfy its declared local package exports for TypeScript
and Vitest; no package source or lock dependencies were changed.

The launch suite uses real private grant/spec/binding/file bytes and real
executor fallback with synthetic TEST account bytes. Proc, namespaces, ownership
UID observations, mount pinning, systemd, provider transport and retained native
registration are substituted. The HTTPS suite uses actual local TLS/streaming
socket bytes; DNS answers, socket routing and resolver cancellation observation
are substituted. Its ambient TLS-disable negative intentionally emits Node's
TLS warning while still rejecting the untrusted real peer. Workspace-symlink
executable mutation changes the artifact digest; compatible foreign project
ancestry, wrong principal/tuple/PID birth/service/artifact/grant, revocation before
fallback, pending cancellation, default/closed tools and reader saturation/
cancellation have positive controls and meaningful negatives. These checks
cannot prove deployed confinement, actual account capacity, live discovery,
current official source retrieval or provider-retained fork/resume registration.
No real project launch, credentials, online research or deployment ran here.

Supplied r7 results: all 17 focused suites / 495 tests passed. The final launch
owner rerun passed all 40 cases after the early-principal gate tightening.
Root/package typechecks, both TEST builds, both ESM rewrites, all six boundary/
architecture checks and three MJS syntax checks passed. No test proves deployed
Host or native retained-registration behavior; the numbered Root qualification
gates above still apply. The source packet, process observation and interim Root
review note were removed after retaining their conclusions here.

Git metadata is
unavailable in this sandbox because the linked worktree's gitdir target is absent;
no git add/commit/push or source reset was performed. Root performs the canonical
reviewed-output diff audit and integration.

r8 correction verification used the fresh disposable TEST root
`/srv/worker-state/jobs/subscription-runtime/research-network-v1/jobs/sr-research-network-writer-20261001-r8/tmp/agent/TEST-research-r8`.
The 19 focused launch/public-research/ordinary/MiMo/native-session suites passed
529 tests; the final strengthened hash suite passed all 11 cases. Real synthetic
files at 286,754,152 and 334,715,184 bytes matched independently streamed digests
with 64 KiB hash buffers. Parser-to-executor fallback tests proved literal FAST,
DEFAULT without FAST, and priority. Real retained-file/stream helper tests covered
pre-submission and post-binding fences, pending kill failure, raced accepted
submission, uncertain ownership and queued starts. Root/package typechecks, both
TEST builds/ESM rewrites, all six boundary/architecture checks and three MJS syntax
checks passed. Account exports were built only in this disposable workspace.
Proc/systemd/custody observations and provider transport remain substituted;
the initial-root artifact timing/custody/confinement/cancel, real native tool
inheritance, live discovery/source and capacity gates above remain Root-owned.

## Consumer Module Standard classification

This feature extends SR’s existing static provider/runtime composition. The new
operator dispatcher and runtime/provider service bootstrap entrypoints are
explicit Host launch/composition boundaries. They consume the closed captured
start and delegate to `runCodexGoal`/`buildCodexGoalExecutorOptions`, which remain
the single existing feature composition owner for accounts, readers, guards and
provider execution. The provider helper constructs only a fixed confinement
plan and transport; it introduces no plugin manager, second scheduler or dynamic
Assembly lifecycle. This is a new bounded launch adapter in the existing static
composition, not a claim that all composition roots are unchanged. SR has no
Assembly adoption pin. Root's reviewed classification reference is GM
`common-assembly.md`, commit `9c722ceff4ede307d06d7a4b63fdebe615f54c53`, document
SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
Those are supplied reference facts; upstream bytes were not fetched in this
provider-only sandbox. This is neither Assembly adoption nor migration and
imposes no GM dependency. Accepted ADR bytes are unchanged. Existing module
boundaries/import checks remain the authority; there is no universal manager.
