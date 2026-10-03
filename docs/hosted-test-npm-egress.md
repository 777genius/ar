# Finite hosted TEST egress

The optional `codex-test-npm-qualification` profile allows exactly
`api.openai.com`, `registry.npmjs.org`, and `tuf-repo-cdn.sigstore.dev`.
The optional `codex-test-managed-qualification` profile allows exactly those
three domains plus `api.github.com` and `raw.githubusercontent.com`, for the
published managed authority reader's current-main and exact-registry requests.
API-only remains exactly `api.openai.com`; the npm profile remains three domains.
Neither arbitrary domains, wildcards, redirects nor URL prefixes authorize hosts.
Each TEST profile applies only to Linux hosted `app-server-goal` jobs. Login, refresh,
ordinary API-only jobs, and other engines do not inherit this authorization.
This implementation has offline fixture coverage; actual npm/TUF reachability
and unrelated-host denial require the separately reviewed disposable TEST canary.

After installing the reviewed release, the host operator runs these commands
outside hosted namespaces, as host root (replace the explicit placeholders):

```sh
node /installed/subscription-runtime/host-integration/codex-test-egress.mjs grant JOB_ID /canonical/existing/job-root /canonical/existing/test-workspace
node /installed/subscription-runtime/host-integration/codex-test-egress.mjs grant-managed JOB_ID /canonical/existing/job-root /canonical/existing/test-workspace
node /installed/subscription-runtime/host-integration/codex-test-egress.mjs revoke JOB_ID
```

`grant` selects only npm; `grant-managed` selects only managed. Choose one for
the job. Both require exactly JOB ROOT WORKSPACE; `revoke` requires exactly one
nonempty JOB. Workers must never invoke these root orchestration operations.

Publication validates existing canonical directories and atomically replaces a
0600 record named `sha256(JOB_ID).json` under the fixed 0700 directory
`/run/user/0/subscription-runtime-host-policy/codex-egress`. The closed record is:

```json
{
  "schemaVersion": 1,
  "jobId": "JOB_ID",
  "jobRootDir": "/canonical/existing/job-root",
  "workspacePath": "/canonical/existing/test-workspace",
  "profileId": "codex-test-npm-qualification"
}
```

The only accepted schemaVersion 1 profile values are the two TEST IDs above;
API-only, unknown profiles and extra record keys are rejected.

There is no domain list or alternate root argument. Environment, task labels,
config files, manifests, CLI create/start flags, and MCP cannot issue grants.
The operator checks observed UID mapping and user/mount/PID namespace identities;
the forgeable hosted environment marker is not its authority.
Publication and admission walk every job-root and workspace component from `/`
downward. Each must be an existing real directory, owned by host UID0, with no
group/other write bits (including the final roots); authority additionally requires
a private 0700 leaf. Sticky writable parents such as `/tmp` are refused too.
A workspace cannot contain the job root beneath it. Symlinks, writable authority,
nonregular/hard-linked records, malformed records, and tuple mismatches refuse
launch with sanitized errors. The fixed root must be outside the job/workspace.

Ordinary non-root Linux callers return the fixed API-only policy before touching
the root-only authority tree, regardless of a spoofed profile marker. Eligible
host-root callers still refuse inaccessible, malformed, mismatched or unsafe
existing grants; only absence defaults to API-only.

The top-down custody check prevents an untrusted local actor from renaming a
checked component: rename requires write access to its already-checked parent.
It closes the intermediate-symlink race without a separate realpath race window.
An ordinary hosted command cannot rename its own workspace root because that
operation writes its parent, which is outside the command's sandbox writable
roots. This relies on host orchestration keeping the parents of both identities
outside **all** hosted writable roots, including any extra temp roots, and keeping
ownership, modes and mounts trusted through launch and execution. The adapter
does not inspect arbitrary sandbox configurations or lock out host root. A trusted
host operator must not rename, remount or relax custody while a grant is in use;
there is no claim of protection against a malicious host root operator.

Normal start/restart reads authorization once before account/session work.
The immutable effective policy reaches every account slot, config, prewarm,
resume and final process arguments. The final `--config` overrides pin the
network proxy and replace its complete finite domain table. Cache keys separate
API-only, npm and managed sessions while preserving the existing API/npm keys; generated config is rewritten on materialization.
Existing hooks, filesystem/auth restrictions, UID65532, capabilities, resources,
and systemd control-socket restrictions are retained. The existing `/run/user`
exclusion also protects the records from namespaces launched by revision 0465270.

Removal affects subsequent launches; an active launch retains its captured
policy until stopped through existing lifecycle controls. `/run` is ephemeral:
reboot removes authorization. `runner_starting` records the effective profile and
a SHA256 admission identity digest for observation only; neither grants authority.
A reviewed host release and native CI/canary remain operator responsibilities.

Managed selection has offline synthetic coverage only. Delivery owns native CI,
independent exact-source review and immutable staging. Live TEST proof must use
the unchanged SRI-verified published authority reader with real repository/Cohort
inputs and anonymous requests to both GitHub hosts. Root gh requests are not
sandbox egress proof. Preserve API/npm reader denial and unrelated-host denial;
if denial stops at the API request, do not claim separate raw-host live denial.
No browser, SSH, fixture response, credential or engine fallback is authorized.
