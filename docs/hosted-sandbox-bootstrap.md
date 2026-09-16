# Hosted Codex sandbox bootstrap

The hosted Linux launcher keeps systemd resource limits, a private PID/proc
namespace, inaccessible control sockets, `NoNewPrivileges`, and Codex's own
filesystem/network sandbox. These controls must not be disabled to fix a launch.

## Why root with dropped capabilities failed

The original launcher dropped all capabilities while keeping namespace UID 0.
Bubblewrap then attempted another user namespace. Linux 5.12+ restricts mapping
parent UID 0 without `CAP_SETFCAP`; the nested UID-map write failed with
`bwrap: setting up uid map: Operation not permitted`.

Changing Codex accounts cannot fix that failure. A successful direct bubblewrap
command under unrestricted host root does not validate the hosted launch path.

## Bootstrap boundary

1. The trusted systemd bootstrap has only the capabilities needed for namespace
   setup: `CAP_SYS_ADMIN`, `CAP_SETPCAP`, and `CAP_SETFCAP`.
2. `unshare` maps the caller to namespace-local UID/GID 65532, creates the private
   PID/mount namespace, and retains namespace capabilities only for `setpriv`.
3. `setpriv` clears bounding, inheritable and ambient capability sets and sets
   no-new-privileges. Executing Node under the nonzero namespace identity also
   clears effective and permitted capabilities.
4. Node/Codex and its commands therefore run without Linux capabilities. The
   nonzero parent namespace identity permits the nested bubblewrap sandbox.

65532 is not the Linux overflow identity 65534, so unmapped owners are not
confused with the current namespace identity. This does not create a Unix user,
change host file ownership, copy credentials to a different owner, or grant
another host account access to a workspace. Host ownership stays unchanged.

## Qualification

Pure tests bind the exact launcher order and the systemd properties. A hosted
qualification must additionally use a disposable fixture and the actual generated
invocation to prove nested sandbox execution, namespace UID/GID 65532, zero
`CapInh`/`CapPrm`/`CapEff`/`CapBnd`/`CapAmb`, and `NoNewPrivs: 1`.
It must exercise an allowed workspace write and rejection of an out-of-workspace
write before claiming writer readiness. No real consumer runtime or agent flow
is a suitable qualification fixture.

This is a Linux hosted-adapter fix only. Unmarked local processes and macOS/
Windows invocation behavior are unchanged. It does not qualify unrelated
Runtime hardening, or change consumer architecture/package semantics.
