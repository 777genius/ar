# Managed systemd launcher

Install with `sudo sh host-integration/managed-launcher/install`. The installer
copies the launcher and the shared storage-policy loader into root-owned,
non-writable directories under `/opt/subscription-runtime`.
The fixed installation path requires `/opt` and every ancestor to be root-owned
and not group/world writable. It avoids `/usr/local/lib`, which may be owned by
the deployment user on hosted machines; there is no alternative install path.
From the repository checkout, provision the policy separately with an explicit
existing external storage path (the launcher installer does not copy these
provisioning scripts):

The provisioning wrapper discovers Node.js from the administrator's `PATH`,
resolves its canonical binary and requires that binary and every parent to be
root-owned with no group/world write access. It requires Linux `readlink` and
`stat` at `/usr/bin`; Node.js need not live at `/usr/bin/node`.

```sh
sudo sh host-integration/managed-launcher/install-policy --check /mnt/runtime/jobs
sudo sh host-integration/managed-launcher/install-policy /mnt/runtime/jobs
```

Configuration contains one absolute storage root path followed by a newline. Admission requires
5 GiB and 50,000 free inodes as fixed runtime constants; installer arguments and
policy cannot override them. `--check` validates without writing. Both modes require
root on Linux and reject root-backed storage, symlinks, noncanonical paths,
nested foreign filesystems, or insufficient space. The installer reuses runtime
admission, atomically replaces `/etc/subscription-runtime/storage-root`
with root:root mode 0644 and maintains its trusted parent at mode 0755. The policy
contains no secrets and is mode 0644; only root can write it. Current Host Jobs
deployment runs new jobs in the system manager as root. Legacy records without
a manager field retain root's user-manager lifecycle operations. There is
no environment or CLI destination override. Job JSON cannot choose a policy or
writable root. Installation does not create storage or launch any jobs.

Adapters invoke the installed launcher with exactly two arguments: an operation
(`job` or `provider`) and its JSON request. `managedLauncherInvocation`
provides the same programmatic adapter. Requests contain `operation`, `unit`,
`jobId` and `payload`; jobs additionally require `fingerprint` and bounded
`limits` matching the Host Jobs contract. Provider requests may include admitted
`readonlyPaths`. No caller-provided cwd, writable paths, systemd properties, security fields,
environment overrides or output modes are accepted. The launcher constructs all
systemd flags and hardening itself. Provider resource limits are fixed in code;
I/O limits cover the root and admitted storage filesystems. Custody is a separate
trusted controller and is not an accepted launcher operation.
The launcher derives `storageRoot/jobs/jobId` with fixed `workspace`, `state`,
`logs`, `output`, `home`, `tmp` and `payload-logs` children, creating and validating each after
storage admission. Job identifiers accept letters, digits, dots, underscores
and hyphens, starting with an alphanumeric character, at most 128 characters.
Readonly auth inputs may reside outside storage. Every bind uses identical
source/destination and `norbind`.

Directory creation uses retained, validated directory descriptors through
`/proc/self/fd`, including each fixed parent, so a lost mount cannot redirect
mkdir onto the root disk.

The trusted custody controller uses its separate control-plane entrypoint;
providers created by custody still cross the managed launcher boundary.
The OpenAI HTTP bridge is disabled when `/etc/subscription-runtime/storage-root`
is present, before configuration or state creation, until managed integration
is implemented. This service ingress interlock does not grant custody authority.
It does not route or gate ordinary CLI entrypoints. Restricted SSH ingress admits
only the Host Jobs protocol and bounded operational requests, preventing remote
callers from selecting arbitrary commands. The trusted launcher provides
`SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH=1` with exact bounded
`SUBSCRIPTION_RUNTIME_JOB_ROOT` and `SUBSCRIPTION_RUNTIME_JOB_ID` values. TypeScript
derives convenience paths from that pair; it does not read policy or probe filesystems.
Neither the environment nor UID maps attest custody.
The host launcher and its kernel profile own enforcement. Missing policy
cannot silently restore legacy behavior. Nonmanaged Linux and local platforms
retain legacy operation. The per-job goal registry lives in `state/registry`;
the authoritative HostJobs lifecycle ledger is separate.

Immediately before launch the shared admission checks the external filesystem,
capacity, canonical paths and mount identity. The wrapper adds
`ProtectSystem=strict` and `ReadWritePaths` for the entire external job root,
private 256 MiB `/tmp` and 64 MiB `/var/tmp`, `NoNewPrivileges=yes`,
`MemorySwapMax=0`, `LimitCORE=0` and a policy-derived `RequiresMountsFor`.
These require the supported systemd 255 hosts;
the Linux canary must verify effective enforcement.
The host must provide `/usr/bin/tini` (the distribution's `tini` package). The
installer checks that it is executable and that it and every ancestor are
root-owned, non-symlink and not group/world writable before changing installed
files. Launch admission also verifies Tini with the trusted bootstrap files.
Tini runs as namespace PID 1 after `setpriv` drops capabilities and before Node,
reaping orphaned descendants and forwarding signals to the payload guard.
Systemd retains `KillMode=control-group` for whole-unit teardown.

The installed payload guard checks the current job device, canonical paths and scoped mounts once inside the completed
service mount namespace before starting the original command, closing the
pre-launch mount-loss gap. It inherits stdio and forwards termination signals.
No relaxed retry is permitted if systemd cannot enforce these properties. The
system manager must support filesystem namespaces; otherwise launch fails
closed. After user-namespace setup the payload sees UID/GID 65532, mapped to the
root manager's host identity so existing file ownership remains compatible.
Bootstraps that require gaining privileges are incompatible and must be
provisioned with their required identity before entering this boundary. The
current `unshare --map-user/--map-group --keep-caps` then `setpriv --no-new-privs`
bootstrap does not depend on acquiring privileges through setuid execution:
`NoNewPrivileges` retains existing capabilities and permits user namespaces.
`ProtectKernelTunables` and `ProtectKernelLogs` are intentionally omitted because
systemd implements them with locked submounts below `/proc`, which prevents the
child user namespace from mounting its private procfs. The payload has no host
PID view and drops every capability before executing untrusted code; private
devices and explicit inaccessible paths retain the relevant protection.
Compatibility still requires a disposable Linux host canary; argument tests do
not prove kernel namespace behavior.

This is a mandatory application launch boundary, not a host authorization
mechanism: host administrator privileges can still invoke systemd directly.
It confines persistent writes to the external job root. Job state, logs and
outputs have no payload-integrity guarantee: the goal CLI and runner must write
them. The authoritative bounded HostJobs lifecycle ledger remains outside the
job root. It does not hide readable host files. Existing
read-only custody controls remain necessary for confidentiality and authority.

Operations validate unit identity and exact command shape.
New Host Jobs payloads require the system manager. Jobs and providers use a
fixed unshare PID namespace with private procfs and setpriv bootstrap; its three
temporary capabilities are dropped before payload execution. Payloads lose host
devices, kernel mutation interfaces and systemd/D-Bus/Docker/containerd/Podman
sockets. Outer/ordinary custody remains outside this launcher, using its separate
trusted control-plane entry point. Trusted Node/bootstrap files and every
ancestor must be root-owned, non-symlink and not group/world writable. Install
the runtime and its dependencies as trusted host code before using these profiles.

Jobs write stdout/stderr to `storageRoot/jobs/<jobId>/payload-logs/<unit>.stdout.log` and
`<unit>.stderr.log`. After final admission the payload guard opens private,
root-owned, single-link regular files with NOFOLLOW, checks the external device,
and passes those exact descriptors to the payload. Systemd streams are null;
systemd never reopens writable log paths. Providers retain inherited pipes/sockets;
inherited regular output descriptors must be on the admitted external device.
Unit identities cannot contain path separators. Trusted payload code must live
outside writable storage.

Run focused tests with
`node --test host-integration/managed-launcher/*.node-test.mjs`.
These tests use synthetic arguments and injected admission only; they never
launch systemd or touch real projects.

On a disposable Linux test host only, the opt-in integration harness exercises
the installed wrapper and real systemd confinement:

```sh
sudo node host-integration/managed-launcher/e2e.mjs --allow-live-synthetic --external-root /mnt/test-volume/disposable --expected-machine-id TEST_HOST_MACHINE_ID --goal-cli /opt/subscription-runtime/dist/worker-codex/codex-goal-cli.js --provider-launcher /opt/subscription-runtime/dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js
```

Restricted SSH ingress is tested separately by the Host Jobs transport tests.
The launcher harness verifies kernel confinement without maintaining an
inventory of public CLI gates.

The supplied directory must already exist on a filesystem distinct from `/`,
strictly below the deployed policy's storage root and on the same device.
The harness creates its own randomized job layout under `storageRoot/jobs` and uses no projects or
credentials. It requires the installed root-owned wrapper and an existing
root-owned policy file, which is read and validated without modification so the
launcher and its final namespace guard observe the same policy. It checks actual
writes, bounded tmpfs mounts, and effective systemd properties including zero
swap, then stops its exact randomized unit before removing its files. If stop
cannot be confirmed, files are preserved and cleanup fails explicitly.
The system manager must be running and support the enforced namespaces. The
harness fails closed if it cannot launch the HostJobs profile. It also checks
zero effective/bounding capabilities, hidden control sockets, absence of block
devices, denied mounts, and external stdout/stderr logs. Only its exact log
files are removed; a newly created empty log directory is removed if possible.

The required `--goal-cli` names the built, root-owned runtime installed outside
writable storage. The payload invokes its real `run` and `status` commands against
only the randomized synthetic job. A fake Codex executable consumes the real
runner's stdin and emits a deterministic JSONL completion; fake ChatGPT-shaped
tokens exist only in the new external HOME. It asserts completed progress,
result text, events, encryption state, registry, and provider HOME/temp writes.
No real provider, account, or project is used.
The harness also asserts UID/GID 65532, the external HOME, denied writes through
workspace and HOME symlinks to the root-backed sentinel, and absence of a
root-backed descriptor deliberately inherited by the outer launcher.
Mount-fault subtests create child mount namespaces with private propagation,
bind an empty root-backed directory over storage or below a synthetic workspace,
and assert both installed wrapper admission and final namespace admission reject
the fault without writing to that directory. Shared mounts and deployed policy
are never renamed or unmounted. The required trusted `--provider-launcher`
executes a synthetic launch frame and verifies stdin/stdout/stderr through the
real managed provider profile. Every exact randomized provider/fault unit is
stopped before cleanup; an uncertain stop preserves the files.

The success record is scoped to `job-confinement-and-synthetic-goal-runner` and
includes missing/untrusted policy rejection inside disposable private mount
namespaces. It never renames the deployed policy or changes a shared mount.
Release acceptance still needs a custody canary through its separate
control-plane entrypoint and legacy status/stop using exclusively synthetic
lifecycle records. Stopping this harness's systemd unit is cleanup, not evidence
for the legacy stop API.

The positive custody check is the disposable systemd-nspawn guest documented in
`host-integration/custody-canary/README.md`; it never mounts shared host custody
state, credentials, jobs, projects, or databases into the guest.

The separate `host-integration/host-jobs/legacy-lifecycle-e2e.mjs` harness checks
both an admitted system service and a harmless user service whose synthetic
ledger omits the manager field. Root's user manager must also be reachable
(normally `XDG_RUNTIME_DIR=/run/user/0`); Host Jobs checks both scopes for collisions
before new starts. Each lifecycle check uses only its owned randomized unit.

Do not interpret the focused argument tests or this harness's success record
as evidence that those additional scenarios passed.
