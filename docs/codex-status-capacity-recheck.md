# Scheduled account capacity refresh

`codex_accounts_status` and job-scoped `codex_goal_accounts_status` accept
`recheckDueCapacity: true`. The option defaults to false and is echoed as a
boolean in the response, allowing consumers to reject older transports that
silently ignore the input option.

Use it before scheduled account selection, keeping `liveCheck: false`:

```json
{
  "jobId": "example-scheduled-job",
  "registryRootDir": "/path/to/project/registry",
  "liveCheck": false,
  "recheckDueCapacity": true,
  "liveCheckTimeoutMs": 10000
}
```

This opts into the existing shared capacity-store rechecker, not a new polling
loop. Only states whose quota/cooldown has expired are claimed and rechecked.
Future limits remain blocked; concurrent callers share the existing claim.
Quota observation uses App Server account/quota reads without an exec probe.
Failed or inconclusive observations remain ineligible with bounded retry state.
The job-scoped tool checks only its configured accounts.

The acknowledgement means the due-only pass was requested and completed, not
that every account was refreshed or became available. Select accounts from
`availableDedupedAccountNames` and inspect the per-account capacity reason.
`liveCheckTimeoutMs` bounds individual startup/RPC operations, not the duration
of an arbitrarily large pool. Consumers must retain their overall deadline and
existing fail-closed or independently validated fallback policy.
