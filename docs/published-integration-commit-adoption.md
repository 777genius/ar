# Externally published reviewed commit recovery

`codex_goal_project_adopt_published_integration_commit` is a host admin recovery
operation for a non-merge integration attempt stranded in `checks_passed` after
the owner published the exact reviewed output outside this runtime. It is not a
normal integration route. The tool does not push, reject, quarantine, or rewrite
any Git ref.

The runtime has no GitHub credentials. An operator must use an authenticated
`gh api` session outside the runtime to observe the exact repository branch ref
and commit. The operator must retain the raw API evidence, compute its SHA-256,
and create a root-owned `0600` JSON permit on the runtime host. The runtime
labels remote provenance as `operator_attestation`; it never claims an
independent remote check. The permit has this shape:

```json
{
  "schemaVersion": 1,
  "controllerJobId": "...",
  "attemptId": "...",
  "commitSha": "40 lowercase hex digits",
  "message": "fix(scope): exact commit message",
  "attestation": {
    "provenance": "operator_attestation",
    "operator": "iliya",
    "verifiedAt": "2026-09-28T12:00:00.000Z",
    "verificationMethod": "authenticated_gh_api",
    "repository": "owner/repository",
    "remote": "origin",
    "branch": "main",
    "commitSha": "same 40 lowercase hex digits",
    "evidenceSha256": "SHA-256 of retained raw authenticated API evidence"
  }
}
```

Call the tool with `permitFile`, `expectedPermitSha256` (hash of the whole
permit), the exact controller/attempt/commit/message fields, and
`confirmAdoption: true`. The authenticated branch observation must be at most
30 minutes old when adoption first starts. Preview without confirmation reports the required
confirmation and does not read the permit. The permit must be an absolute,
regular, non-symlink file owned by root with mode `0600`; the MCP process must
run as root. Keep permit and raw API evidence in the operator's protected audit
custody, outside agent writable workspaces.

The commit object must already be locally inspectable in the target repository.
If the runtime cannot fetch the GitHub remote, transfer a Git bundle from the
operator's authenticated checkout and import the exact object before calling
the tool. Do not update the target branch or worktree during object import.

Before any ledger mutation, the operation revalidates the reviewed output
identity, persisted passing checks, checked tree reconstructed from the frozen
patch, exact Git commit tree/parent/files/message/author/committer, clean target
workspace, configured GitHub repository, and secret scan on immutable tree
blobs. It writes a `commit_created` recovery candidate, then prepares and
finalizes the consumed-output ledger before recording `pushed`. Repeating the
same permit completes an interrupted ledger/status/audit phase once the immutable
preparation exists. An adoption-only immutable capture also recovers a crash
between archive files and preparation, without recapturing mutable worker status.
The normal eight-field preparation format is unchanged. Missing preparation
after a terminal status fails closed. A different
attestation or object fails closed.

This path currently supports one-parent, non-merge reviewed output with a
persisted file-byte allowance. It requires the target HEAD to remain at the
reviewed parent or the exact adopted commit. The operator must check that the
attested remote branch is still at the commit immediately before invocation;
remote state may change afterward and is outside the runtime's proof.
