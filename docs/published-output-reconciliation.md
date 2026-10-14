# Reconcile an incorporated reviewed publication

`codex_goal_project_reconcile_published_reviewed_output` is a root admin,
ledger-only recovery operation. It records an existing approved frozen output
as integrated when every changed path is incorporated in an authenticated
historical canonical publication. It creates no integration attempt, CheckRun,
commit candidate, patch application to a workspace, ref update, or push.
Strict checked-attempt adoption retains its exact parent/tree requirements.

The distinct root-owned 0600 regular non-symlink permit is SHA256-bound by the
caller. Its strict schema binds the controller, project, worker, immutable
reviewed output, actual approved review identity/decision hash, changed paths,
patch/base, both workspaces, GitHub repository/branch, historical published SHA,
canonical ancestor head, owner identity, and raw evidence paths/hashes.
The operator must retrieve publication, ancestry, identity, CI and review facts
through authenticated `gh`. Runtime provenance is truthfully
`operator_attested_publication_incorporation`; it does not independently
authenticate a GitHub session or validate a signed attestation.

Required canonical CI names are explicit and nonempty even if the native
private-artifact capture's `requiredChecks` is empty. Every CI result must be
successful at the exact published SHA. Nonempty private check specifications
require an explicit trusted mapping of the full specification hash to a
successful canonical check. A review may refer to the original pre-squash SHA;
retain that actual SHA and prove its reviewed tree equals the published tree.
Never relabel a different commit's checks as publication checks.

Raw proof files must be canonical regular root-owned files without group/world
write permissions. Publication/check packets, source approval evidence, actual
publication review verdict, and additional supplements are frozen by hash into
the configured evidence custody before the typed receipt is published last.
Root's approval of these facts is the trust boundary, not a universal importer.
Missing approved native snapshot or genuine review/CI evidence refuses recovery.

Verification reconstructs the exact frozen patch on its source base in a
disposable index/object directory. The exhaustive no-renames changed path set
must match the approved capture. For every path, presence, mode, type and blob
must equal the historical publication, including additions, untracked files,
deletions and executable bits. Unsupported objects or read/apply errors refuse.
Unrelated published-tree changes and different squash parents are allowed.
Later legitimate canonical changes do not invalidate historical incorporation.

The existing source workspace lease, actual completed/dead worker observations,
and frozen tracked/untracked comparison precede first ledger consumption. The
comparison is repeated after asynchronous receipt publication. A retry uses the
immutable receipt and backup. If consumption is still absent it rechecks the
same frozen source and quiescence; after an exact native committed decision is
confirmed it performs an idempotent ledger replay without mutable recapture.
Conflicting permits, evidence or ledger decisions refuse. The authoritative
local ledger reader validates receipt, complete path proof, backup and raw proof
hashes/bindings; old legitimate terminal records retain their existing behavior.

This is a private feature slice within Project Control, using existing access,
custody, workspace lock and transactional ledger ports. The current Consumer
Module Standard pin is unchanged: Get Modular
`81063add7de50ffe2b91cc74bf7271b298624c21`, complete document SHA256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
No independently assembled lifecycle or Assembly adoption is introduced.
A shared immutable incorporation proof contract could live in a small library
with Host Git/custody adapters depending inward, approximately 100-150 LOC.
These root attestation and ledger rules remain product policy; the current
single recovery consumer does not justify a shared runtime or authority manager.

No installed runtime is changed by this delivery. Deploy separately with retained
custom patch inventory, exact artifact qualification and rollback pins. Merging
and synthetic TEST evidence alone do not establish that a live incident cleared.

## Retain an obsolete approved output

`codex_goal_project_archive_reviewed_output` is a bounded root-admin adapter in
Project Control. It records native `archived` disposition after retaining a
verified backup of an existing approved frozen output. Archive is a conscious
owner disposition, with no claim of integration or rejection. Historical
approval remains valid. Source files, original patch, approval, latest result,
controller scopes, Git branches and remotes remain unchanged.

Call with `registryRootDir`, `controllerJobId`, `reviewedOutputId`, `permitFile`
and `expectedPermitSha256`. Omit `confirmArchive` to preview; only explicit
`confirmArchive: true` publishes. Preview validates scope, immutable original
bindings, directory identities, source quiescence and source capture. It
publishes no archive, receipt or ledger entry; ordinary workspace lock/capture
scratch is used and released through existing adapters.

The absolute canonical permit is a root-owned regular non-symlink 0600 file
bounded to 128 KiB. Its strict private schema is in
`src/worker-codex/codex-goal-mcp-project-control-reviewed-archive.ts`. Bind the exact registry,
controller/project/worker/task, source workspace and worker job root; raw
controller and worker manifest hashes; reviewed output identity; raw snapshot,
patch, original approval/attestation and retained review-marker hashes; and
the review-decision JSON hash. Use `approval.json` for legacy native approvals
or `review-attestation.json` for current native captures. Include owner, reason
and requested timestamp. Bind configured evidence and ledger roots by exact
path/device/inode. `archivePath` must be exactly the configured active evidence
root plus `approved-archive-<reviewedOutputId>`. No caller-selected source root,
remote, branch, custody bootstrap or scope repair is provided.

The native workspace lease guards capture. Require a genuine strict completed
result read as a canonical regular file through no-follow custody. A symlink
to another job's completed result supplies no completion proof. Require an
observed dead worker; active PIDs, stale live PIDs, missing/uncertain tmux
observations and unreadable progress refuse. Validate a present authoritative
progress record before using the common projection: malformed PIDs and active
status without a usable positive integer PID refuse. Truly absent progress
remains supported. The frozen snapshot must
still match the source base and complete tracked/untracked patch. Configured
directory identities are rechecked across preparation and publication and
inside the native ledger mutation-lock checks; custody keeps its descriptor
and no-follow publication protections, including PR264. Exact receipt and
backup hashes, original approval and complete source/quiescence checks are
repeated by that guard after native ledger staging/fsync, before its atomic
publication, while retaining the workspace lease. The existing native terminal
writer uses custody to hold canonical ledger/items descriptors and publish
no-follow children; replacing items cannot redirect write/link outside custody.

Existing immutable custody retains `tracked.diff`, `tracked.numstat` (including
additions), `git-status.txt`, byte-identical original manifest/approval/marker,
and `owner-intent.json`. Before backup publication, immutable custody publishes
`approved-archive-<reviewedOutputId>.preparation.json` directly under the pinned
evidence root, outside the archive directory. It independently binds the permit,
receipt digest and archive device/inode for interrupted preparation. The
hash-bound `approved-output-archive.json` receipt is published last inside the
archive. Native `recordTerminalOutputDecision` then records archived
status and recoverable backup paths. Exact replay validates the receipt,
originals and backup before native idempotent recording. The existing immutable
decision note independently anchors the receipt SHA256 and archive device/inode;
replay cannot adopt paired receipt/backup or receipt/directory substitutions.
Preparation is checked against its separate retained checkpoint. Evidence
without these anchors refuses rather than acquiring an anchor from its current
receipt. A committed replay
needs no mutable source recapture. Interrupted preparation reuses existing
immutable custody publication; before first consumption it rechecks the
stopped source. Changed intent, originals, roots, backup or existing terminal
decision refuse. Failure can leave retained evidence, never a successful
partial disposition. Existing ordinary admission consumes this native status;
other output debt continues to block.

This adds no shared contract, independently assembled capability, graph node,
library, migration, scheduler or retention framework. The supplied current
Consumer Module Standard matches existing reconciliation's reference at
`81063add7de50ffe2b91cc74bf7271b298624c21`, complete-document SHA256
`49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
No Assembly adoption or pin change is implied. Proof uses disposable TEST Git
workspaces, native controller review/admin MCP and real ledger/custody. No
installed runtime or real Token output has been modified or archived.

CI qualifies native archive privilege in two mandatory lanes. Ordinary unit
tests run the actual nonroot rejection before permit/controller IO, along with
the native writer confinement tests. The `archive-root-tests` job runs every
archive positive, rejection, replay and race case as effective UID 0 on a
disposable TEST copy; fixtures verify root-owned 0600 permits. Its single
elevated command runs only the archive test file, with a cleared environment,
isolated HOME and temp directories, and disabled global/system Git config.
The copy contains source and dependencies, without checkout Git metadata,
credentials or real runtime data. Both jobs are required by the final CI gate;
a requested privilege lane with the wrong native UID fails. Production guards
and existing architecture classification remain unchanged.

The privileged CI lane copies the unchanged public tsconfig.json with its TEST sources. Cleanup elevates only removal of the exact mktemp-created TEST directory, so root-owned transient files cannot turn successful qualification into an ordinary-user cleanup failure.
