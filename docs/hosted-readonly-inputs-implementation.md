# Hosted readonly inputs implementation checkpoint

This work is incomplete and is not a deployable admission implementation.
The accepted contract remains `root-input/DECISION.md`. No live mount or provider
acceptance is claimed. The original consumer, issuer, driver and installed
runtime have not been accessed or modified.

The current combined integration is described in the final section below. It
routes supported managed CLI creators through the fixed foreground outer service,
adds controller pre-binding admission and trusted provider composition, and keeps
stop/cancellation distinct from proven terminal custody. Earlier checkpoint
counts and audit findings are retained as history; they are not current release
acceptance. Actual systemd/provider qualification remains a separate ROOT action.

## Base and delta

The initial isolated TEST base was
`42ea16961987f8a626a5219b030a5029f28bcdfd`. ROOT subsequently fast-forwarded it
to accepted controller base `cff84124b99654b81966c3f94d3d86a058c89ab0`,
preserving all 53 owned files; `combined-base-20260909/verified.json` records the
transition. The current patch is against that controller base. The sandbox rejected creation of
`.git/index.lock` with `Read-only file system`; no subsequent commit attempt is
permitted. Deliver changes as a patch for separate root integration.

Compared `ed8d769..42ea169` before the initial implementation. All eight reviewed insertion-point files
listed in `root-input/plan-evidence.json` remain byte-identical at this base:
node process adapter, hosted resource policy, app-server types, goal runner,
runtime factory, egress contract, egress files and egress admission. The larger
app-server subtree changed substantially (30 files, +2126/-531), including
bounded admission, process stopping, slot lifecycle, protocol handling, replay
protection and usage accounting. Preserve those changes; an ed8 subtree copy
would discard them. This comparison used this clone's Git objects only.

## Admission code and initial verification

The provider adapter validates 1–64 disjoint canonical roots below W, derives
writable ancestor anchors internally and emits `PrivateMounts=yes`, mandatory
same-path `BindPaths=...:norbind` and `BindReadOnlyPaths=...:norbind`. The typed
factory copies its input, discards undeclared launch fields and reserves an
explicit systemd unit before spawning. The existing unit signaling, launch
frame, capabilities, resource controls and ordinary invocation remain intact.

`runCodexGoal` now invokes mandatory readonly admission immediately after egress
admission and before reading the prompt or constructing the executor. It passes
one guarded factory to every account. The runtime factory rejects managed
profiles using an unregistered factory or another workspace. Egress remains the
outermost wrapper. The private registration map is populated only by the real
admission function; there is no production process-factory injection parameter.
Ordinary profiles need no policy, but a policy, retained custody lease or durable
revocation marker prevents interpreting the same managed job as ordinary.

Before every guarded node spawn, synchronous checks re-read the policy, genuine
managed grant, independent review, stage receipt and custody lease, comparing
original bytes. They recheck the initial host namespace, pathname/device/inode
snapshot and mount layout. No policy path list is read from launch arguments,
environment markers or workspace JSON. Replaced input roots or ancestors, grant
removal/profile changes, receipt changes and revocation reject the next spawn.

The reader validates private root-owned ancestry, bounded no-follow/nonblocking
regular single-link files, strict UTF-8/JSON fields and matching identities.
Enrollment walks sealed trees to reject nonregular/multilink members and all
unreviewed symlinks. Exactly one independently reviewed Corepack shim may target
sealed `W/tools/published-cli`. It rejects mounts below W and requires ext4, XFS
or Btrfs as a structural filesystem prerequisite. It also rejects alternate
host mount exposures whose device and backing-root paths overlap W, including
currently readonly aliases, and ambiguous ancestor mount stacks. The check maps
the containing filesystem root (including subvolume roots) before comparing
exposures; unrelated backing roots and separate devices remain allowed. It reads
only host mountinfo and never modifies mounts. These checks cannot discover
aliases retained only in another mount namespace or already-open descriptors,
and do not prove
actual systemd composition or exclusive custody against other host writers.

A persistent custody lease is published before the policy, create-only, with
identical replay permitted. A per-job mutex serializes enrollment, spawn
validation/reservation and revocation. Interrupted publication or a crashed mutex
fails closed. Each reserved systemd unit is recorded durably before systemd-run;
records and custody are never released because a proxy exited or a unit is absent.

`hosted-readonly-inputs-cli.ts` implements only `admit REVIEWED_POLICY_JSON` and
`revoke JOB`. The successor additionally exposes explicit first `enroll REVIEWED_POLICY_JSON`
and `recover JOB` as described below. All require initial host-root UID mapping and matching user/mount/PID
namespaces. Admit requires existing independent approvals and a genuine managed
grant; it creates neither. Revoke first publishes a permanent tombstone and
requests SIGTERM/control-group stop for recorded services. It retains policy and
custody and explicitly reports that service reconciliation is required. It does
not claim queued services or descendants are terminal, or support de-enrollment.

The new native source suite exercises the actual admission, reader, review parser,
egress wrapper and node adapter with explicitly synthetic filesystem/process facts.
All 48 tests passed: missing/revoked/changed authority, each respawn check, two
account homes, factory substitution, reservation ordering, create-only replay/conflict/partial
publication behavior and ordinary behavior. Added cases reject writable and
readonly aliases, ancestor aliases, escaped mountpoints, source bind exposure,
ambiguous stacks, submounts and malformed mountinfo at both initial admission
and the next spawn. Separate-device and subvolume-root cases test backing-path
comparison without any actual mount or service operation. Fourteen additional
authority mutation cases reject initial admission and factory reuse: wrong
job/root/workspace/runtime/manifest/deployment/path projection, unknown approval
fields, missing custody references, unsealed shim targets, downgraded grants and
foreign or mismatched stage receipts.
The dependency-free suite substitutes the public provider root with its actual relevant source
exports; the separate Vitest integration uses the real supported module root; this is not packed-import verification,
root authority, service execution or live mount acceptance. The earlier native
adapter check passed the exact fourteen-root/ten-anchor projection, malformed path
matrix and default-invocation comparison. Seven binding mutations also rejected.

The native suite now also imports the actual CLI entrypoint against synthetic
filesystem and process adapters: successful enrollment publishes the lease first,
identical replay succeeds, absent independent approval rejects, interrupted policy
publication retains the lease and rejects retry, and a crashed mutex is retained.
Revocation tests assert cgroup stop requests, permanent tombstones, failed unit
lookup retaining custody, repeated stop requests and re-enrollment rejection.
Invalid revocation IDs reject before publication; non-root enrollment rejects.
No actual `systemctl` command executes: the test returns an explicit synthetic
absent-unit result, which the receipt correctly leaves unresolved.

Root installed the exact locked dependencies in this clone. Focused Vitest now
passes 180 tests in 11 files, including all hosted egress suites, readonly parsing,
mount serialization and the new `hosted-readonly-runner.test.ts`. The new suite
runs the real goal runner, safe executor, mandatory admission registration,
account runtime factories, outer egress wrapper and node adapter against synthetic
authority and a mocked child process. It proves successful quota rotation through
two account homes and distinct reserved units, then revocation before account two
with zero second provider spawn. It does not replace the production process factory.
The dependency-free operator/admission suite passes 48 tests.

The first typecheck found two real issues, now fixed: the policy was being passed
to a grant-specific identity helper, and Vitest array rows spread the malformed
root list instead of passing it as one argument. Identity comparison now uses the
policy's own three fields; test cases wrap lists in records. Typecheck, build,
boundary/self-tests, architecture/self-tests, dist-policy/self-tests and all 50
dist entrypoints pass. Final logs and built-file hashes accompany the external
patch checkpoint. No package versions or lockfile changed.

The release artifact gate rejects this dirty source tree before building, as
required by its exact committed-source identity contract. Root must integrate
with its own local identity and rerun that gate; no bypass or commit retry was
introduced. The packed-consumer check passes (runtime imports, CLI capability contract and
TypeScript consumer). Its existing checker was copied outside the workspace with
only its root/pack destination adjusted, using the already verified build
(`--ignore-scripts`) so all archives stay outside this workspace. Package dry-run
also passes. Global-scan-guard passes 97 tests; the workspace account-observability
package passes 26 tests. The complete repository Vitest suite and live release
qualification are not claimed by these focused results. The fixture-only publish-preflight loopback restriction was previously
observed and has not been confused with the now-resolved dependency gate.
The latest measured local dependency/build sizes are 432 MiB and 21 MiB, with
5.8 GiB free before packaging; no disk expansion is needed.

The runner exceeded the existing 1000-line guard after wiring. Its unchanged
report schema and schema prompt were extracted to `codex-goal-report-schema.ts`,
with the same runner re-exports. No unrelated orchestration was moved, and no
size guard was relaxed. The larger-than-planned implementation is attributable
to real independent authority parsing and durable custody/reservation handling,
not the mount serializer alone. The feature remains split into focused worker
adapters; it introduces no new core context or general policy framework.

## Independent root handoff records

These are required external authority inputs, not records manufactured by admit.
No real review, stage or custody assertion has been enrolled by this TEST work.
The first three paths below are under `/run/user/0/subscription-runtime-host-policy`, hidden
from hosted workers by existing `InaccessiblePaths`:

- `codex-readonly-reviewed/<SHA256(jobId)>.json`: closed record with
  `schemaVersion: 1`, `policy` (the exact closed decision-policy projection),
  `reviewReference`, `custodyReference`, and `corepackShim` (null, or the exact
  closed `{path,target}` record). The independent root reviewer supplies this
  only after issuer deployment review and actual exclusion of external writers,
  writable aliases and retained writable descriptors. References name real
  retained evidence; a policy's digest alone does not supply that approval.
- `codex-readonly-stages/<SHA256(runtimeDirectory)>.json`: closed record with
  `schemaVersion: 1`, `runtimeDirectory`, `runtimeSha`, `runtimeManifestSha256`.
  The stage curator supplies it only after verifying the immutable deployed
  stage and its manifest. Runtime derives its directory from its own module URL,
  never from job configuration or environment. A copied policy cannot create
  this independent qualification receipt.
- `codex-readonly/<SHA256(jobId)>.json`: the decision's unchanged closed policy,
  written by admit after exact review/stage/grant comparisons.
- `codex-readonly-custody`, `codex-readonly-services`, `codex-readonly-revoked`:
  private runtime-owned lease, reservation and permanent revocation records under
  `/var/lib/subscription-runtime-host-policy`. Enrollment precedes volatile policy
  publication; revocation precedes stop requests. File and ancestor directories
  are fsynced, including on identical replay. The fixed durable path is added to
  every hosted app-server service's inaccessible paths. Ancestry/alias protection
  still requires the approved exclusive supervisor integration.
  No configurable storage root or arbitrary systemd-property field is exposed.

The curator must keep stage verification valid, and the independent custody
holder must exclude external writers until every service descendant is terminal,
including recovery. Root remains trusted. Filesystem ownership, a reference string,
a lease file and readonly binds alone do not exclude a previously admitted sibling
writer or writable alias. This implementation's structural checks must not be
presented as proof that these external custody obligations have been fulfilled.

## Historical custody and recovery audit findings

Two concrete gaps prevent treating the current adapter as the complete admission
contract, independently of the passing local toolchain and missing live qualification:

1. Existing hosted services map host UID 0 into namespace UID 65532 and retain a
   writable host filesystem view outside their own private binds. The
   resource policy hides `/run/user`, durable host policy, systemd and D-Bus sockets; it does not hide
   another job's W. Therefore a previously admitted sibling with an accessible W
   can modify the same input inode through its own mount namespace. Root-owned
   file modes, the current host mountinfo alias scan, a per-job mutex and a
   `custodyReference` do not stop that writer. The runtime must be supplied with
   an independently reviewed custody mechanism that actually excludes those
   writers for the entire descendant lifetime. Scanning processes once would
   introduce a check/use race and is not a substitute. No sibling service or
   original workspace was accessed to establish this static finding.
2. The checkpoint kept all identity under `/run/user`; complete volatile loss
   downgraded a formerly managed job to ProviderApi. The correction moves lease,
   service reservations and revocation to fixed persistent supervisor storage.
   Egress admission now checks durable enrollment before selecting an ordinary
   fallback. Synthetic regressions erase all volatile authority and prove both
   revoked and nonrevoked managed identities reject before executor creation.
   This closes that specific volatile-loss reproduction, provided durable storage
   survives. It does not implement closed recovery when the durable store itself
   is absent/corrupt, nor authenticate a new boot or supervisor generation.

The approved correction mechanism is now available in the independent review
`/tmp/runtime-custody-gap-review-TEST/evidence/REVIEW.md` (archive SHA256
`18ea48828181ee13894eceec1eefd214ec7dc84c6dd4feab7ba4a064e932335e`).
There is no outstanding mechanism-choice request. The next implementation step
is the finite exclusive supervisor epoch at the common host launch boundary,
including permanent identity/hash binding, boot/generation checks, CLOSED
recovery, serialized reserve/start/revoke and exact terminal reconciliation.
The new durable records and inaccessible property are a partial correction;
they are not host exclusivity or runtime acceptance. The qualifier must still
exercise hostile siblings, descriptors and delayed systemd submissions.

Repository host launch entrypoints are
`host-integration/global-scan-guard/launch-hosted-subscription-runtime-job` and
`launch-hosted-codex-job` (also reached by `codex-bin/codex`). They now route through
`readonly-test-supervisor.mjs` and the fixed built host launch CLI. Guarding only
readonly admission or the app-server adapter cannot cover these ordinary/legacy
routes. The eventual gate must cover both outer launchers and the real app-server
spawn, while avoiding treating a nested provider invocation as a second unrelated
host reservation. Existing tmux starts, task runner resumes, command processes
and queued service submissions must be accounted for by the finite supervisor
inventory; no controller registry/project-control repair is part of this work.

## Supervisor kernel and persistent epoch adapter checkpoint

The approved correction introduces a meaningful hosted-custody safety boundary.
`worker-core/hosted-custody` now owns the provider-neutral epoch identity,
closed enums, strict parsing, retained reservations and application ordering.
Its host port requires actual finite inventory, material/descriptor verification,
creator fencing, queued-start draining and terminal descendant evidence. Domain
and application code perform no filesystem/process/systemd operations and do not
choose orchestration strategy. Ordinary and legacy starts are rejected inside
an exclusive epoch; the kernel is not an ordinary-host admission policy.

Recovery first publishes CLOSED. Missing/corrupt authority is never initialized
by resume; changed host/boot/supervisor sessions cannot start. Every start checks
current material, inventory and descriptors before publishing its reservation,
and submission occurs inside the same serialized call. Failed submission retains
that reservation. Revocation is sticky and published before stop requests.
Creator, queue and descendant operations must all succeed before terminal release;
reboot recovery retains the start history and obtains those facts again.

`worker-codex/hosted-readonly-epoch-store.ts` is the fixed filesystem adapter for
`/var/lib/subscription-runtime-host-policy/readonly-epoch.json`. It uses the existing
strict private reader, a host-wide directory mutex, create-only next-record
publication, atomic rename and fsync. It exposes no storage override,
implicit initialization or crash-lock removal. It rejects host/identity
replacement, generation reset/skips, lost reservations, terminal replay and
un-revocation. Only an otherwise identical CLOSED epoch can increment generation. A retained
conflicting `.next` record requires explicit root recovery. The finite record
limit is 64 KiB; reservations are also structurally bounded to 256.

These components are not yet the operational supervisor. In this checkpoint,
the production host adapter now supplies kernel/service/creator observations,
the outer runtime launcher checks the fixed host fence, and the managed provider
factory reserves and submits through the custody application. First enrollment and valid CLOSED recovery now have operator entrypoints;
crash-lock reconciliation and full launch-route coverage remain INCOMPLETE. The port's methods and a parsed READY record are
not authority or proof of exclusive custody. Do not deploy or describe this as
closing the sibling-writer defect. The next change must bind the port to the
existing host launch/service boundary, including outer runtime bootstrap versus
nested provider calls, with all ordinary/legacy routes participating. No external
mechanism choice or new approval is requested; the correction is already approved.

Thirty-eight application tests use an explicitly simulated host port. Eight store
tests use real disposable files, rename and fsync while mapping the fixed private
path and root metadata to synthetic authority. They exercise source ordering,
lost/corrupt state, pending starts, exact bindings, all three terminal requirements,
revocation, replay, failed publication and independent store instances. Neither
suite is operational acceptance or a replacement for the live systemd/provider
fixture. This approximately 320-line production increment is a consequence of
the independently reproduced lifetime/recovery defects, not a broad refactor.

## Host adapter continuation (attempt 5)

The current source is newer than the retained epoch-only audit. Both outer shell
entrypoints invoke the fixed built CLI. The outer runtime route compares exact
reviewed command/arguments/cwd and host/session, verifies material, finite service
inventory and descriptors under the epoch mutex, and closes admission on failed
checks. It refuses outstanding provider reservations. The nested legacy shim
requires the existing UID/GID namespace mapping, no-new-privileges and zero
capability sets; it does not accept an initial-host legacy launch. The managed
provider factory uses the same persistent store and application start transaction.

This continuation fixed an omitted outer inventory check and the ability to
retry outer admission after a failed check without first closing the epoch. The
kernel now handles systemd's `init.scope` separately from fragment-backed trusted
services: only PID 1 may inhabit it. Additional processes in that scope still
reject. Trusted service drop-ins reject because a fragment-only review cannot
bind their effects. These are bounded kernel observations, not a new inventory
approval mechanism.

New adapter tests exercise explicit synthetic OS records and systemctl results,
including unlisted services/processes, queued starts, fragment changes, drop-ins,
caller/host mismatch, exact completion receipts and populated descendants. Outer
composition tests prove the inventory check occurs under the same fence before
submission and failures persist CLOSED. These tests do not establish exclusive
custody on a real host. The existing shell suite now checks denial of arbitrary
outer runtime commands; it retains the scan guard positive in an already
contained namespace. It no longer expects an arbitrary host command to execute
without the mandatory host fence. No production bypass was added for tests.

Still missing after the enrollment continuation below: crash-lock reconciliation;
complete accounting of
all production launch routes (including non-goal factory users, retries and
outer runtime lifetime); a complete privileged systemd/provider qualification
harness. The existing executable Python probe remains only part of that harness.
Do not infer implementation completion from adapter wiring or passing unit tests.

## Explicit enrollment and generation recovery (continuation 6)

The root operator now has two additional narrow commands on the same module:
`enroll REVIEWED_POLICY_JSON` for explicit first enrollment, and `recover JOB`
for already enrolled authority. Neither command creates a job, issues a network
grant, accepts epoch JSON, accepts a generation number, supplies mounts or
restores credentials. The trusted supervisor's independently reviewed inventory
and kernel session must already exist; enrollment is invoked from that supervisor
cgroup with the initial host namespaces. No operational authority was generated
or enrolled during these source tests.

`enroll` authenticates the exact existing managed grant, independent review and
verified stage, checks material, then uses the common host lock to publish an
immutable `readonly-enrollment.json` and mutable `readonly-epoch.json`, in that
order, with fsync of records and ancestry. Both contain generation 1 in CLOSED
state and the complete bound identity. Only then can the existing lease and
volatile policy be published. `admit` remains a replay/restoration operation for
an existing matching epoch; it never bootstraps a missing epoch. Neither operation
makes the host READY. This finite implementation retains one permanent job
identity and has no de-enrollment or identity-replacement operation.

Every mutable epoch read now requires the immutable enrollment record and exact
host/identity equality. An existing epoch can replay explicit enrollment without
resetting generation or reservations. Revocation rejects replay. If either
record is missing/corrupt, normal admission and recovery fail closed. A retained
birth record, next publication, lease or tombstone prevents initial creation from
reconstructing unknown history. An interrupted first creation therefore remains
held; the birth record alone cannot establish whether a later revocation was
lost. No implicit recovery from that seed is implemented.

`recover` publishes CLOSED before fresh observations, increments generation while
otherwise preserving the entire CLOSED record, then checks all retained creator,
queue and descendant prerequisites plus inventory, exact material and descriptors.
The host material check now compares the persistent lease and current custody
snapshot, rather than merely computing a snapshot. Only successful recovery
publishes READY. Missing/revoked grants and missing/changed leases keep CLOSED.
No backup grant renewal or crash-lock deletion occurs. Generation exhaustion
also keeps CLOSED. A failed recovery consumes its issued generation; a later
valid recovery issues the next one.

The provider's real hosted spawn primitive now rejects calls without its private
single-use submission ticket. The ticket exists only during the synchronous
admitted-factory fence callback; a launch argument cannot supply it. Repeated or
deferred submissions reject before `spawn`, including a deferred callback that
never used its ticket before the fence returned. This closes the direct hosted
node-factory fallback through ordinary/default app-server callers. Those callers
must obtain the trusted fence; they cannot silently dispatch outside it on this
exclusive TEST host. Non-hosted default execution and invocation serialization
remain unchanged. This guard is not an independent root authority: production
uses the worker-owned admission callback and persistent custody application.

The production admitted factory supplies its captured generation to the custody
application. Under the same host lock, the application rejects a stale generation
before reserving or spawning, including same-boot/same-supervisor recovery. A
fresh admission after recovery may launch normally. Store tests use real small
disposable files and explicitly mapped authority; native CLI tests use synthetic
kernel/filesystem facts. They establish implementation behavior, not live custody.

Explicit recovery now handles a retained `readonly-epoch.next` when the common
mutex is available. Normal reads and admission reject any pending publication.
The recovery adapter validates the pending record against the committed epoch,
requires byte-identical replay, completes the fsynced publication and persists
CLOSED before application recovery observes live facts. Pending revocation stays
revoked; pending starts retain their creator/queue/descendant proof obligations.
Malformed, foreign, un-revoking or generation-skipping records remain untouched
and fail closed. The immutable birth record selects the recovery identity only;
it cannot reconstruct a missing mutable epoch. Tests cover real disposable-file
publication failures and synthetic operator recovery of revocations and starts.

Retained publication validation also binds session changes to the final recovery
transition: only a CLOSED epoch with exclusively terminal reservations can become
READY with a new boot/supervisor, without any simultaneous generation or
reservation change. Previously, a structurally valid pending record could change
the recorded boot while retaining a live reservation; recovery could then mistake
that creator for a previous-boot process. The store now preserves and rejects
that conflict before invoking recovery. Real-file tests cover both boot and
supervisor replacement, unresolved reopening, combined mutations, and the valid
terminal recovery transition. These are local publication checks, not evidence
that a real creator or descendant has terminated.

Epoch and per-job custody mutex names now include the kernel boot UUID read
only after initial-host-root validation. A crashed mutex remains closed for its
entire boot; no PID liveness guess or unlink is offered. A real reboot excludes
all old submitters and selects a fresh mutex, allowing the existing explicit
recovery protocol to reconcile retained valid publication and reservations.
Neither old lock evidence nor revocation is removed. This is a bounded
reboot-based recovery path, not automatic same-boot recovery. An unversioned
legacy lock, malformed boot identity, malformed/foreign pending publication or
missing epoch still rejects. ROOT must qualify actual reboot behavior later;
local tests simulate only the kernel boot fact and use real disposable lock
creation. Per-job locks use the same boot rule, so a retained inner mutex cannot
silently defeat the outer recovery protocol after reboot.

Outer host CLI lifecycle handling now closes the captured epoch generation on
child exit, asynchronous spawn error, or cancellation. SIGTERM/SIGINT/SIGHUP close
admission before forwarding the signal to the child. Every outstanding provider
reservation receives a stop request after CLOSED is durably published; stop
failures retain all reservations and report reconciliation required. No proxy
exit or signal delivery becomes terminal evidence. A callback from an older
recovered generation is ignored, preserving the new generation. Synchronous
submission exceptions also close admission. Handlers detach before reflecting a
child's terminating signal, avoiding recursive signal forwarding, and closure
failure cannot be overwritten by a successful child exit status.

Synthetic tests execute the actual CLI handlers and host composition, including
asynchronous errors, all three signals, failed close/stop, retained revocation
and late callbacks. No OS process is spawned or signaled by those tests. This closes the previously missing outer exit/cancellation feedback path. The
durable outer lifetime mechanism below adds separate-wrapper exclusion and
terminal-proof enforcement; actual host qualification remains required.

Unresolved source obligations remain: independently justified handling of
conflicting/lost partial publication (currently closed on ambiguity), full supported-route review and negative privileged fixture scenarios. The
durable outer service mechanism below replaces the earlier event-only lifetime gap. The permitted ROOT live qualification and
clean integrated release gates remain separate from these local source checks.

## Durable outer runtime lifetime

The earlier event-only outer wrapper left a concrete custody gap: two separate
wrappers could both pass admission, and a child exit could not establish whether
its descendants were terminal. The host now reserves one outer runtime in the
same durable epoch before process submission. That record carries its admission
generation; only a terminal record from an older generation can be replaced.
Missing legacy outer state is rejected, not defaulted to an empty enrollment.
The immutable birth record explicitly contains `outerRuntime: null`. This refines
the still-unreleased supervisor epoch schema; the closed readonly policy and
network-grant schemas are unchanged. There is no automatic legacy migration.

The existing host entrypoint starts a uniquely named trusted outer systemd service
in the existing hosted slice, with `Type=exec`, `KillMode=control-group`,
`SendSIGKILL=yes` and `Delegate=no`. No worker mount/property API is introduced.
A fixed private bootstrap reads bounded environment bytes through stdin; command,
argv and cwd come from the independently installed root inventory. Environment
values are never placed in systemd properties or receipts. Before starting the
runtime command, the bootstrap revalidates the genuine reserved outer cgroup,
current session/generation, readonly material and descriptor boundary.

Both initial managed admission and every provider spawn now require that actual
reserved outer-service membership. The finite host inventory permits only this
exact enrolled unit/cgroup; a matching name prefix or a sibling unit is not
permission. Direct initial-host goal calls outside that outer service reject.
The actual cgroup path includes systemd's dash-derived slice ancestry:
`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/UNIT`.
The nested provider's existing systemd/unshare/read-only mount launch remains the
same route; the outer service provides trusted-process lifetime ownership.

A normal `systemd-run --wait` completion is only the creator receipt. Queue drain
and actual cgroup/descendant checks are still mandatory before marking the outer
record terminal. An explicitly unloaded unit is accepted only with a precise
`LoadState=not-found` response, after creator/queue fencing and with an empty or
absent cgroup; manager errors do not become absence. Recovery performs these
checks for the outer service as well as each nested provider before READY.
Revocation and cancellation retain both sets of reservations and attempt their
stop operations. Failed/ambiguous starts remain held, including signaled proxies.
A permanent per-start birth prevents a reused identifier from reusing an old
completion receipt after the compact outer record moves to another generation.

The source tests cover separate-wrapper exclusion, durable outer transitions,
recovery fencing, actual membership and generation rejection, the fixed service
invocation, bootstrap frame/command separation, and combined stop failures.
Their OS/authority observations remain synthetic. No claim of actual unit,
provider, descendant or reboot acceptance follows from them. ROOT must review the
new trusted outer service boundary and qualify its systemd behavior before use.

## Historical pre-integration remaining work

- Complete recovery/terminal custody reconciliation and its tests. Synthetic
  operator/replay/partial-publication and absent-unit stop-request tests now pass;
  they do not establish actual pending-service or descendant termination.
- Close and test cross-process custody/alias enforcement. The retained lease and
  independent root custody reference do not themselves discover all existing
  sibling writers, writable alternate mounts or open descriptors.
- Validate the root review/stage handoff against actual independently qualified
  deployment receipts; no source/stage receipt has been fabricated here.
- Finish release qualification after root integration: the source-bound artifact
  gate requires a clean committed revision. Local focused tests/typecheck/build
  and boundary gates now pass; retain their exact built artifact manifest.
- Extend the disposable probe with the actual root systemd/provider launch,
  cancellation, missing-source, namespace, alias and service-isolation harness.
  Preserve the unchanged issuer/driver regressions under their existing owner.
- Obtain later authorized root live evidence. Nothing here authorizes deployment,
  grant creation, provider execution, publication or alteration of the original
  consumer/issuer/driver.

## Disposable fixture progress

`scripts/fixtures/hosted-readonly-inputs.py` is executable and uses only Python's
standard library. `prepare ABSOLUTE_FRESH_ROOT` creates a synthetic fourteen-root,
ten-anchor layout, a single exact Corepack shim symlink and a separate baseline
manifest. It refuses reuse. It does not enroll a policy, create a job or grant,
launch a service or read credentials. Inputs are tiny synthetic markers, not
copies of the accepted runtime or original consumer.

Later, ROOT must enroll and launch the fixture with the real successor runtime
and execute `probe ROOT` through the actual provider command sandbox. Preserve
stdout as JSON and stderr separately. At entry the probe inspects descriptor
metadata, without reading descriptor contents or unrelated targets. It rejects
any inherited descriptor for a protected member or scaffold directory, including
readonly and O_PATH handles that could retain the original mount view through
procfs reopening or openat. This checks only the command process, not host or
sibling-process descriptors. After confirmed service termination, run
`verify ROOT PROBE_JSON` outside the namespace. The probe has 195 assertions:
write/append/truncate/chmod-then-write/unlink/overwrite-rename for every sealed
root; rename/recreate and rename-exchange for all sealed roots and ancestors;
nine writable destinations; effective deepest readonly mounts and writable
ancestor mountpoints; inherited input/scaffold descriptors; and two fresh-user/mount-namespace attempts per readonly root. Every denial also checks baseline protected bytes, inode,
device, type, regular-file link count and mode. Writable directory link counts
are deliberately excluded because adding permitted subdirectories changes them. The host verifier rejects incomplete assertion
sets, checks the physical consumer identity and independently checks protected
files. Failed synthetic mutations are restored where possible to continue
collecting evidence; any successful forbidden operation remains a failure.

The fixture now also rejects duplicate descendant mountpoints, including stacks
whose entries both say readonly; mountinfo order does not establish which mount
is effective. A new writable sibling directory lifecycle assertion creates,
writes, renames and removes an OWN sibling while preserving the physical consumer
and protected identities. The host verifier requires this row as well. Five
offline Python regression tests cover ten mount-layout cases, successful writable
sibling lifecycle, the unprotected 167-row negative control (namespace subprocesses mocked out), and strict namespace evidence validation. No mount syscall,
service or provider runs in these tests. Run with `PYTHONDONTWRITEBYTECODE=1 python3
scripts/fixtures/hosted-readonly-inputs-test.py` and an authorized temporary directory.

During the earlier toolchain verification, an unprotected synthetic fixture was
prepared and probed in a disposable `/tmp` directory. That version produced 166 rows, rejected the missing protection,
preserved nine positive writable checks, and failed host verification as expected.
Reusing the same fixture was rejected. Additional disposable tests rejected
readonly, writable, O_PATH and directory handles and detected an intentionally
inherited writable fixture descriptor across exec. No systemd or provider process ran.

The probe additionally executes child-only `CLONE_NEWUSER | CLONE_NEWNS`
attempts for every root, followed by bind/remount and append attempts. These use
fixed syscalls and fixed fixture members; the provider process's own mount
namespace is never modified. Namespace EPERM/EACCES, or a denied write after
namespace entry, is required alongside the unchanged-byte/identity check.
Missing Python, child failure, timeout, unsupported namespace syscalls and
malformed/inconsistent child facts fail qualification. The host verifier requires
all 28 additional rows and independently validates their denial facts. Offline
tests replace namespace/syscall/subprocess effects; no live namespace or mount
attempt was executed by this worker.

`scripts/fixtures/hosted-readonly-launch.py ROOT REVIEWED_RUNTIME_DIRECTORY`
now supplies an executable ROOT-side launch driver for the positive disposable
case. It must only be run later on the authorized TEST host. ROOT first creates,
grants, reviews, enrolls and recovers a genuine synthetic job whose task executes
`hosted-readonly-inputs.py probe ROOT` through the real provider command sandbox
and saves JSON to `ROOT/workspace/probe.json`. The job root must be inside ROOT;
the fourteen-root projection must exactly match the prepared fixture. The fixture
manifest is private mode 0600. No existing probe report may be reused.

The driver verifies initial host-root identity/namespaces, reads only fixed
private epoch/inventory/policy metadata and invokes the existing production host
entrypoint with the exact independently installed inventory command. It supplies
no systemd fragments, mount override, enrollment, grant or fallback authority.
The production route still owns every admission check and the real
systemd/unshare/provider launch. Pipe stdio preserves production descriptor
requirements. Output is drained in bounded chunks; only hashes/counts are
retained, avoiding copies of potentially sensitive provider text. Cancellation
signals forward to the production wrapper's lifecycle handling.

Before submission, the driver creates and fsyncs a create-only pending witness.
After return it appends the exit status/output digests, host mount-view comparison,
protected identities/bytes and the independently checked probe result. Missing or
invalid probe output is a recorded failure; an interrupted run retains its pending
witness and cannot silently retry the fixture. It never declares live acceptance
or treats the outer process return as service/descendant terminal evidence.
Seven offline Python tests now cover probe and driver behavior; driver tests mock
root authority, process creation and signal effects. The driver was not run live.

This adds a bounded host-side test adapter to the existing fixture boundary; it
is not another runtime authority boundary or an Assembly adoption claim. Negative
startup/lifecycle cases, hostile sibling/alias cases, independent provider
provenance and actual terminal-custody qualification still need ROOT evidence and
further harness coverage.

This is an executable probe, not the complete required privileged harness. Actual
service/provider provenance, descriptors held by other processes, alternate mounts, hostile
sibling writers, actual execution of the namespace attempts, cancellation/partial startup,
missing mandatory sources, cross-service isolation, custody and the unchanged
issuer guard still need their own tests and live evidence. The script always
reports `liveAcceptance: false`; even passing probe rows cannot certify those
missing obligations or authorize deployment.

## Scoped Consumer Module Standard classification

Reference: `agent-teams-ai/get-modular` at
`03a7df64bc5e9939f7b51694a80a7f3d61453f98`, supplied
`root-input/consumer-standard.md`, anchor `#consumer-module-standard`, complete
document SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
The local copy is evidence, not an independent source of authority. No upstream
path or accepting ADR identity is inferred from the copy.

Searched tracked docs, source, scripts and package metadata for Get Modular,
Assembly, consumer-module/adoption references and the supplied pins. No existing
consumer adoption pin or accepted Assembly wiring scope was found. Existing
`*adoption*` project-control tests concern another feature. This checkpoint is
classification under `docs/runtime-ddd-feature-architecture.md`, not Assembly
adoption, a new FMS activation or repository-wide conformance.

| Boundary | Semantic owner and mechanism | Actual enforcement/evidence |
| --- | --- | --- |
| Closed policy, authority and filesystem reader | Worker Codex hosted access-control adapters; cohesive static helpers | Fixed-root parsing and independent review/stage/grant comparisons; real receipts remain unbound |
| Readonly mount plan and real process factory | Provider Codex app-server adapter; narrow typed factory at public provider root | Finite path validation and immutable closure; actual systemd proof pending |
| Goal runner to admitted factory | Worker Codex composition owner, existing process-factory port | Mandatory managed admission before executor; private factory/workspace registration and egress outer wrapper |
| Operator entrypoint and custody lifetime | Host-owned enrollment/custody adapters | Namespace gate, create-only lease/policy, serialized spawn reservations and retained revocation; full custody qualification pending |
| Hosted custody epoch application and host port | Worker Core safety bounded context, domain/application/ports | Closed state and transaction ordering; production outer and nested adapters wired, complete route coverage and live proof pending |
| Fixed outer service bootstrap | Worker Codex host/process adapter | Inventory-owned command and bounded private environment pipe; actual reserved cgroup recheck before child spawn, synthetic owner/transition/terminal-proof tests; ROOT systemd qualification pending |
| Fixed persistent epoch store | Worker Codex filesystem adapter | Real disposable fsync/rename and retained-record tests; no operational readiness authority |
| Existing report schema extraction | Worker Codex private fixed dependency | Unchanged schema/prompt exports; moved only to satisfy the existing size gate |

The parser and path mapper are private helpers, not graph nodes. The new worker
to provider relationship uses the existing supported provider module root and
typed factory mechanism. No Core/Assembly dependency, discovery, registry,
second resolver or broad refactor is introduced. Existing boundary and
architecture commands enforce dependency directions and file-size ratchets;
they do not discover semantic boundaries or authenticate Consumer Module Standard
pins. Claiming that stronger adoption enforcement would require a separately
accepted scope and actual positive/rejecting consumer fixtures.

### Bounded disposable cancellation observation

The ROOT launch fixture accepts `--timeout SECONDS` (default 300, maximum 3600)
and optional `--cancel-after SECONDS` smaller than that timeout. These control
only the fixture's wait and a SIGTERM to the existing production wrapper; they
add no runtime admission or systemd property option. Use a fresh independently
prepared/enrolled fixture for every case. The pending evidence records both
values before submission. A deadline forwards cancellation, allows a bounded
wait, and may kill only the wrapper proxy if it remains unresponsive. Such a
kill never proves service termination: `terminalCustodyProven` remains false.

Output drains are bounded after process return. A descendant retaining a pipe
produces `output-pipe-still-open`, not a successful observation or an infinite
fixture hang. Cancellation, timeout and proxy-kill facts are retained alongside
host mount/protected-byte comparisons. Cancellation runs always exit nonzero;
ROOT must independently check actual unit queues, cgroups and descendants, and
retain the evidence even when the proxy exits zero. Offline timing/signal/pipe
tests substitute process effects and do not qualify real cancellation behavior.

### Missing-source disposable case

`hosted-readonly-launch.py ROOT RUNTIME --missing-source INDEX` withholds one of
the fourteen fixed synthetic roots after publishing pending evidence and before
calling production admission. The fixture validates fixed root/anchor/consumer
projections and rejects protected paths outside its workspace or through replaced
ancestors. It never accepts an arbitrary source path. The original is renamed
into a create-only private `ROOT/missing-source-held/source`; directory changes
are fsynced. ROOT must retain it until independent queued-start and descendant
reconciliation. The driver deliberately does not restore it on proxy return:
a delayed start could otherwise see the restored source and pass admission.

Returned evidence includes `missingSourceHeldUnchanged`, comparing the retained
original's bytes and identities with the pre-submission snapshots. The missing
path naturally makes `hostProtectedUnchanged` false. These negative runs always
exit nonzero and never assert an accepted denial, service termination or provider
provenance. Production may reject before systemd submission; testing systemd's
missing-source behavior specifically still needs independently controlled delayed
startup on ROOT's disposable host. Offline tests cover every fixed root and
preservation/no-reuse, without running any host service or provider.

### Independent terminal observation in the disposable driver

After production return, the ROOT driver rereads the fixed enrolled epoch and
observes only its exact UUID-named provider/outer units. It invokes read-only
`systemctl list-jobs` and selected `show` properties, then reads the actual
hierarchical `cgroup.events` populated bit. Queue membership, manager absence,
and descendant emptiness remain separate fields. Manager failure, malformed
responses, changed enrollment and invalid unit names produce incomplete evidence.
No stop/recover/enroll action is performed by this observer.

A positive fixture exit now also requires nonempty observed units, no matching
queued jobs, zero MainPID or explicit manager not-found, and empty descendant
cgroups for every recorded unit. These are point-in-time observations only:
`terminalCustodyProven` and `liveAcceptance` remain false. ROOT must separately
establish creator fencing, provider provenance, stable custody and delayed-start
behavior; a job can appear after a point-in-time observation. Offline tests
substitute manager/cgroup facts, including live descendants, queued starts,
collected units and unavailable manager. No actual systemctl operation was run.

### Retained writable descriptor case

`--retain-input-fd` opens only the fixed synthetic README with O_RDWR and
O_NOFOLLOW, explicitly inherits that descriptor into the production wrapper,
and closes the driver's copy after return or failure. The default passes no
extra descriptors. It cannot be combined with the missing-source case: each
negative requires a fresh fixture and independent enrollment. Pending evidence
records the case before opening/submission; protected-byte and host-view checks
still run afterward. The negative case always exits nonzero, even if a wrapper
erroneously returns success. ROOT must establish whether production rejects the
inherited descriptor or removes it before sandbox entry; a proxy status alone
never counts as proven denial or custody. Offline tests verify actual disposable
file identity/closure and substitute subprocess creation, so no provider or
systemd process is launched. Hostile sibling writes/alternate mounts still need
separate controlled host qualification.

### Writable hardlink alias case

`--writable-alias` adds a hardlink from the fixed synthetic README into the fixed
writable consumer before production launch. This creates the concrete nlink=2
layout that admission must reject. It accepts no arbitrary path, refuses a
symlinked consumer and never overwrites an existing alias. The alias is retained
until ROOT reconciles delayed processes. Pending evidence records the case;
returned `aliasBytesAndIdentityUnchanged` compares its bytes, device, inode and
mode with the original baseline. The expected changed link count makes the
ordinary protected snapshot comparison fail. Negative fixture exit is always
nonzero; a denial status alone is not accepted custody evidence. Offline tests
exercise a real disposable hardlink and no-reuse/path checks, without launching
services or accessing real inputs. Alternate mount and independently scheduled
sibling-writer scenarios still require controlled ROOT host qualification.

Terminal fixture observation is bound to the original host ID, boot ID,
supervisor session and epoch generation as well as job identity. A concurrent
recovery or reboot can replace the compact outer record with a new launch;
observing that replacement must not stand in for the fixture's own descendants.
Any such change now rejects before manager observation and retains incomplete
evidence. Offline tests cover each changed session/generation field. This does
not make point-in-time observation into a creator fence.

### Separate sibling with writable input capability

The executable `scripts/fixtures/hosted-readonly-hostile-sibling.py ROOT` is a
finite ROOT-side negative fixture. Run it only later in a dedicated transient
`subscription-runtime-qualification-sibling-UUID.service`, with KillMode=control-group
and a bounded RuntimeMaxSec, using the fixed Python/script paths from the reviewed
fixture installation. Never add this sibling to the trusted inventory. It checks
initial host identity, fixed synthetic paths and its separate unit cgroup, then
holds an O_RDWR descriptor to the exact synthetic README for at most 300 seconds.
It performs no input write and creates no grant/enrollment/service itself.

A create-only private `ROOT/sibling-evidence.jsonl` records readiness with PID,
cgroup and input device/inode; the hold ends on SIGTERM/SIGINT/SIGHUP or timeout.
ROOT must confirm the unit is still live while invoking the existing production
launch driver in a fresh enrolled fixture. The unknown sibling must cause the
finite inventory admission to reject. A readiness file alone is not liveness
proof. Retain production denial, independent unit liveness, protected snapshots
and later sibling/hosted-unit terminal observations together. Passing a mock
inventory test or observing an expired sibling is not this qualification.

Offline tests hold an actual disposable file descriptor, substitute host/cgroup,
signal and wait facts, verify no input changed, and reject trusted-supervisor
execution or reused readiness evidence. No actual unit or child process was
started. This is a host fixture adapter, not runtime policy or Assembly adoption.
At this checkpoint alternate-mount and controlled delayed-start coordination
were outstanding; the following retained additions supply the bounded helpers.

### Alternate writable mount in the hostile sibling

The sibling helper's `--alternate-mount` case creates a fixed empty target inside
the synthetic writable consumer, enters a new mount namespace, verifies its
namespace identity changed, and makes propagation recursively private before
binding the synthetic README onto that target. Each syscall must succeed; the
alias must have the original device/inode before it is opened writable. The
helper then holds the alias descriptor using the same separate-unit readiness
protocol. No arbitrary source/target or mount options are exposed.

ROOT must retain host/sibling mount views and protected snapshots while production
admission encounters the live unknown sibling. The private alias disappears with
the sibling namespace; the original empty target remains as disposable evidence.
The helper does not unmount or repair the host. Offline syscall tests cover
failed unshare, unchanged namespace, propagation failure, bind failure and wrong
alias identity. All namespace/mount syscalls were substituted; no actual mount or
service was performed in this workspace. An operational ROOT run is still needed
to prove separation, custody denial and final descendant termination.

### Controlled delayed outer startup

The ROOT launch driver accepts `--freeze-hosted-slice --cancel-after SECONDS`
only as a separate negative case with a bounded timeout. It requires the existing
dedicated hosted slice to be empty and unfrozen, no unresolved initial epoch
reservations, and the driver outside that slice. It freezes only
`subscription-runtime-hosted.slice` and confirms the kernel frozen bit before
production submission. The outer service enters that slice, allowing ROOT to
exercise cancellation while its bootstrap is delayed without adding production
authority callbacks, test hooks, unit drop-ins or arbitrary service properties.
The fixture does not create/start the slice if missing.

After the production wrapper returns or fails, thaw is permitted only if the
same job/host/boot/supervisor/generation is durably CLOSED. Otherwise it leaves
pending evidence and requires ROOT to close/reconcile custody before thawing.
A failed freeze confirmation also requires ROOT reconciliation; it is never
silently retried. Thaw does not prove service or queued-start termination. The
existing terminal observations and protected snapshots follow a successful thaw,
and the negative case always exits nonzero. ROOT must qualify supported systemd
freezer/cancellation semantics and confirm no delayed bootstrap admits afterward.
Offline tests substitute all manager/cgroup operations; no slice was frozen,
thawed, created or otherwise operated in this TEST workspace.

### Combined controller base: in-progress integration

The TEST tree now starts from controller commit
`cff84124b99654b81966c3f94d3d86a058c89ab0`. The accepted activity lease,
manifest reload/drift comparison, pure launch/auth-scope checks and immutable
state-location binding remain in place. Codex controller start reads genuine
managed egress and readonly admission after the pure checks and before binding.
The Codex provider adapter repeats admission before account/session/objective
access; it builds the egress-outermost admitted process factory and carries the
same policy into generated controller configuration and materializer environment.
The readonly factory retains its existing per-spawn generation/custody checks.
Ordinary generated controller configuration retains its previous bytes.

Combined route integration now adds an authenticated supervisor/runtime role
check using the current cgroup and enrolled session. Public direct/tmux CLI
launches enter the exact independently inventoried foreground command before
manifest writes. Registry location and description/tags travel in that fixed
command. Start/resume helpers admit before launch-path and reconciliation writes.
Inside an owned runtime, the shared start primitive runs the goal to its outcome;
it does not contact a tmux server. Managed responses distinguish completed/failed
foreground execution from ordinary scheduling. A nonzero or signaled proxy is
never a successful custody receipt. Cancellation closes admission before signal
forwarding, and stop/pause requests retain reservations without claiming terminal
custody or a completed maintenance pause.

The fixed `controller-supervise` CLI command and one-shot project-start broker
command can enter the outer lifetime before their inner dispatch. The controller
then preserves its accepted activity lease and pure/auth checks before admission
and immutable state binding. Broker pre-start receipt publication additionally
requires local managed admission, before its existing authorization helper; a
foreign child identity cannot borrow its controller's epoch. Finite inventory
must name the exact chosen command/argv/cwd. This does not grant arbitrary MCP
requests or multi-job creator authority. Observational MCP calls do not reserve
an outer runtime. Direct embedded broker/controller calls outside the admitted
outer still reject; their supported supervisor transport is the fixed CLI.

These modules are transport/admission adapters under the existing worker-owned
boundary, not a new Assembly adoption. The new foreground helper returns facts
about the wait; policy remains in the host supervisor and the custody domain.
Source tests exercise actual CLI parsing, shared ops dispatch, controller binding,
and the actual controlled provider/driver/materializer with explicit synthetic
host authority, process and account facts. They do not establish genuine host
exclusivity or kernel/provider acceptance. Final combined review, remaining route
coverage and actual ROOT systemd/provider qualification are still required.

Combined gate cleanup is limited to moving the unchanged terminal-record checker
out of the accepted 1009-line ledger entrypoint into its controller adapter helper.
The ledger maintenance, drift, quarantine and raw-CAS checks are unchanged; the
entrypoint is now below the existing size cap without relaxing that gate. The
relocation test supplies an explicit synthetic disk observation so it tests
relocation conflicts independently of the worker host's configured capacity
threshold. This is not evidence of additional real disk space or permission to
launch under a capacity failure.

### Outer host CLI cancellation follow-up

The original host-launch CLI now retains a failed-attempt flag across cancellation, stdin-frame failure and child errors. A later zero exit cannot publish a successful wait receipt after any of these events. Stdin failure closes admission before forwarding SIGTERM. The actual CLI handler tests cover all three late-zero cases and retain the clean zero-exit positive; these use synthetic host/process facts, not systemd qualification. The separate foreground helper already had this failure latch.

A compatibility audit of the sealed predecessor confirmed that both ordinary hosted ProviderApi and TestNpmQualification default factories reject at the mandatory synchronous ticket fence. Existing egress tests mock the host gate and do not prove ordinary-hosted compatibility. The exclusive TEST fence remains intact as required by the combined review. Reconcile that reviewed host/deployment scope with DECISION section A before claiming a general successor runtime; this follow-up does not resolve that requirement or establish live acceptance.

### P1 lifecycle context preservation (offline TEST follow-up)

The independent V2 creator composition reproduced mandatory doctor and resume
reconciliation being skipped when the supervisor rendered every operation as
bare `run --no-tmux`. The corrected finite handoff carries Start, Continue or
Recover, its confirmation/force/skipDoctor/staleness values, job identity and the
loaded registry root through the same exact inventoried command/argv/cwd gate.
A host inventory prepared for the earlier bare command must be reviewed and
rebound to the exact lifecycle command; it is not a wildcard or compatible
fallback. No enrollment, inventory update or service launch was performed here.

The inner CLI admits before dispatch, reloads a resume manifest from the carried
registry root, and enters the original use case again. Confirmation, current
status, scope and admission are checked again. The mandatory doctor runs inside
that lifetime unless skipDoctor was explicitly true. Its prompt, job/auth roots,
account-file and Git workspace checks remain; only detached tmux availability
and tmux status probing are omitted for the hosted foreground path. Continue
and Recover retain conditional result reconciliation with preservePatch=true
before shared goal execution; reconciliation failure prevents that execution.
A failed doctor can be retried with corrected inputs. Goal failure remains
non-success, and the V3 cancellation latch remains byte-identical.

The new lifecycle CLI helper is a worker-owned transport adapter invoking existing
application use cases. Its operation enum/context in the foreground renderer is
a closed transport contract, not host authority, an operation platform or a new
Assembly composition scope. The helper also holds the existing CLI-to-launch
projection to keep the CLI under its established size cap. No architecture gate
was relaxed. The scoped Consumer Module Standard classification above remains;
no existing adoption pin was discovered in the tracked baseline.

The retained independent creator test was adapted into a repository composition
suite with actual use cases, CLI parser, route, foreground proxy and shared ops.
Host/process observations, doctor/status, manifest storage and the final goal
are explicitly synthetic. Both supervisor and admitted runtime roles cover
Start/Continue/Recover success, doctor rejection, explicit skip, retries, goal
failure, confirmation/status denials and patch-preservation ordering/failure.
An inner status change rejects after admission. These are offline control-flow
proofs, not actual systemd/provider qualification. ProviderApi/TestNpmQualification
compatibility remains separately unresolved; the managed ticket fence is intact.

### C1 ordinary compatibility checkpoint: closed domain records

The accepted `/tmp/runtime-lifecycle-review-compatible-plan-TEST/COMPATIBILITY-PLAN.md`
and its complete independent `REVIEW.md` now govern the successor compatibility
work. The reviewed lifecycle implementation and V3/cff controls are retained.
`worker-core/hosted-custody/domain/hosted-installation-activation.ts` adds closed
installation, positive ordinary birth/catalog, launch-origin and activation
records. Its publication guard preserves permanent exclusive enrollment and
ordinary sibling reservations, rejects skipped generations and identity/session
replacement, and closes ordinary submission during exclusive transitions.
These are domain constraints in the existing hosted-custody slice; they neither
issue authority nor constitute Assembly adoption. Thirty-four focused synthetic
cases exercise parsing, reservation retention and transition rejection.

This checkpoint is deliberately not connected to admission yet. C1 remains
incomplete: common provider-owned fence extraction, strict private readers,
trusted installation/enrollment/activation operations, default ordinary factory
composition, launcher/lifecycle routing, and OS-backed composition tests remain.
No checks have been removed to make ordinary execution pass. The next coherent
step is the common fence and private record adapter, preserving existing managed
lock semantics. Domain transitions alone cannot prove creator fencing, queued
job drain or descendant termination; adapters must obtain each independently.
All actual installation/stage/grant/job/custody claims remain UNBOUND. No live
service, mount, provider, grant, installation migration or deployment was run.

### C1 common fence and private evidence continuation

The provider-owned `hosted-process-activation.ts` now supplies the same existing
boot-specific `readonly-epoch.<boot>.lock` mutex for managed and future ordinary
composition. Managed epoch enrollment, mutation and recovery use that fence;
`withHeldFence` permits a worker transition already holding it to compose epoch
operations without creating another mutex. Capabilities expire when the
synchronous callback returns or throws. Existing retained-lock, exact-next,
revocation and reservation rules remain in force.

The provider reader validates initial-host namespaces, private ancestry,
no-follow single-link root-owned files, bounded stable reads and strict UTF-8.
Worker composition validates the closed domain records. Positive ordinary births require the catalog digest and installation
binding. Durable managed enrollment, custody and revocation take priority;
missing or corrupt referenced managed history rejects even a different ordinary
identity. A retained closed, terminal managed history permits a distinct positive
ordinary identity to proceed to subsequent admission checks. These reads are
not yet current process, stage, session or egress admission.

The worker activation store uses create-only `.next`, rename and fsync under the
common fence, with exact immediate-successor validation. Explicit recovery
persists CLOSED before returning control and never deletes conflicting pending
state or silently resumes a mode. Real disposable filesystem tests exercise
content binding, retained partial publication, shared-lock contention and
capability expiry; kernel metadata and namespace facts are substituted. The
submit interleaving test currently covers the storage callback, not the final
ordinary default factory. Installation enrollment, finite inventory upgrade,
host transition observations, genuine ordinary factory and launcher/lifecycle
routing remain required before C1 is complete. No intermediate source admission
or live host qualification GO is claimed.

The existing executable boundary gate rejects all provider-to-worker-core
imports, more strictly than the architecture document's neutral-contract
example. No guard was weakened or bypassed: the provider adapter retains the
finite byte-reader and synchronous fence; worker composition owns domain record
parsing and installation/origin binding. The default-provider composition must
preserve this rejecting boundary while implementing its trusted observation
path; it has not yet been wired. This checkpoint does not claim that storing a
positive origin alone restores ordinary execution.

### C1 trusted installation and configured origin enrollment

Inventory schema 2 preserves the exact managed `runtimeLaunch` tuple and adds
`ordinaryCreators` and `disabledCreators`. Each ordinary creator has a unique
`creatorId`, a trusted `jobId`/`jobRootDir`/`workspacePath`, and an exact `launch`
command/argv/cwd tuple. Installation requires the same artifact's absolute CLI
entrypoint (directly or via the current Node executable) and the configured
workspace cwd; an inventoried older or foreign launcher still rejects.
Multiple launch tuples may name the same identity only
with identical roots. Conflicting scopes, duplicate creator IDs and duplicate
masked legacy unit names reject. Schema 1 remains readable for retained managed
state; it cannot authorize a new ordinary installation.

The kernel now checks schema 2's disabled service/timer/socket creators are
masked, inactive and unqueued; foreign enabled/linked/alias units and any active
socket or timer reject exclusive inventory. The existing process/cgroup walk,
fragment hashes and queue checks remain necessary. This is a finite systemd
installation contract; it cannot force arbitrary trusted host-root programs to
obey the runtime fence.

Three finite operator commands are implemented in the existing operator CLI:
`install-host`, `enroll-ordinary CREATOR_ID`, and `resume-ordinary`. Installation
derives bindings from the independently installed stage at this module's runtime
directory and the exact inventory bytes, under the common mutex and initial-host
supervisor identity. It creates a unique installation and CLOSED activation;
missing mutable history under an existing installation is never regenerated.
Enrollment selects an inventoried identity, requires CLOSED and matching session,
and rejects retained managed custody/revocation/enrollment. Workers cannot
establish provenance through job JSON, environment, profile or an arbitrary
creator argument. Resume validates the entire origin catalog and immutable
births, retained managed history, terminal reservations, inventory and descriptor
boundary before explicitly publishing ORDINARY.

Catalog changes retain `.next` through activation publication. A crash at either
rename leaves a reader-visible pending publication. Explicit recovery validates
an append-only immediate catalog revision and every referenced birth, completes
the exact publication and returns CLOSED. Unknown/malformed history is retained.
Tests run the actual installation/store/kernel composition over disposable files
and substituted finite OS observations, including independent stage loss/drift,
wrong supervisor, unknown configured creator, retained managed identity, queued
legacy service, inherited descriptor and both interrupted rename boundaries.

These operator commands have not been run against a host. Ordinary starts,
provider-default submission and entry/exit drain routing remain unwired; the
commands are not a rollout instruction or an ordinary execution acceptance claim.
The next implementation must connect those production boundaries before any
source compatibility GO. All stage/installation/grant/job/custody observations
remain UNBOUND pending ROOT qualification. The sandbox still rejects the requested
`/tmp/docs-ordinary-compatibility-TEST` checkpoint destination as read-only; bounded
test logs and source identity evidence are retained under the job's writable
agent temporary directory, with external patch export still pending.

### C1 exclusive transitions and mandatory managed scheduling gate

The same operator CLI now exposes `enter-exclusive`, `finish-exclusive`,
`leave-exclusive`, and `finish-closed`. Entry publishes ENTERING_EXCLUSIVE under
the common mutex, closes any managed epoch, then issues stops outside the mutex.
Exit publishes LEAVING_EXCLUSIVE before closing the managed epoch and stopping
retained units. Ordinary runtime and provider sibling reservations remain in the
activation record. Neither stop success nor a missing PID removes a reservation.

Completion reads each immutable ordinary start, matches installation, generation,
origin, session, unit and cgroup, then independently checks its creator completion
receipt, systemd queue and descendant population. Receipts bind the exact start
bytes. Managed reservations retain their original independent proofs. Explicit
recovery finishes valid pending publication, persists CLOSED, reconciles retained
starts and only then replaces a rebooted session. `finish-closed` ends CLOSED;
resuming ordinary still requires `resume-ordinary`. The first managed enrollment
reference can become durable during ENTERING and cannot be removed when entry
aborts. Revocation now closes host activation before the epoch/tombstone and
issues ordinary/managed stops outside the common mutex.

`finish-exclusive` requires a current READY, non-revoked managed epoch with no
unresolved managed reservation, exact stage/inventory binding and authentic
readonly grant/review/policy/custody material. Both managed outer submission and
every managed provider spawn additionally require matching EXCLUSIVE activation.
Existing readonly material, runtime owner, generation, lease and cancellation
checks remain mandatory. Missing activation no longer admits a managed launch;
explicit migration and stage/inventory rebind are required before installing the
successor artifact. No implicit managed-only migration record exists yet.

The new transition composition tests use actual installation, epoch, material,
private reader and kernel parsers with disposable files and substituted OS facts.
They cover an authentic synthetic managed tuple entering/leaving EXCLUSIVE,
ordinary provider siblings, unlocked stop callbacks, creator/queue/descendant
failures, both reboot proof stages, material drift, retained promotion after
mutable grant/policy removal, and revocation ordering. Managed runner composition
now also rejects CLOSED, ORDINARY or missing activation on quota account rotation
before the second actual default node-adapter spawn. These are synthetic source
checks; no systemd service, provider, grant or installation was operated.

At this checkpoint C1 changes against the hash-verified reviewed P1 archive are
952 production and 874 test nonblank added/removed lines across 17 TypeScript
files (`c1-size.json` records the per-file measurement). Ordinary default-factory
admission, trusted start publication/receipt production, wrapper/lifecycle routing
and the explicit managed-installation migration are still incomplete. The
ordinary reservation fixtures are private OS facts in tests, not a substituted
production launcher or a source compatibility GO. V3 cancellation and the P1
lifecycle implementation remain preserved.

### C1 ordinary start provenance checkpoint

The root store now prepares ordinary runtime reservations from an exact finite
inventoried command/argv/cwd under the common fence. It binds the positive origin,
actual dispatcher PID plus process birth, installation, boot/supervisor session,
start generation and exact genuine grant bytes (including explicit no-grant).
The reservation is persisted before the immutable start birth. An interrupted
publication cannot leave an untracked submitted creator: the retained successor
is recovered CLOSED, and missing birth evidence prevents automatic resumption.
This is preparation for the dispatcher; no ordinary OS submit is wired yet.

The worker's ordinary runtime reader derives the start identifier from actual
cgroup membership, validates the retained reservation and private origin, then
checks the real supervisor service/fragment, live dispatcher PID birth/cgroup,
boot, stage/inventory and grant binding. Deleting an npm grant cannot downgrade a
running origin to ProviderApi. Provider sibling groups cannot impersonate the
outer ordinary runtime. Subsequent retained reservations may advance activation
without invalidating the original runtime's own bound start generation. The
reader requires a currently held common fence; neither a job argument nor an
environment marker supplies origin authority.

Focused validation now passes 422 tests in 14 files with substituted OS/private
facts and real record persistence. The added cases cover genuine no-grant/npm
origins, exact launch tuples, publication interruption, lock contention, retained
starts across generations, PID reuse/movement, wrong groups and boot, identity
and stage drift, missing/terminal state, permanent managed priority and deleted
or changed grants. Typecheck, build and architecture gates are recorded alongside
the source identity. These tests do not establish actual systemd/provider acceptance.

The C1 delta from the hash-verified reviewed P1 archive is now 1,039 production
plus 976 test nonblank added/removed lines (2,015 total). This crosses the 2,000
line checkpoint because one admission invariant spans immutable installation,
origin and start records, serialized activation/publication/recovery, independent
creator/queue/descendant proofs, managed scheduling gates, and their real composed
negative tests. Releasing a half that permits ordinary starts before both common
fencing and managed gating would violate that invariant. No intermediate source
is deployable. The cohesive store/reader file is above the 500-line consideration
threshold but below the hard cap; this checkpoint keeps the single publication
protocol together rather than introducing a second state owner.

Still incomplete: the provider's genuine default-factory origin lookup and
synchronous sibling submit/receipt production, actual ordinary dispatcher and
wrapper/lifecycle routing, explicit managed-only installation migration, final
stage/inventory rebind and disposable host fixture update. The reservation and
worker reader are not a compatibility GO. All live installation, grant, service,
provider and custody observations remain UNBOUND pending ROOT qualification.

### C1 managed preparation ordering checkpoint

The official `enroll`, `admit` and `recover` operator routes now require the
installed host to be ENTERING_EXCLUSIVE. Under the same common fence they validate
installation/session, independently reconcile every ordinary creator, queued start
and descendant, and verify the finite inventory and descriptor boundary before
managed material effects. Epoch enrollment and domain recovery reuse the held
fence; they do not acquire a second mutex or use a supplied authority adapter.
A newly written managed enrollment is bound into activation even when subsequent
material publication fails. Recovery may finish an exact retained epoch successor;
missing history still denies. Recovery prepares the managed epoch but leaves host
activation ENTERING_EXCLUSIVE until the explicit `finish-exclusive` operation.

The added composition coverage includes actual epoch enrollment, actual domain
recovery through the production host, all three independent ordinary drain
failures, forbidden activation phases, failure after immutable birth publication,
pending-epoch recovery and the official recover CLI. Systemd and private host
facts remain substituted; no live operator command was run. The current measured
C1 delta is 1,158 production plus 1,059 test nonblank changed lines against reviewed
P1. The previously documented single-invariant size justification still applies.
Ordinary default factory/dispatcher/lifecycle wiring and ROOT qualification remain
incomplete; this checkpoint does not establish source compatibility GO.

### C1 genuine default provider primitive checkpoint

The default node process factory now admits positively enrolled ordinary runtime
origins directly from private records and actual process facts. It requires the
same-artifact stage/inventory, catalog and immutable start, current supervisor and
creator PID birth/cgroups, ORDINARY activation and exact grant binding. Both
genuine ProviderApi/no-grant and TestNpmQualification retain the existing systemd
invocation, namespace capability drops, egress frame and environment transport.
No ordinary managed ticket or readonly mount defaults are fabricated. Stripping
the hosted marker or supplying a forged ticket cannot bypass the actual-context
gate on an enrolled host.

Every default provider submission now reserves its own sibling unit and immutable
start under the common fence before synchronous OS submission. Failed or ambiguous
submission closes activation while retaining the reservation. Genuine normal-zero
systemd wait callbacks may write only a receipt bound to that exact start; they
never terminalize its reservation. Cancellation/process/stdin failure followed by
late zero does not produce a receipt. Queue and descendant proofs remain separate.
Each respawn/account environment change rereads origin and grant bytes; deleting
an npm grant cannot become ProviderApi. Retained managed history allows only a
distinct positively enrolled ordinary identity after explicit host recovery and
resume, with all managed reservations terminal.

The provider adapter validates the finite private wire records itself because the
existing executable dependency gate rejects provider-to-worker imports. The
worker-core domain remains the owner of enrollment and activation transitions;
this provider adapter can only append a verified ordinary sibling or close its
failed admission. This is scoped adapter enforcement under the existing module
architecture, not Assembly adoption or a new general authority framework.

Real default primitive tests substitute only private filesystem, process and OS
facts. They exercise genuine no-grant/npm submits, sibling retention across
respawns, explicit return from managed history, prior-fence observation at spawn,
bootstrap/environment/capability preservation, missing/closed/corrupt or changed
origin/grant, environment stripping, forged tickets, UID denial and cancellation
receipts. The worker-level egress dispatch, ordinary outer dispatcher/bootstrap
and wrapper/lifecycle routes still require wiring; these primitive results do not
claim complete ordinary worker compatibility or actual host qualification.

This checkpoint passes 451 focused tests in 14 files, source typecheck, build,
architecture boundary gates and whitespace validation. The measured C1 delta is
1,465 production plus 1,159 test nonblank changed lines from reviewed P1. The
increase is the actual provider boundary's independent private wire reader and
serialized sibling lifetime, required to avoid a worker-import/injected-factory
exception; the previously documented indivisible admission invariant applies.
No unrelated historical heavyweight shards or live services were rerun.

### C1 ordinary worker admission and inner routing checkpoint

Official worker egress and readonly admission now select the ordinary route from
actual runtime cgroup membership and then require the strict positive private
origin/identity reader. Ordinary controller composition retains the genuine default
factory; admission does not inject a privileged factory or manufacture a managed
ticket. Both the existing goal route and runtime CLI recognize an admitted ordinary
inner runtime instead of attempting managed admission. On an installed host,
removing an environment marker cannot select the nonhosted route. The ordinary
outer dispatcher/bootstrap and wrapper lifecycle still require implementation.

The ordinary readers now reject even an orphan managed policy, in addition to
custody, tombstones, grants and retained managed enrollment. A caller-provided
identity or workspace mismatch rejects before provider effects. No-grant API
policy retains the original engine eligibility; genuine npm qualification keeps
its existing engine restriction. Non-root local callers retain API-only policy
without reading host-private authority, including when they spoof an egress
marker. The actual provider primitive still requires authenticated hosted origin
at its physical submission boundary.

New tests compose the real egress, readonly, controller, inner CLI/goal routes and
default process adapter with substituted private/OS facts, including policy loss,
identity/workspace/engine/environment mismatch and stale admission on the next
account environment. The older grant-only fake-executor fixture now correctly
expects refusal without installed origin/material. Local controls in the P1
transport suites explicitly substitute a noninstalled host; they do not consult
the real host installation. V3 cancellation and managed lifecycle algorithms are
unchanged. The source remains incomplete until outer ordinary lifecycle wiring,
migration/bindings, disposable fixture updates and ROOT qualification are done.

Verification: 525 tests across 17 scoped files passed, followed by 134 tests in
the two affected admission files after the final engine/non-root controls (530
unique current cases). Typecheck and boundary gates pass. The first concurrent
build aborted without a diagnostic; a full build with one libuv/V8 worker thread
succeeded, followed by a successful final root compilation/import rewrite after
the last admission edits. Both failed and successful build logs are retained; no
cause is inferred from the abort and no dependencies or versions changed. The
current C1 delta is 1,534 production plus 1,277 test nonblank changed lines. The
single admission-invariant size explanation above still applies.

### Attempt 10: sealed records and ordinary dispatcher/stop composition

The resumed 78-path source state was preserved and sealed outside jobtmp after
394 focused tests in ten files and complete typecheck passed. This checkpoint
includes actual private records, strict readers, serialized publication/recovery,
activation transitions and initial ordinary dispatcher/bootstrap wiring. It is
not the earlier domain-only checkpoint. The exact source/patch identity and logs
are retained at `/tmp/docs-readonly-runtime-implementation-TEST-20260908-v1-attempt10-artifacts/CHECKPOINT.md`.

The ordinary dispatcher now has composed tests for reservation-before-submit,
fixed inventory command bootstrap, normal wait receipt, cancellation/error latches
and retained custody. The official goal stop route now resolves the retained
ordinary birth, checks its installation/session and immutable starts under the
common fence, closes admission, then signals only that job's units outside the
fence. It does not stop another ordinary job, erase reservations or claim terminal
custody. Initial-supervisor stops remain possible after admission closes or grant
bytes change; an ordinary inner caller must pass its actual-process origin reader.
Managed identity retains the existing managed stop route.

The real ordinary runner plus safe executor and genuine default provider factory
now exercise quota rotation for both ProviderApi and TestNpmQualification, and
reject a deleted npm grant before the next account's OS submission. Only private
filesystem/kernel observations, process transport, provider protocol and synthetic
inline account credentials are substituted. No provider factory is injected into
this composition. The tests exposed an actual integration defect: app-server
starts in its materialized account HOME, whereas the initial ordinary primitive
incorrectly required workspace cwd. The primitive now accepts canonical workspace
or matching account HOME after authenticating the actual runtime origin. HOME
never selects a job, profile, grant, installation or mount. Existing process cwd,
capabilities, environment transport and egress remain intact. Old grant-only mock
runner success cases now assert refusal; the genuine composed success cases
replace their unsupported compatibility claim.

These are scoped adapter and lifecycle changes under existing Clean Architecture,
not Assembly adoption. The baseline search still finds no Consumer Module Standard
adoption pin; the supplied document hash remains unchanged. Explicit managed-only
installation migration, final disposable fixture/binding updates and ROOT's
independent review plus real systemd/provider qualification remain outstanding.
No runtime deployment, service operation, grant creation, real auth read, commit
or publication was performed. Git lock creation remains denied as read-only.

### Explicit retained managed installation migration

`install-managed-host` now provides the finite operator route for an existing
managed-only custody installation. Under the common fence it reads the permanent
managed enrollment and current epoch, independently binds the same-artifact stage
and inventory, and requires CLOSED with every reservation terminal. Retained
terminal flags alone are insufficient: creator, queue and descendant observations
are repeated. The command preserves exact managed bytes and revocation, installs
an empty ordinary origin catalog and CLOSED activation referencing the existing
birth, and performs no automatic start or readiness transition. It neither creates
nor rewrites stage, grant, review, policy or managed identity.

A fresh ordinary `install-host` still refuses retained managed history. Migration
rejects missing/corrupt history, pending epoch publication, foreign stage/host,
ordinary orphan records and nonterminal evidence. A partially published installation
is retained and cannot be silently recreated by replay. Later recovery, ordinary
enrollment, or exclusive activation remains explicit and independently gated.
This source route does not migrate a live host or establish stage/inventory
rebinding authority. Disposable fixture/binding updates and the final route audit
remain outstanding before ROOT's actual systemd/provider qualification.

The executable disposable launcher now also requires matching EXCLUSIVE activation
and installation, the exact permanent enrollment byte digest, the configured
runtime directory/stage tuple and terminal ordinary reservations before any
submission evidence or process launch. Pending activation/catalog/epoch publication
rejects. It retains exact installation, activation and enrollment byte digests in
both pending and returned evidence. This is fixture preflight, not replacement
runtime authority, installation provisioning or a live mount observation. Offline
Python cases cover phase/session/birth/runtime mismatches, pending publication and
retention of this binding through the composed launch fixture. The actual ROOT
inventory and deployment records remain independently owned and unbound here.

### Current source audit: native harness and managed stop fence

The dependency-free Node harness now imports the real common-fence adapter and
supplies explicit synthetic installation, inventory and activation records.
Operator cases begin in ENTERING_EXCLUSIVE and explicitly finish exclusive
activation before expecting admission. Missing hosted origin refuses even after
volatile record deletion; the separate uninstalled local control still passes.
Stop failure now remains a failed operator result with custody retained. These
are current-source assertions, not retained pre-activation success expectations.
The synthetic kernel and prior activation facts remain stated limitations; real
transition/store/kernel compositions run in the TypeScript suites.

The source audit also found managed stop and outer cancellation still issuing
synchronous OS stop requests while holding the common epoch fence. Both now
publish CLOSED and capture immutable reserved units under the fence, then release
it before stops. Completion callbacks can acquire the fence; failures retain every
reservation, and delayed callbacks cannot target a successor unit. Existing stale
generation and cancellation checks remain. Focused tests exercise reentrant fence
acquisition from the simulated stop callback, including a failed outer stop.

The completion evidence remains scoped: source admission, propagation, parser,
publication, transition, transport and default-factory checks are offline. Actual
readonly mounts, stable pathname ancestry, absence of alternate writers and full
systemd queue/descendant custody still require the separately authorized ROOT
fixture. Independent review must use the final exact source/patch seal and current
stage/inventory bindings; passing mocks supplies none of that authority.

### C1-R1/R2 admission and stop repair

Managed outer submission and provider admission now apply the same inspected
installation binding as ordinary admission under their existing common fence:
the executing module's runtime directory, actual staged receipt, host identity,
and exact inventory bytes must match the retained installation. Root ownership
alone does not permit inventory drift. The disposable Python preflight reads the
actual stage and inventory, retains both observed SHA-256 values, and rechecks
the inventory digest before selecting its command. These are offline admission
and evidence checks; actual systemd/provider qualification remains UNBOUND.

An ordinary runtime's stop route authenticates its retained private birth,
catalog, reservation, exact job/root/workspace, actual cgroup and kernel session
even after CLOSED or deletion of its npm grant. The launch reader still requires
ORDINARY and the current exact grant digest. Managed identity takes priority;
stop publishes CLOSED while fenced, requests OS stops after unlocking, retains
reservations and cannot assert terminal custody or reopen admission. No new
public composition or arbitrary mount option is introduced by this repair.
