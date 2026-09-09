# Host job lifecycle contract

- Tests must use disposable state directories and fake SSH/systemctl only. Never launch jobs on real projects or hosts as a test.
- Requests are JSON on stdin to a fixed installed endpoint; never interpolate job data into shell commands.
- A job ID binds permanently to one request and deterministic service. An uncertain start is reconciled, never replayed as a fresh service.
- State ownership and machine identity must match before stopping anything. Never kill by PID, command substring, login session, or unknown service name.
- The current slice owns only the outer transient user service. Hosted Codex app-server detached service launch is deliberately rejected until durable provider-unit linkage is implemented.
- Production prerequisites: Linux user systemd manager, /usr/bin/node, installed endpoint, private local socket directory, explicit machine-id and resource budget. Operator enables user lingering if jobs must outlive login.
