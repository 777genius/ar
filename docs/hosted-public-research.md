# Hosted Internet policy (owner contract, 2026-10-03)

Hosted workers default to `codex-full-internet-v1`: native shell networking is
fully enabled with the finite domain proxy disabled, and OpenAI native web
search is live when native tools are enabled. Filesystem permissions still deny
root and credential paths, admit only the workspace and assigned temp roots,
and keep `.git` and `.codex` read-only. MiMo retains its separate provider policy
and disabled native web surface. Bounded MCP-only tool surfaces remain closed.

The anonymous `public_source_read` reader accepts any public HTTPS domain,
including GitHub, ordinary query strings and up to three redirects. Every hop
validates its URL, rejects credentials and credential query parameters, resolves
and checks every returned address, pins those addresses into the socket, and
verifies the destination TLS identity. It never forwards caller headers, cookies,
proxy credentials or ambient proxy settings. The same 15-second deadline,
cancellation, two concurrent requests, 512 KiB body and 4 MiB aggregate result
budgets span redirects and account slots.

Policy transition is explicit and small: the new profile has its own enum value
and cache identity. Existing `codex-provider-api`, TEST qualification and
`codex-public-research-v1` grants retain their original finite policies; they
never acquire Internet authority by reinterpretation. Ordinary jobs without an
explicit restricted grant use the hosted Internet default. New owned research
grants select the Internet profile; existing research grants continue selecting
their recorded profile. To replace a restricted grant, use the existing verified
revoke/cancel procedure and explicitly issue `grant-internet` (ordinary) or
`grant-owned-research` (owned research) before a new start. No automatic grant
rewrite, authority migration or additional filesystem roots are introduced.

Writer validation uses only this new TEST clone, synthetic files and real local
TLS/streaming fixtures with DNS/socket routing substituted. It does not establish
hosted E2E, real native discovery, deployed isolation or service admission.
Primary performs isolated hosted E2E after review. No provider/service launch,
deployment, real auth access or Git mutation is part of writer validation.

The continuation on `b88772a0de6dd5f03fbd7979587964740febe7d6` completes
the controller network type and capability checks, and admits the Internet
profile on both supported native `app-server` engines. Legacy packaged/plain
execution remains refused for hosted permission profiles. Restricted grants
retain their existing engine eligibility. Controller and bounded MCP profiles
still disable native tools and native web discovery.

Internet permission is separate from command admission: hosted command reviews
retain Git push/commit/history and service/privilege denials. Quoted public URLs
with ordinary query separators remain valid commands. These reviews are not a
general shell security boundary; native filesystem confinement and the existing
global scan guard remain required. Portable tests substitute only absent Host
scratch configuration to avoid reading or activating real Host mounts. They
exercise actual TLS bodies, an anonymous local curl transfer, materialized
permission configs and private grant files; provider protocol and Host kernel /
service facts remain synthetic. Primary must qualify installed native shell
Internet, live web discovery, filesystem isolation and cancellation separately.

The historical v1 implementation and qualification evidence follows. Its finite
nine-host/API-only statements apply only to persisted v1 grants and are superseded
for the hosted default by the owner contract above.

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

### Native Linux sandbox prerequisite

Install the distribution's `bubblewrap` and qualify its nested user namespace
before native Codex research admission. On Ubuntu 24.04 with AppArmor userns
restrictions, use the distribution's named `bwrap-userns-restrict` profile;
retain the global restriction. See the [official prerequisites](https://learn.chatgpt.com/docs/sandboxing).
Do not substitute disabling sandboxing or globally allowing user namespaces.

On the selected qualification Host, bubblewrap `0.9.0-1ubuntu0.3` and the named
profile from `apparmor-profiles` `4.0.1really4.0.1-0ubuntu0.24.04.8` were installed.
The full selected NEW TEST confinement chain completed nested `bwrap/true`
without account/model/auth, with readiness at65.931s and total66.727s.
This qualifies the OS prerequisite, not native source retrieval. Each deployment
still needs its actual native profile/source/cancellation receipt. Load or
replace only the owned named profile; avoid blanket profile reloads or restarts.

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
direct child of the bound runtime MainPID. Type=exec's first MainPID observation
can precede unshare's user/mount transition and is not readiness. Only the fixed
confined launcher receives `--research-ready-v1`; after unshare/setpriv/Tini and
the descriptor check it emits exactly
`subscription-runtime-research-provider-ready-v1\n` before reading bootstrap.
The helper consumes that first frame (including fragmented bytes), checks the
real settled PID/birth/boot/cgroup/InvocationID/fragment/namespaces twice, retains
the owner, rechecks all fences and then releases held stdin. Native provider/user
code has not started and cannot forge readiness through protocol/tool output.
While this fixed launcher is inert, the 25 ms fence checks and every readiness
chunk re-read current active/spec/binding bytes, the closing fence and exact
grant, validate root/shared-Host/auth-root custody and canonical job/workspace
identities plus their private pins, and corroborate runtime process/service
identity and provider cancellation. They do not traverse the artifact or hash
native executable material. Prompt selection and its pinned reader are unchanged.
The existing full guards for account/session access and provider reservation
retain full byte verification. The helper also performs full artifact/Node/Codex
verification immediately before systemd submission and once during bootstrap
handoff, with mutable authority rechecked after the walk. It revalidates the
selected home and prepared scratch bindings against the submitted closed plan.
The control monitor stays attached during that final material walk. An event-loop
yield after verification observes queued duplicate frames and EOF; then retained
provider ownership, current authority/cancellation and transport state are checked
before the synchronous switch to stdout/stdin forwarding. The explicit 300-second setup
budget matches the provider service TimeoutStartSec; the research-only outer
app-server startup is 330 seconds to cover pre-submission verification and handoff. Once the complete ready frame is observed, a separate
10-second handoff bound matches the fixed launcher's bootstrap deadline. Each
artifact walk and each executable byte validation have a finite 30-second budget,
including initial custody and fresh descriptor/path checks on cache hits. The
original byte/file limits remain; timeout is denial, including a retained finite
file/artifact deadline observation, never admission.
These private helper changes introduce no composition or provider SPI. Genuine
shared-Host/native-provider qualification remains a separate root-run gate.
Pre-submission and transport denials retain a root-private `provider-failure.json`
with only a closed phase identifier and reserved unit. This observation carries
no authority and never records raw errors, stderr, paths or credential contents.

The readiness/ownership deadline is 180 seconds; unexpected/oversized output,
stream errors, EOF, transport exit and cancellation fail closed. Polling detects
fences and timeout; a sleep never establishes readiness. The launcher bounds
bootstrap to ten seconds and the existing 4 MiB frame limit. The direct transport
also has the requested task timeout plus 30 seconds; uncertain service ownership
is retained for operator reconciliation. Ordinary/MiMo pass no readiness argument
and retain their existing protocol. No generic readiness RPC or public API is added.
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
restricted network, prewarm and state/home/tmp under the exact job root.
The mandatory project scope is derived from the validated request: the selected
workspace is its only project root and the account auth root is explicitly
excluded. The request accepts no scope or environment bag. Job state, account
homes, private authority and sibling projects are outside that scope; fixed
agent temp is admitted through the existing native temp permission mechanism.
This configuration passes the unchanged access-launch validator; its source
regression reproduces the old missing-project-scope rejection. Native filesystem
and source retrieval behavior remain separate Host qualification evidence. The owner
derives `SUBSCRIPTION_RUNTIME_JOB_ROOT=jobRoot` and
`SUBSCRIPTION_RUNTIME_TMPDIR=jobRoot/tmp`, with `TMPDIR`, `TMP`, and `TEMP` all
equal to `jobRoot/tmp/agent`, exactly as the existing CLI. The real runner's
`ensureCodexAgentTempRoot` creates the leaf using its existing creation/traverse
rules and thread policy includes workspace plus that leaf. Scratch remains bound
at logical `jobRoot/tmp`; this change does not modify the deployed scratch fix.
Both fixed service plans bind the same retained job pin at the same logical
path. That nonrecursive pin does not carry scratch submounts prepared inside the
runtime namespace. The fixed research helper receives only the selected generated
`CODEX_HOME` nominal path, corroborates its protected components and identity
under the captured job pin, and queries the existing Host scratch policy without
mutating it. The provider plan adds only validated physical source binds for
`jobRoot/tmp`, `CODEX_HOME/plugins/cache`, and
`CODEX_HOME/cache/remote_plugin_catalog`. Mount target/UUID/FSROOT and protected
source custody must match; source and mounted directory device/inode must still
agree. Absent policy adds no binds; an exact identity-pinned legacy leaf adds
none for that leaf. Configured unprepared, unknown or replaced paths fail closed.
There is no `/proc/parent/root` bridge or caller-supplied mount/property list.
Parent birth/boot/unit permission is rechecked before submission and after
readiness. Fixed readiness and settled owner recording still precede release of
bootstrap/auth. Actual systemd/unshare mount visibility, traversal and temp/cache
I/O remain Root's live qualification, not an offline source assertion. Root
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

Failed owned operator actions retain exit code 1 and the stderr marker
`hosted_research_operator_action_failed`, followed by one JSON object containing
only `operation`, `stage`, `diagnostic`, `cause` and `legacyCode`. Start failures
after active-slot publication observe the current `pin-preparation`,
`input-preparation`, `launch-plan`, `host-submission` or `start-readback` stage.
Earlier failures, other operations and opaque primitive errors have stage
`unknown`. Diagnostic/cause values use the existing finite launch vocabulary;
legacy numeric codes keep their existing numbering. Raw errors, messages,
stacks, paths, command arguments and stderr are never included. This records
the original failed attempt without replay or an execution repair. A submission
failure remains uncertain; reconcile its retained ownership before a new start.

```sh
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs revoke-owned-research TEST-research-r7
node /canonical/installed/runtime/host-integration/codex-research-egress.mjs cancel-owned-research TEST-research-r7
```

Revocation blocks later auth/session/spawn/fallback; cancellation authenticates
the retained private start even after revocation. It publishes closing and all
authenticated individual fences before inspecting any live creator/provider.
It then stops the corroborated creator service first and reconciles only its
reserved provider units. PID birth/InvocationID/fragment or namespace changes
refuse physical signaling while preserving logical revocation. A pending
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
and publishes its root-private fence before any uncertain or foreign service
inspection, even while the unit is not found. This revokes logical permission;
it grants no authority to signal a foreign live unit. An inactive unit with a
queued start can receive stop only when transient fragment custody, exact private
unpredictable reservation/description and fixed unit metadata corroborate it.
An owned deactivating unit with MainPID zero may lose its PID/cgroup/InvocationID;
unchanged retained description/fragment and any still-present identity fields
must corroborate it. Name alone never suffices. The helper checks cancellation
before submission, while awaiting readiness, and before releasing bootstrap.
A failed kill still attempts stop. Pending transport
facts keep ownership uncertain while the creator can have a submitting helper;
creator-first cancellation and retained unit/job checks reconcile raced accepted
starts. Revoking future submission/bootstrap permission does not undo an already
accepted service request. Uncertainty retains the active slot and all ownership;
other corroborated providers can still be reconciled. Repeated or late cancel
rechecks the retained terminal units/jobs instead of returning success from a
missing slot or stale acknowledgment.

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

1. Apply only the three r9 review corrections to integrated source
   `f98230176bd7bd50f95b4fa67bda9b19e5a8970c`; preserve deployed scratch fix #204
   and every existing research/ordinary/MiMo guard. Compare the changed-path inventory with the final diff,
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

### r9 independent-review corrections and offline evidence

The r9 writer changes only cancellation ordering/pending corroboration, the fixed
research agent-temp contract/worker tmp view, and confined-launcher readiness.
The existing static CMS classification below still applies; no new composition
owner, package export, deployment mechanism or scheduler is introduced.
The supplied integrated base is `f98230176bd7bd50f95b4fa67bda9b19e5a8970c`.
Git metadata is intentionally hidden; Root verifies the canonical base/diff.
Hash comparison with the initial source proves scratch implementation #204,
large-file hashing, public-source reader, ordinary/MiMo implementations and all
unowned source files were left unchanged. No manifests or lockfiles were edited.

The precise cancellation tests begin with an inactive loaded transient plus a
queued start, a deactivating/MainPID-zero service, and a previously retained owner
whose service becomes deactivating/MainPID-zero. Real private files must already
contain cancellation before the first substituted observer runs. Whole-job
uncertain/foreign description, fragment, InvocationID, drop-in or failed observer
cases must independently retain closing/cancel files outside the expected
rejection, retain active/owner/spec evidence, and perform no foreign signaling.
These cases fail if live validation precedes logical fences or zero MainPID
requires reading vanished proc ownership. Failed kill/stop, late/repeated cancel,
queued-after-stop and accepted-submission races retain their controls.

The temp tests run actual CLI config, ensure/create/traverse and thread-policy
helpers against isolated files. They fail on missing markers, missing `/agent`
or workspace-only writable roots. Fixed launch-plan assertions require both job
pins and an explicit tmp bind from the authenticated runtime parent view; no
Host mount is executed. The readiness tests use real streams and explicitly
substituted pre-transition/settled proc/systemd identities. They fail if the early
Type=exec identity is retained or input is released before fixed readiness and
owner publication; later namespace mutation still refuses physical signaling.
Actual launcher source is transpiled into disposable Node fixtures with real
pipes/descriptor checks. Ready/ordinary protocol, malformed/oversized input,
bootstrap timeout, EOF and pre-bootstrap SIGTERM are exercised without starting
any provider. Stream errors, unexpected native output, transport exit, timeout
and cancellation cannot release held bootstrap in the helper fixtures.

An isolated resolver ran eleven precise new regressions against preserved
pre-patch modules: all eleven failed. The final current-source cases pass.
This is regression evidence, not live isolation or Internet evidence.
The disposable r9 artifacts are under
`/srv/worker-state/jobs/subscription-runtime/research-network-v1/jobs/sr-research-network-writer-20261001-r9/tmp/agent/r9-artifacts`.
The offline broader suite substitutes only an absent Host scratch configuration
(`lstatSync` returns ENOENT for `/etc/subscription-runtime/scratch-temp.json`, with
Node builtin ESM exports synchronized). Scratch algorithm tests still use their
explicit real implementation/host fixtures. Git-mutating runner fixture cases
are excluded. The first default broader attempt encountered ambient Host scratch
policy interference and was interrupted; it is not a passing integrated gate.
Root runs those excluded cases and the actual scratch-enabled integrated gates.
Final r9 verification passed 27 focused suites: 614 tests, zero failures, and
only five explicitly excluded git-mutating runner cases. The strengthened helper
suite also passed all 38 cases independently. Root/package TypeScript no-emit
checks, all six boundary/architecture checks and syntax checks of the three MJS
entrypoints plus both changed launcher/helper TS modules passed. The unchanged
large-file suite verified actual 286,754,152 and 334,715,184 byte fixtures against
independent streamed digests while enforcing 64 KiB hash buffers and existing
byte/time/custody limits. No dependency installs, real providers, Host services,
Host mounts, real credentials or deployments were used for these passing gates.

Root must additionally exercise the actual systemd/unshare transition with no
bootstrap/auth release before settled ownership, confirm runtime/worker tmp and
agent inode/mount visibility and real traversal/I/O, and repeat cancellation from
the precise queued/deactivating initial states. Retain actual MainPID/birth/boot,
InvocationID/fragment/cgroup and namespace witnesses plus closing/cancel/owner
files. Failed/uncertain/foreign states must retain the slot and refuse foreign
signals. Source plans, fake observers and Node fixtures cannot discharge these
live gates or the existing native fork/resume, discovery/source and capacity gates.

### r10 selected scratch visibility and portable CI fixtures

This correction targets Root's supplied integrated candidate
`1f7176e1f4dc47cf9bc3b13ee1b34cd0dcea9d76`. Git metadata is hidden; Root retains
exact-base verification. It supersedes the r9 parent-root temp bridge above and
preserves r9 cancellation, `/agent`, readiness, ownership and admission controls.
The read-only selected-bind query reuses scratch #204 policy, UUID, custody and
legacy identity validation. Existing preparation behavior remains covered by its
original tests. Ordinary/MiMo helper arguments and protocol are unchanged.

The five CI failures belong to the nearest TEST fixture: four physical auth paths
walked through writable backing-temp ancestry despite substituted root ownership;
the forged-marker positive lacked matching async lstat/descriptor owner
substitution. Exact backing-temp ancestors now map to the fixture's protected
TEST directory, and async stat ownership matches sync custody. Selected foreign
owners, symlinks and writable modes still independently reject. No production
custody rule or real Host config is changed for portability.

Raw verification, base snapshots, reproducer configurations and findings are
retained in workspace `tmp/root-export-evidence` (ignored, outside temp cleanup).
The CI backing-fact reproducer is explicitly synthetic; it cannot substitute for
running the affected suite under a genuine non-root UID. That gate and actual
configured native temp/cache source, isolation and cancellation qualification
remain Root-owned. Offline source and stream fixtures prove no Internet or live
confinement. CMS effects remain an extension of the existing static Host adapter
and launch composition; the GM reference below and shared standard are unchanged.

### r11 independent readiness handoff correction

This P1 correction targets only Root's exact candidate
`540035fcb801f3981f331e3cf2ee5cb8b12c3eba`. The writer verified the supplied
candidate-patch SHA-256 and all sixteen accessible patch postimages; Root owns
git-object authentication. Production changes are confined to
`research-provider-service.ts`, with real-stream regressions in its nearest test
and this documentation. The final540 physical-identity TEST correction,
production scratch/cancellation/temp behavior and ordinary/MiMo code are preserved.

Exact fixed-launcher readiness now resolves a promise while its control-stream
guard continues consuming stdout. The guard latches additional bytes, EOF,
close, errors, exit, timeout and cancellation through settled-owner publication.
A failure after readiness cannot be cleared by the already resolved promise.
Matching retains only an offset into the fixed frame, with the existing five
second deadline and cancellation polling. After publication, one event-loop
turn permits queued control data/termination to be observed. The helper then
corroborates the retained owner again, checks the latched guard and detaches it
at the synchronous transition into native forwarding and bootstrap release.
The readiness frame never enters the native protocol; later native output and
normal native EOF remain supported. This closes an EOF/duplicate fail-closed
contract defect; the evidence does not establish readiness forgery or ownership
bypass. No new shared boundary is introduced, so CMS classification below and
its reference remain unchanged.

In a fresh isolated workspace TEST root, both exact R3 inputs—separate
`write(frame); write(frame)` chunks and `end(frame)`—failed the unchanged
candidate helper's new effect assertions, each releasing 249 bootstrap bytes.
With this correction they reject with zero bootstrap bytes, no stdin/stdout
forwarding or auth-read effects, a durable cancellation fence and only owned
cleanup. A byte-fragmented positive control consumes readiness, publishes the
settled owner and forwards the exact later native JSON-RPC output. Additional
post-publication cases cover queued data/EOF, latched close, errors, exit,
timeout, cancellation and changed owner namespace/InvocationID; foreign owner
mutations refuse physical signaling.

Writer-observed verification passed 184 tests in eight focused suites, including
all 73 nearest helper cases and all 58 owner cases. Root/package no-emit
typechecks, isolated TEST builds and all six existing boundary/architecture
checks passed. Raw argv, results, logs, base snapshots, the separate source patch
and the full English report are retained in workspace
`tmp/root-export-evidence`. Proc/systemd/ownership observations and provider
transport are explicitly substituted; Node streams and TEST file bytes are real.
Root's supplied R3 reproductions and final540 Root/User iliya 58-case results
remain separately attributed. Actual systemd/unshare/native qualification,
genuine UID1000 qualification and final exact CI are Root-owned and were not run
here; they do not block this independent writer patch. No installs, commits,
pushes, live provider/service/database work or credential access occurred.

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

Shared-Host TEST qualification observed 44.3 seconds of fixed namespace setup
with 3,929 root mount records. This is one bounded observation, not a latency SLO
or proof of the underlying kernel cause. A later fully selected no-account TEST chain reached readiness in98.726s and
completed nested bwrap/true in99.310s with4,359 root mounts, exit0 and empty
stderr. Native provider setup had separately hit the systemd default90s before
any bootstrap. The later native source start `b902` spent 119.223955 seconds
between the systemd request and `Started`, then exited after 124.350811 seconds
with a `ready-and-owner` / `assertTransportPermission` denial before native
bootstrap. OS setup alone almost consumed the old 120-second cap. This
research-only path now declares 180 seconds for setup in the helper and service,
with 210 seconds for outer startup. These observations do not establish p99
latency or successful native source retrieval; actual qualification is required.
The fixed 10-second post-ready handoff,
byte-walk bounds, confinement and other profiles remain unchanged. This is
measured budget alignment, not qualification of a native source turn. Monitor setup duration and mount pressure;
never remove confinement to obtain a faster launch.

Root's next no-effect start failed while rechecking a previously terminal unit:
the two-second `systemctl show` cap returned `host-command-timeout`, before a new
active slot or provider submission. This research-only control read now has a
five-second cap; other commands retain fifteen seconds. A failed observation
still denies admission and never establishes inactivity. Binding publication
and captured authority checks reread active/spec, closing, grant, custody and
pinned directory facts after blocking process/service observations, including
the exact retained binding when present. They do not repeat artifact walks or
promise atomicity against a later operator change. Synthetic TEST regressions
revoke or change authority inside the mocked final service query. Native source,
confinement and cancellation qualification remains required before activation.
