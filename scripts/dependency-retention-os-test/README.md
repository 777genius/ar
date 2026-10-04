# Owned native OS TEST fixture

Disposable GitHub Ubuntu 24.04 workflow, triggered manually or by a pull request
changing this fixture or its production dependency boundaries. Do not execute on a user
machine, production worker, configured pool, or real project. Source review and
remote typecheck/native execution are required before claiming any passing result.

The fixture extracts Ubuntu packages authenticated by the archive signing key
and SHA256/size from the signed apt index. It does not configure packages or run
maintainer scripts. Apt state/cache/logs, guest root, machine identity, units,
source artifacts and TEST projects are freshly owned. One outer systemd service
delegates its subtree to nspawn; no runner services are masked/stopped and no
outer root/account/bus/checkout directory is mounted into the guest.

Assembly independently discovers the pinned Node ELF SONAMEs and adds only their
fixed supported distro packages from authenticated indexes. Unknown requirements
fail closed. A bounded preboot chroot `node --version` runs that exact copied
binary in the new root before any job/auth fixture or OS launch. Its fixed setup
classifications are retained; no host library directory is copied or mounted.
The builtin-only supervisor writes a startup marker, then records an early
qualification-child exit without raw stdout/stderr. Missing startup fails within
90 seconds instead of silently waiting through the whole qualification budget.

The guest disables OS-layer user remapping so the unchanged initial-UID-map
guard can run, while keeping private PID/mount/cgroup views. Its unit search
path contains only an owned minimal target and permanent supervisor. Unknown
services, scopes, sockets, timers, queued jobs and cgroup writers fail the
actual production inventory gate. This shares the runner kernel and requires
mount/user namespace capability plus actual CPU/memory/pids delegation.
Unsupported kernel/manager/capability behavior fails the job; it never fabricates
positive authority. If unavailable, use the separately designed QEMU fallback.

The already-required TEST supervisor is enabled by one root-owned guest runtime
target-wants link. The actual filtered unit-file query must report exactly that
unit as enabled-runtime. This keeps systemd v255's empty-list ENOENT behavior from
rejecting the minimal fixture while retaining the unchanged finite inventory gate.
It creates no extra unit or process and does not reload or stop the manager.

An initial inventory rejection retains only fixed production throw locations
and bounded read-only TEST observations of the supervisor, manager queues,
future unit inventory and cgroup PID predicates. Diagnostics run after rejection,
never delay the production check, and never authorize a retry or installation.
Unknown unit/group names are digested; raw process names, paths and logs are not
exported. These observations cannot substitute for the unchanged production gate.

The qualification child has three actual pipes and remains in the supervisor's
cgroup. It issues only independent TEST inventory/stage/profile input, then calls
the real installation store, TEST npm grant writer, ordinary enrollment/resume,
pinned goal CLI foreground launcher, final dependency admission, installer,
provider RootDirectory/user namespace/setpriv/Tini and creator/drain release.
The app-server protocol is wholly synthetic: one inert fixed invalid account
fixture satisfies structural validation, all supported protocol replies are
local, refresh/login/exec and unexpected methods fail. No real authentication,
account pool, provider request or credential bytes are accessed.

The actual provider process observes UID/EUID/GID/EGID 65532, exact UID/GID map,
and different actual PID/mount/user namespace IDs from the trusted guest baseline,
zero capability sets, NoNewPrivs, dependency reads, readonly `.git` and denied
key/state/output/privileged-sibling paths. Parent verification requires production
Ready, released owner, unchanged sentinels/Git HEAD and exactly one installer for
fresh then hot entry. Regressions in initial inventory coverage, provider UID,
mount isolation, owner release or hot reuse make the workflow fail.

Successful evidence is **partial native fresh/hot with synthetic provider**.
Eviction/committed Absent/cold restore, failure/duplicate/late admission cases,
bare-metal host coverage and live account/provider acceptance remain unsupported.
No fixture removes production Ready, mints Absent or writes creator/drain/owner
completion records. Uncertain state remains in its owned root until VM disposal;
only the exact registered outer unit may be stopped after identity checks.

Installer network inputs are the exact three bounded regular guest OS files.
The issuer pins their SHA256 in immutable private root-owned snapshots, then the
production recipe revalidates/copies those fixed inputs. It never changes DNS
ownership or permissions or exposes the OS networking directory to the installer.
The final bounded artifact retains signed-index/package hashes and versions,
owned launch registration, namespace observations and toolchain/network pins.
Actual npm UID/GID before normalization remains a required separate primitive
gate on this exact source SHA; this fixture independently observes provider IDs.
The issuer requires the production NumericUidDropV2 recipe and independently
pins `/usr/bin/setpriv` bytes, exact version and actual library closure before
launch. The guest has no UID/GID 65532 NSS entry; numeric privilege dropping must
work without creating a host or guest installer account.
