# Host job lifecycle contract

- Production installation requires `install --ssh-public-key PATH` with one operator-supplied Ed25519 public key and always establishes restricted ingress.
- Worker SSH uses dedicated `sr-transport` UID 65531, never payload UID 65532 or admin/root credentials. Its root-owned home/key installs `restrict,command=...`; its fixed login shell ignores all command text and can invoke only the exact no-argument sudo endpoint. The root endpoint clears the environment and reads bounded JSON through the existing reader. Root/admin remains a separate trusted channel.
- Restricted ingress admits one privileged Node process with a nonblocking root-owned `flock` inode; busy requests receive a structured error without launching Node. Input has a 64 KiB limit and 10s EOF deadline. GNU `timeout` bounds the full endpoint process group to 120s with a 5s kill grace. Both absolute executables are preflighted; the lock inode is preserved across upgrades. A timed-out start must be reconciled through its original job ID, never blindly resubmitted as a new job.
- Reinstallation accepts only the exact dedicated identity, root-owned protected home/key/policy and identical key and sudoers contents. Mismatches fail before installed writes. An admin must handle key rotation and confirm sshd permits public keys, honors authorized_keys restrictions, and loads `/etc/sudoers.d` before handing out the identity. Key publication is last; interrupted installation may require admin cleanup, never an automatic destructive retry.
- Transport uses commandless SSH with no PTY and pins `sr-transport@host` for master/check/request, overriding SSH alias User settings. Input accepts host aliases only, never caller `user@host`.
- CLI accepts exactly three arguments: `host-job-cli HOST MACHINE_ID ABSOLUTE_SOCKET_DIR`. There is no fallback to an admin SSH command.

- Tests must use disposable state directories and fake SSH/systemctl only. Never launch jobs on real projects or hosts as a test.
- Requests are JSON on stdin to a fixed installed endpoint; never interpolate job data into shell commands.
- A job ID binds permanently to one request and deterministic service. An uncertain start is reconciled, never replayed as a fresh service.
- State ownership and machine identity must match before stopping anything. Never kill by PID, command substring, login session, or unknown service name.
- The current slice owns only the outer transient system service. Hosted Codex app-server detached service launch is deliberately rejected until durable provider-unit linkage is implemented.
- New records persist manager=system before launch. Missing manager fields retain legacy user-manager status/stop; unknown values fail closed. Starts check both managers for collisions. Callers cannot select the manager.
- Production prerequisites: Linux system and user systemd managers, the installer-managed `/opt/subscription-runtime/runtime/node`, installed endpoint, private local socket directory, explicit machine-id and resource budget. The user manager remains required for legacy ownership and collision checks.
