# Hosted Codex global filesystem scan guard

The adapter in `host-integration/global-scan-guard` prevents a newly launched
hosted Codex process tree from starting `find`, `rg`, or recursive GNU `grep`
at one of these broad roots:

```text
/
/bin
/sbin
/lib
/lib64
/boot
/dev
/etc
/proc
/sys
/run
/usr
/opt
/srv
/snap
/var
/var/data
/var/lib
/var/cache
/var/tmp
/tmp
/root
/home
/mnt
/media
```

Lexically equivalent paths such as `/tmp/job/..` are treated as the same root.
The guard also rejects a direct mount root exactly one component below `/mnt`
or `/media`, such as `/mnt/volume_ams3_123`. Deeper assigned workspace and job
descendants such as `/mnt/volume_ams3_123/jobs/task` remain valid, as do searches
based on the current directory.

For GNU grep, the guard applies only when `-r`, `-R`, `--recursive`,
`--dereference-recursive`, or the equivalent `--directories=recurse` is active
and the exact forbidden root is a file operand. It understands clustered short
options and GNU option permutation. It does not reject a root-like pattern,
pattern-file argument, include/exclude value, ordinary non-recursive file
operand, or descendant path.

A rejected scan exits 64 and writes one stable
`subscription_runtime_global_scan_blocked` stderr record with the tool,
offending root, remediation, and exit code. A missing or recursive executable
configuration fails closed with exit 70 before Codex starts.

## Enforcement and process behavior

`launch-hosted-codex-job` creates a Bubblewrap mount namespace for the complete
Codex process tree. Inside that namespace it both prepends the guarded tool
directory to `PATH` and read-only bind mounts the entrypoints over:

```text
/usr/bin/find
/usr/bin/rg
/usr/bin/grep
```

The real executables are mounted at private namespace paths used only for guard
delegation. The inert mount-target files shipped in `private/` are deliberately
not executable on the host. A PATH-only deployment is not supported.

Every launcher layer uses `exec`, inherits stdin/stdout/stderr unchanged, and
does not request Bubblewrap's `--new-session`. Codex app-server therefore keeps
its stdio transport and the detached process group established by the runtime;
the runtime's existing group-signal cleanup still targets the whole job.
Bubblewrap's `--die-with-parent` also ensures that losing the host runtime
terminates the namespaced job.

The mount namespace is per newly launched Codex process. It does not modify
host `/usr/bin`, an administrator's PATH, production container entrypoints,
existing processes, or any project. The launcher admits only processes marked
`SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job`.

## Deployable host entrypoint integration

Install the versioned `global-scan-guard` directory read-only, preserving file
modes. Bubblewrap, GNU Bash, and executable host copies of find, ripgrep, grep,
and Codex are prerequisites. For example, install the package directory at:

```text
/opt/subscription-runtime/global-scan-guard
```

Configure only the **new hosted Codex job** entrypoint to execute the shipped
host adapter. Supply the real Codex executable as an absolute path:

```sh
exec env \
  SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job \
  SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE=/opt/codex/bin/codex \
  /opt/subscription-runtime/global-scan-guard/launch-hosted-subscription-runtime-job \
  /usr/local/bin/subscription-runtime-run-agent-runtime-task \
  --provider codex \
  --codex-binary codex \
  --input /path/to/disposable-job/request.json \
  --state-root /path/to/disposable-job/state
```

The host adapter prepends only `codex-bin/` to that one job's PATH and then
executes the normal subscription-runtime entrypoint. Consequently both the
runtime default `codex` and an explicit `--codex-binary codex` resolve to the
guarded Codex entrypoint. That entrypoint, in turn, enters the mount namespace
before starting the configured real Codex binary. The host subscription-runtime
process itself remains outside the namespace; Codex and all of its descendants
are inside it.

If a host already resolves a different executable path for a tool, configure
its exact absolute source without changing the canonical interception targets:

```sh
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_SOURCE=/host/path/find
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_SOURCE=/host/path/rg
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_SOURCE=/host/path/grep
```

The `/usr/bin/find`, `/usr/bin/rg`, and `/usr/bin/grep` targets must exist. The
launcher fails closed rather than silently omitting an interception. Keep all
source overrides scoped to this hosted-job entrypoint; the Bubblewrap override
is intended for the disposable test harness, not deployment.

Deterministic harnesses may set the corresponding
`SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_{FIND,RG,GREP}_TARGET` variables to
absolute disposable files. Their production defaults remain the canonical
`/usr/bin/find`, `/usr/bin/rg`, and `/usr/bin/grep` paths. Source executable
bindings and guard mount targets remain separate; missing, relative, or
guard-recursive configurations fail closed.

For a host integration that starts Codex directly, the guarded binary
entrypoint is also deployable on its own:

```sh
SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job \
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE=/opt/codex/bin/codex \
  /opt/subscription-runtime/global-scan-guard/codex-bin/codex app-server --listen stdio://
```

Roll out by replacing only the new hosted-job template's entrypoint. Do not
install a system-wide `codex`, `find`, `rg`, or `grep` wrapper, edit a global
shell profile, change an admin SSH command path, or restart existing jobs.

## Verification

The focused suite delegates only to disposable fake executables and uses
disposable directories. It covers argument roles, all forbidden roots, lexical
normalization, direct mount roots, allowed deeper descendants, benign patterns,
clustered recursive grep flags, the stable exit contract, fail-closed
prerequisites, the exact mount plan, host `--codex-binary codex` resolution,
direct process identity, and app-server stdio passthrough.

```sh
npm run test:global-scan-guard
```

Do not test this adapter against a real user project or by changing host-wide
tools.
