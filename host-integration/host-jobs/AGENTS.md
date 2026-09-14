# Host job lifecycle contract

- Tests must use disposable state directories and fake SSH/systemctl only. Never launch jobs on real projects or hosts as a test.
- Requests are JSON on stdin to a fixed installed endpoint; never interpolate job data into shell commands.
- A job ID binds permanently to one request and deterministic service. An uncertain start is reconciled, never replayed as a fresh service.
- State ownership and machine identity must match before stopping anything. Never kill by PID, command substring, login session, or unknown service name.
- The current slice owns only the outer transient system service. Hosted Codex app-server detached service launch is deliberately rejected until durable provider-unit linkage is implemented.
- New records persist manager=system before launch. Missing manager fields retain legacy user-manager status/stop; unknown values fail closed. Starts check both managers for collisions. Callers cannot select the manager.
- Production prerequisites: Linux system and user systemd managers, the installer-managed `/opt/subscription-runtime/runtime/node`, installed endpoint, private local socket directory, explicit machine-id and resource budget. The user manager remains required for legacy ownership and collision checks.
