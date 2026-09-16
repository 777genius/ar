# Host job lifecycle

The opt-in `scripts/ops/host-job-transport.mjs` client exposes `hostTransport({host, machineId, socketDir}).request(request)`.
The executable entrypoint is `node scripts/ops/host-job-cli.mjs HOST MACHINE_ID ABSOLUTE_SOCKET_DIR < request.json`. It accepts exactly three arguments, supplies the configured machine identity to the JSON stdin request, rejects conflicting identities, pins the remote user to `sr-transport`, and prints the structured result. Keep the socket directory private; no credentials belong in requests.
Install the fixed endpoint with
`sh host-integration/host-jobs/install --ssh-public-key /absolute/path/to/key.pub`
on an explicitly approved Linux host. This also installs its required managed
launcher and a dedicated `sr-transport` SSH identity. Host clients pass an SSH
alias without a username; the transport pins `sr-transport@<alias>` and sends
bounded JSON only on stdin. Administrative SSH remains a separate trusted
channel. Installation requires the public key and always establishes restricted
ingress. Tests use disposable fixtures for installer checks and never launch live jobs.

SSH executes no caller-selected remote command. The root-owned
forced login shell invokes the exact privileged endpoint, which clears its
environment, admits one request at a time, requires stdin EOF within 10 seconds
and bounds the endpoint process to 120 seconds. The installer validates an
existing fixed Node executable or creates a root-owned symlink to the canonical
installed Node binary. Runtime executables, copied source staging and their
ancestor directories must be root-owned and not group/world writable. Invalid
paths fail before installation writes. Callers cannot override the executable
or endpoint; requests remain bounded JSON on stdin.

Start requests contain `operation: "start"`, `jobId`, exact 32-character `machineId`, absolute `argv[0]`, and integer `runtimeSeconds`, `stopSeconds`, `memoryMiB`, `tasksMax`, `cpuPercent`. Caller `cwd` and unknown fields are rejected. New IDs match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`; legacy IDs remain supported for status/stop. Status and stop requests contain `operation`, `jobId`, and `machineId`. The endpoint runs as root and new jobs use the system systemd manager. New records persist `manager: "system"` before launch; records without a manager retain root's user-manager status/stop. Unknown manager values fail closed and callers cannot select a manager. Both managers must be reachable for collision checks before new starts. The payload enters a private PID/user namespace and sees UID/GID 65532, mapped to the host root identity for compatible file ownership.

The client caches one multiplex transport per host/machine identity. A private socket-directory lock serializes all calls across independent CLI processes, including master creation; this conservative first slice therefore runs only one short command per host. All callers for a host identity must use the same private socket directory. Queue waits are bounded to 30 seconds. Lock ownership records include PID and process start time; stale or ambiguous locks fail closed for operator reconciliation, never automatic takeover while a job result could be uncertain. SSH never silently falls back to a standalone connection. One bounded transport retry uses the identical job request.

The installed endpoint verifies machine identity; the root-owned managed launcher is the sole storage authority and reads one canonical external path from `/etc/subscription-runtime/storage-root`. Missing or invalid configuration denies new starts. The fixed runtime floor is 5 GiB and 50,000 free inodes. The file must be regular, bounded to 16 KiB, root-owned, and not group/world writable; symlink paths are rejected. No job request or task environment selects the storage root.

Admission validates the configured existing storage root before preparing `storageRoot/jobs/jobId/{workspace,state,logs,output,home,tmp}`. The derived workspace has no symlink components or nested filesystem changes. Its device must match storageRoot and differ from `/`. Admission checks available bytes and free inodes using bigint stat/statfs, accepts equality to thresholds, and rechecks directory identity after the capacity probe. Failures return compact `storage admission:` errors before payload filesystem writes or launch. The final payload guard verifies the namespace boundary.

Starts invoke the installed managed launcher through the current trusted Node runtime with a strict `job` JSON request. Host Jobs never sends `systemd-run` options and never invokes `systemd-run` directly. The launcher performs fresh storage admission, constructs all filesystem/security properties itself, and creates the service. A launcher error after the ownership record is claimed preserves the existing uncertain-start reconciliation contract; status and stop continue using the persisted deterministic unit.

Synthetic composition can inject only the bounded lifecycle service; layout creation remains exclusively inside the managed launcher. Persisted job reconciliation, status, and stop do not depend on policy availability or disk capacity. Every transient `.service` has a deterministic SHA-256 name, KillMode=control-group, runtime and stop deadlines, memory/CPU/task caps. Small control records under `~/.local/state/subscription-runtime/host-jobs` are an explicit bounded trusted-metadata exception: they contain identity, fingerprint, phase and timestamp, never argv, credentials or workload output. A new start claims this record before calling the launcher so an uncertain response cannot cause duplicate execution; an admission denial therefore remains an explicit `uncertain` record for reconciliation. Existing records stay in place, allowing status/stop after external storage loss with no migration or locator scheme. Completed IDs cannot be reused. A crash between record creation and launch is reported as unresolved rather than rerunning a potentially executed job.

Status and stop also require the expected `machineId`; alias drift fails closed before unit access. Status reconciles persisted records with systemd and verifies the description fingerprint before any stop. Active units are live even after an uncertain launch response. Missing units with uncertain/starting records are unresolved; no timeout alone establishes abandonment. Unknown units are never stopped. This first slice does not scan or terminate SSH/login sessions. It does not yet own separately launched provider services: hosted Codex detached app-server launch fails closed when the host-job marker is present. Provider ownership, session monitoring and automatic orphan cleanup remain follow-up work; this adapter is not yet a replacement for hosted Codex worker provisioning.

Focused verification: `node --test host-integration/host-jobs/host-jobs.node-test.mjs host-integration/host-jobs/legacy-lifecycle-e2e.node-test.mjs`.

On an approved Linux test host, both manager scopes can be verified without the
production ledger using `node host-integration/host-jobs/legacy-lifecycle-e2e.mjs --allow-live-synthetic --expected-machine-id MACHINE_ID`.
The harness launches one admitted managed system service and one fixed harmless
user-manager sleep service, each with a randomized unit and disposable ledger.
The user record has no manager field. Both lifecycle checks poison all
storage-policy calls; only managed service setup reads policy. Both managers
must be reachable (normally `XDG_RUNTIME_DIR=/run/user/0` for root's user manager).
An uncertain stop preserves the corresponding ledger and any managed job files.
