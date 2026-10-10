# B1 ext4 project-image preparation

Source checkpoint only. No native artifact has been built or qualified by this
change. No launcher consumes it and no payload start, release, live growth or
cleanup implementation is supplied. Those B2/A integration gates remain open.

The TypeScript reservation store reuses the existing accounting domain's exact
uint64 arithmetic, identity parsing and 5 GiB/50k floor. It does not reuse the
prototype PID/crash lock or its Q-only ledger: an allocated image requires the
full `E.bytes=P+1 MiB`, `E.inodes=Q.inodes+16` standing charge. `Q=U0+G` in both
counters. P's conservative estimate never increases the writer cap. Actual
formatted free space plus current charged usage must reach Q after an additional
64 MiB maintenance allowance. Allocation still consumes fresh outer statfs and
E is subtracted again. Pending/Prepared/Unknown/Blocked never earn usage, delete,
terminal, TTL or cleanup credit; B1 has no release transition.
Root control publication separately reserves 32 MiB above the unchanged 5 GiB
floor: next ledger <=4 MiB, temporary/intent, one native state update and bounded
directory/filesystem metadata. Existing control allocations already reduce fresh
root statfs. Initialization checks capacity before publication; native creation
of the fence and each ledger/state publication check fresh root headroom before
writing. Existing fence/read paths remain available without new root allocation.

One installed root native holder owns a stable `flock` inode, bounded ledger CAS
and durable intent/temporary/rename/fsync publication. No TS filesystem write
continues after that holder dies. Pending is acknowledged only after directory
fsync; native prepare refuses a missing canonical pending digest. An interrupted
ledger intent blocks admission. A retained incomplete native state is inspected
as Partial, never replayed. A physically Prepared state can reconcile a lost
acknowledgement using exact backing/loop/inner UUID/project/quota anchors. Old
image generations missing from the ledger block registration; nothing is adopted
or swept. Prepared inode identities cannot be reused.

Native prepare uses real posix_fallocate/fsync, LOOP_CONFIGURE, fixed root-owned
ELF mke2fs execution through a retained FD, non-discard fully initialized ext4,
one mounted project-enabled image and quotactl_fd exact byte/inode hard limits.
Quota assignment/readback precede creation of the project-inheriting payload
layout; those eight payload/layout inodes and their blocks consume G. U0 is truly
zero before layout creation. A nonzero resume baseline is refused before Pending
until the native sealed-import producer is implemented; its Q arithmetic remains
represented without pretending an import happened. Zero/unrepresentable hard
limits and overflow are rejected rather than rounded to unlimited or a larger Q.

FD3/4/5 are retained scratch-root/control-root/scratch-block descriptors. FD6 is
the digest-authenticated installed ELF executed through `/proc/self/fd/6`.
The adapter captures closed config before asynchronous I/O, verifies protected
canonical ancestry, owners/modes, exact open identities and stable bounded ELF
bytes, then starts it with a fixed environment. The native holder checks root
initial-user-namespace, machine-id, raw scratch superblock UUID, scratch ext4
device, distinct root control filesystem and boot identity. Preparation additionally
checks the scratch mount is private and quota_v2/loop are already available;
there is no module load, install, remount or modification of shared scratch.
Unsupported availability is an error, not readiness. Wire size, command deadline,
stderr and retained FD counts are bounded; kill affects only this holder and its
PDEATHSIG-protected formatting child. Images/loops/mounts/state remain retained.
The whole-command watchdog covers header/payload write backpressure and response,
closes queued stdin on uncertainty, and never retries or reenqueues the command.

Existing authoritative registration must select exactly one protected control
root for a filesystem. Creating arbitrary control roots would create competing
fences. This source does not provide a new registry/installer or reset/recovery
path. Its typed root-service configuration is composition input, never a payload
argument and never proof of A admission. An existing prototype exposure authority
in that root is refused. Root custody checks are observational; they do not exclude
unrelated privileged root changing mounts, files or code after an observation.
Generation registration and host native authority supply that operational boundary.
The current admission scan is bounded to 1024 retained generations and holds up
to four pins per Prepared row; actual service FD/capacity and many-job loop/image
scalability must be qualified. Fresh usage does not rewrite Prepared ledger rows
or revisions. This per-job design is not automatically accepted at production scale.

The current native holder retains image/fs/payload/loop FDs until its fence callback
ends, and kernel-owned mount/loop references retain backing thereafter. Returned
facts are metadata, not a retained start capability. A's native author must add
the exact handoff: while this holder's Prepared source FDs are retained, transfer
them using an authenticated native descriptor channel to the actual managed service
namespace; bind machine/boot, filesystem dev/UUID, job/generation/project, policy,
current receipt digest/revision, backing dev/inode/P, loop dev, inner UUID and
payload dev/inode/mount ID. Only that existing A current-revision/barrier owner may
verify its completed namespace and permit a writer. Never serialize a function,
lease, JSON receipt, callback result or caller boolean as that authority. B2 must
also implement durable target E before physical/loop/online-grow effects, exact
both-limit readback, retained maximum exposure on uncertainty, pressure handling
and proven-drain/read-only seal disposition. No release follows lost PID or EOF.

Hosted source gates after independent review: full pinned project typecheck,
boundaries/build, explicit `tsc --noEmit -p host-integration/bounded-storage/tsconfig.json`,
and GCC `-std=c11 -O2 -Wall -Wextra -Werror -D_FILE_OFFSET_BITS=64` to a NEW
job-owned scratch build directory. No compilation in a payload, install, production
policy enablement, authentication read or local heavy gate is part of this patch.

Policy tests cover wrong Q, resume arithmetic, byte/inode representation/overflow,
standing full E floors, accessor/mutation capture and identity reuse. The separately
selected native TEST suite uses the actual helper/ledger, distinct native processes
for flock, actual full allocation/geometry/quota readback, idempotent inspection and
durable Pending after actual holder death. A NEW dedicated outer ext4 TEST volume
with the real reserve must be supplied by an independently reviewed operator; it
must differ from active shared `/srv/workers` and contain no real project. A root
0400 bounded registration file uses purpose
`NEW_TEST_storage_b1_dedicated_ext4_no_real_projects` and a RegisteredBoundedStorageHost
record. Ordinary test discovery skips this native suite. Unsupported/skipped
execution supplies no qualification evidence. Explicit operator selection uses
`vitest run --config host-integration/bounded-storage/native.vitest.config.ts`.
The suite never compiles, installs,
creates the fixture, loads modules or cleans retained images. Native EDQUOT byte
and inode reachability, tamper/alias/descendant surfaces, A FD lifetime/barrier,
live growth/crash points and rollback still require the separate real NEW TEST
qualification before any scoped writer rollout or full-B claim.
