# Backend Workers

Backend services should keep queues and HTTP framework choices outside the
runtime package. The runtime provides worker pools and provider execution; host
apps decide whether to use BullMQ, Nest queues, direct calls, or another queue.

Recommended first deployment shape:

- one persistent volume for `/var/lib/subscription-runtime`;
- one encrypted file key in env;
- one Redis-backed queue;
- N Codex worker slots with prewarm enabled;
- async job API plus optional sync wait endpoint.

## Local Storage Guarantees

Use this initial deployment on one host and in one PID namespace. Processes that
share a provider instance must use the same canonical local `stateRootDir` and
encryption key. On Linux, their readable procfs must describe that PID namespace;
separate container PID namespaces cannot share this local coordination authority.
The local backend coordinates compare-and-swap writes and lease ownership in
that state root. The standalone encrypted store provides generation checks;
use `createLocalFileBackendRuntimeAdapters` to compose it with lease fencing.
Reusing an idempotency key requires the same write intent.

A lease prevents a superseded owner from starting a new writeback. It does not
cancel an already running provider request or undo a remote token rotation.
Size the lease lifetime for the provider operation and handle loss of ownership
through the runtime's failure and recovery path. A durable receipt can confirm a
previously completed write after its acknowledgment was lost.

For upgrades from the original local record format, an exact current-generation
retry can migrate its receipt when the stored artifact, generation, lease and
effective metadata establish the original intent. Older historical receipts
without that evidence fail with `local_store_legacy_idempotency_unverifiable`.
Handle that result through reconciliation; do not blindly retry it with a fresh
idempotency key. On Linux, a missing PID or changed process birth proves an owner
exited only when its recorded boot and PID namespace match the caller's readable
identity. A complete, valid identity from a different boot also proves the owner
exited under this single-host contract, preserving recovery after a host reboot.
Missing, malformed, unreadable, or same-boot foreign namespace identities fail
closed, including legacy lock records without PID namespace evidence.

For this storage upgrade, drain active operations and stop all processes that
can write sessions or own leases in the shared state root before restarting
them on the new version. Mixed old and new binaries do not share the revised
cleanup mutex. Removing lock files while an owner is running can break mutual
exclusion.

If legacy or unknown-identity locks block the offline upgrade, first verify that
**all writers and lease owners are stopped**, including containers and services
sharing the store. Inspect the affected store's `leases/locks` directory and move
only the identified legacy or unknown-identity provider/cleanup lock records to
a quarantine directory outside `leases/locks`. Retain them for diagnosis. Do not
move encrypted session files, lease records, or active-lease records. Then restart
the new version in the shared PID namespace. A recorded PID or an `ESRCH` result
alone is not sufficient evidence for this maintenance step. Same-boot locks from
another namespace require the same offline handling; they are never silently
deleted or trusted by the recovery path.

These are same-host, process-concurrency guarantees. They do not certify NFS,
SMB, multiple hosts, arbitrary direct edits to stored files, or persistence
through a power failure. Keep the state root private to its owner. Before
multi-host deployment, supply storage and lease adapters with transactional CAS
and fencing in the shared authority, and run the adapter contracts against the
real backing service. A shared Redis/BullMQ queue distributes jobs; it does not
replace the session, capacity, lease or run-state stores.

For backend differences and goal support, see
[Provider Capabilities](provider-capabilities.md).

Run account diagnostics before scheduling large batches:

```bash
subscription-runtime-account-status --provider all --json
```

The command reads cached `WorkerAccountCapacityStore` state by default and only
runs provider probes when `--probe` is passed. Use this for relogin alerts,
limit reset visibility and duplicate account-slot detection. See
`docs/account-diagnostics.md`.

Claude Code workers use the same backend-worker shape through
`FileBackendClaudeWorker`. The worker exposes capacity snapshots, rate-limit
telemetry, control-inbox continuation and logical thread handoff. See
`docs/claude-worker-pool-rfc.md` for the original design background; the
`worker-claude` public subpath and source are the current API reference.

For an operational Codex worker-pool runbook, including native `/goal`,
account-slot login, worktree isolation, monitoring commands and restart policy,
see `docs/codex-worker-pool-operations.md`.
