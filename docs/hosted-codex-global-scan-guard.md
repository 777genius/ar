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

The host-owned Codex `PreToolUse` hook installed inside each hosted job's
isolated `CODEX_HOME` rejects ordinary accidental broad scans before they
start. Codex invokes it before ordinary shell commands and before the top-level
code-mode `exec` call. For code mode it extracts static
`tools.exec_command({cmd: ...})` values. PATH wrappers provide the same stable
diagnostic when a guarded executable is reached directly.

Code-mode `cmd` values must be static string literals. Computed commands fail
closed with `subscription_runtime_dynamic_command_blocked`, because their final
filesystem scope cannot be proven before the nested tool runs.

Shell executable and scan-root parameter expansions that the policy recognizes
also fail closed when their value cannot be proven before execution. The
host-owned
`SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_{FIND,RG,GREP}_REAL` executable
references remain supported because the guard maps those exact references to a
known tool; arbitrary variables and command substitutions are not trusted for
executable or scan-root selection.

The runtime enables hooks only for processes marked
`SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job`, writes the versioned hook
into that job's generated `config.toml`, and starts app-server with
`--dangerously-bypass-hook-trust` only for that immutable host-owned
configuration.

The command recognizer is intentionally not an adversarial shell or JavaScript
security boundary. Hosted Linux app-server process trees also run as transient
systemd services inside `subscription-runtime-hosted.slice`, with aggregate and
per-job CPU, bandwidth, IOPS, memory, and task ceilings. The service makes the
cgroup tree read-only and starts a trusted util-linux boundary that creates a
private PID namespace with a fresh `/proc`. Before Node or Codex starts,
`setpriv` clears the complete child capability bounding, inheritable, and
ambient sets. Direct host buses remain hidden, and host process-root aliases
cannot re-open them. The host filesystem is not chrooted or rebound, so the
Codex provider still owns its repository sandbox.
This containment is the host-availability
boundary when command construction, shell expansion, a different executable
path, or nested execution bypasses the early diagnostic. It throttles the
worker tree rather than production services, so a missed scan shape cannot
consume the whole host or move itself outside the bounded slice.

Hosted jobs fail closed when an execution engine cannot load the trusted hook.
The guarded runtime currently permits `app-server` and `app-server-goal`; an
explicit `packaged-exec` or `plain-exec` selection is rejected with
`file_backend_codex_hosted_scan_guard_engine_invalid` instead of silently
running with partial protection.

The bounded-workspace MCP profile is the exception: it exposes no native shell
or code-mode exec surface, accepts only workspace-relative paths, and therefore
does not enable or bypass-trust for this shell hook.

```text
find /var/data
/usr/bin/rg --files /
grep -R needle /tmp
```

Every launcher layer uses `exec` and inherits stdin/stdout/stderr unchanged. Codex
therefore owns the only provider sandbox; a second outer mount namespace is
deliberately forbidden because it prevents the Codex sandbox from launching
ordinary repository-bounded commands on production kernels.

The guard does not modify host `/usr/bin`, an administrator's PATH, production
container entrypoints, existing processes, or any project. The launcher admits
only processes marked `SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job`.

## Deployable host entrypoint integration

Install the versioned `global-scan-guard` directory read-only, preserving file
modes. GNU Bash, util-linux `unshare`/`setpriv`, and executable host copies of
find, ripgrep, grep, and Codex are prerequisites. For example, install the
package directory at:

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
guarded Codex entrypoint. That entrypoint starts the configured real Codex binary
without nesting its provider sandbox.

If a host resolves a different executable path for a tool, configure its exact
absolute source:

```sh
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_SOURCE=/host/path/find
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_SOURCE=/host/path/rg
SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_SOURCE=/host/path/grep
```

The launcher fails closed rather than silently omitting a configured source.
Keep all source overrides scoped to this hosted-job entrypoint. Missing,
relative, or guard-recursive source configurations fail closed.

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

Build the release, then install the shipped aggregate slice before enabling the
hosted marker. The installer discovers every writable block device from the
host mount table and generates hard aggregate bandwidth and IOPS ceilings for
each one:

```sh
SUBSCRIPTION_RUNTIME_REPOSITORY_ROOT=/opt/subscription-runtime/repo \
  /opt/subscription-runtime/global-scan-guard/install-subscription-runtime-hosted-slice
```

Each marked hosted app-server is then started as a transient service under this
slice. Its cwd, arguments, and full environment are delivered through a private
stdin launch frame, so tokens never enter the `systemd-run` command line. The
launcher consumes only that first frame and forwards all remaining bytes as the
normal app-server protocol. Existing process trees are not moved or restarted;
the limits apply to newly started hosted jobs.

## Verification

The focused suite delegates only to disposable fake executables and uses
disposable directories. It covers argument roles, all forbidden roots, lexical
normalization, direct mount roots, allowed deeper descendants, benign patterns,
clustered recursive grep flags, the stable exit contract, fail-closed
prerequisites, nested-sandbox avoidance, host `--codex-binary codex` resolution,
launch-frame validation, mount-device coverage, and app-server stdio
passthrough.

```sh
npm run test:global-scan-guard
```

Do not test this adapter against a real user project or by changing host-wide
tools.
