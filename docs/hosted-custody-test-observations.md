# Bounded custody observations (TEST)

`worker-codex` has one private parser for boot ID, process birth, exact systemd
unit and ControlGroup, queued jobs, and `cgroup.events`. The production
`HostedReadonlyHostKernel` retains its fixed host paths, operator guard,
inventory, reservation and completion fences, mutex and decisions. The parser
reports OS facts only. It cannot authorize a creator, discharge a lease, stop a
unit, launch work, or publish an epoch.

The TEST helper in `src/worker-codex/tests/fixtures/hosted-custody-test-observer.ts`
reads only `identity.json` and `observations.json` in one owner-private
`/tmp/test-custody-observer-*` directory. It writes one exclusive
`observation-evidence.json` there. The identity envelope fixes a start ID,
boot ID and PID birth; the observer derives the only permitted unit and cgroup.
The directory must be owned by the invoking uid and inaccessible to group or
other users. Inputs must be regular, singly linked, uid-owned files; symlinks
are refused and each input is capped at 64 KiB. This protects the synthetic
fixture boundary, not host authority.
There is no unit, cgroup, OS root or authority path override in either input.
The observations must agree with that envelope, contain no queued start, show
`MainPID=0`, and include exactly one `populated 0` event. Missing events cannot
prove terminal descendants in TEST. Production's existing post-creator-and-queue
fenced absent-cgroup behavior remains separate.

The two finite input records have these fields (no extras):

| File | Fields | Meaning |
| --- | --- | --- |
| `identity.json` | `startId`, `bootId`, `pid`, `processBirth` | Operator-supplied TEST envelope; `processBirth` has `pid:kernel-start-ticks` form. |
| `observations.json` | `bootId`, `processStat`, `unitShow`, `jobs`, `cgroupEvents` | Synthetic snapshots in the same text formats as `/proc/PID/stat`, `systemctl show`, `list-jobs`, and `cgroup.events`. |

`unitShow` must have exactly the five expected show keys once each, including
the ID and ControlGroup derived from `startId`. The observer rejects foreign
jobs as well as a queued job for its own unit, since this TEST snapshot describes
only one finite unit. It checks the process birth ticks against the envelope;
it does not infer a PID's ownership from those ticks. A rejected input creates
no output. A successful run creates the evidence name once with exclusive file
creation, so an existing record cannot be overwritten silently.

All TEST inputs, including the identity envelope, are operator supplied. The
output is **synthetic observation evidence**, never an authenticated production
custody receipt or proof that a real launcher owned the process. A path under
the TEST prefix, including a bind-mounted view, does not convert it into live
proof. The envelope is sufficient for synthetic consistency checks only.
Real disposable systemd qualification is **NO-GO** until a separately reviewed
trusted launcher and host authority provide independent ownership evidence;
this helper must not be expanded to supply one. Cleanup of the disposable
directory belongs to the test orchestrator.

This is a private fixed dependency within the existing feature. The reviewed
Consumer Module Standard reference remains `6b31f20fe3e5fb8324812aa2ee907905751cde71`
(complete-document SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`).
There is no accepted Assembly adoption pin for this consumer.
