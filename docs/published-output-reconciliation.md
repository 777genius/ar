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
