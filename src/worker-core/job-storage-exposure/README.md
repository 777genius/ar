# Full-Q exposure accounting

This slice implements bounded durable storage commitment policy, not qualified
kernel enforcement. It has no launch, account, provider, host-command or tool
route. Trusted composition must authenticate A lifetime authority and register
one protected control root per physical filesystem before using it.

`reserve` stores Q=sealed baseline+growth for bytes and inodes under one physical
filesystem fence. Pending, verified, active, grow-pending, unknown and sealed
generations all retain full Q. No live usage, deletion, cleanup receipt, timestamp
or process death supplies credit. Native assignment/grow happens after the
durable claim; a verified inherited quota and complete write-surface proof are
durable before opening the writer barrier. Uncertain effects require explicit
native reconciliation rather than automatic replay. Release commits only while
the trusted native generation/drain fence and quota seal remain held.

The Linux file adapter requires an existing private control directory on a
different device from the accounted filesystem. It does not accept arbitrary
worker JSON as root authority, reset a missing ledger, reuse project IDs or take
over a crashed publisher's fence by PID/TTL. A hard-crashed/uncertain file
publication stays blocked with exact lock/intent/temporary evidence retained.
Resolving that filesystem publisher requires a future authenticated native
fencing/recovery operation; there is deliberately no unsafe local force-unlock.
Normal pending/grow/unknown claim reconciliation is implemented through the
kernel port and never drops commitment.

The ledger bounds history to 4096 generations and one 4 MiB snapshot, retaining
released identities to prohibit project-ID reuse. Capacity exhaustion of that
metadata/history bound is a refusal, not automatic history GC or ID recycling.
Fresh snapshots enforce the 5 GiB scratch/root byte floor and 50k scratch inode
floor. Foreign unlimited writers keep the explicit partial-scope caveat; this
module cannot promise global no-ENOSPC.

Required integration before B acceptance:

- a trusted native capacity adapter must pin actual machine/device/UUID and read
  fresh statfs under the same registered physical filesystem fence;
- a native ext4 project-quota adapter must prove byte/inode limits, baseline,
  inheritance, project-ID custody and every writable source/home/state/output/
  temporary/cache surface, with namespaces/aliases and descendant bypass tests;
- the launcher must retain A generation authority and verify quota before its
  actual writer barrier, including exactly-once effects and current drain/seal;
- interrupted publisher recovery needs authenticated native mutation drain and
  exact durable publication resolution, not deleting old lock files;
- a per-job loop/image implementation is not selected or implicitly scalable:
  it additionally needs verified outer physical backing/metadata commitments
  (P/E), beyond this shared-filesystem full-Q arithmetic;
- controlled NEW TEST qualification must prove kernel enforcement, concurrent
  floor/commitment and crash/grow/drain contracts on exact integrated code.

`unsupportedStorageExposureKernel()` is an explicit non-success capability.
Current scratch has no quota/project feature and must not receive production
rollout from this accounting-only slice. Tests use real private persistent-store
IO; their native contract doubles prove ordering only, never Linux enforcement.
The process-exit test requires the production build and a job-owned TEST TMPDIR.
