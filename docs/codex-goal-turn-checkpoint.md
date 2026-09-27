# Opt-in Codex goal turn checkpoint

The trusted `subscription-runtime-codex-goal run` process can be launched with
`--checkpoint-publisher-socket /absolute/private/publisher.sock` (or the
`SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET` operator environment
variable). The option applies only to `app-server-goal` jobs with an existing
Git HEAD. Omission preserves current behavior. The Host callback runs after
each successful app-server turn and blocks the next turn, goal completion, and
the successful terminal result until offsite acknowledgement. Failed or
uncertain turns are not replayed by this feature.
Registered jobs persist a `checkpointRequired` marker without storing the
socket path. A later launch of that job fails admission if the operator has
not supplied a publisher socket again.
Project-control child jobs inherit a required marker from their controller,
even when a refill request omits or sets `checkpointRequired: false`. The
publisher socket path remains Host supplied and is never part of an MCP child
manifest. A brokered `project_start` reads the Host setting and puts the
absolute socket path in the trusted child command; a required child launch
without that setting fails before the child process starts.

The job's private durable root receives immutable
`turn-checkpoints/identity.json` at admission, before constructing the
executor or provider, even when no turn has completed. It pins the job, task,
and initial Git HEAD. Each turn first records a durable ordinal intent, then
publishes immutable
`turn-checkpoints/000001.patch`, `000001.manifest.json`, and, only after
acknowledgement and a final state check, `000001.receipt.json`. Each subsequent
completed turn gets the next ordinal. The manifest identifies job, task,
initial HEAD, ordinal, exact patch SHA-256, changed paths, and `patch` or
`clean` state. A clean turn uses an empty patch and a `clean` manifest, which
supersedes an earlier dirty checkpoint. Restore a patch by checking out the
manifest's `initialBaseCommit` and applying the patch. Restore `clean` by
checking out that commit without applying an earlier patch. A moved HEAD fails
closed; local commits are not represented by a patch against the new HEAD.
On relaunch, admission validates the complete local patch, manifest, and
receipt history and the pinned identity before starting the provider. File
contents and directory entries are synced before continuation is acknowledged.
Once the checkpoint root exists, later launches also require the Host publisher
setting even if a stored manifest omits the marker.
Ordinals continue from the last
acknowledged checkpoint. Partial or mismatched history requires manual review;
the runtime does not replay or overwrite a checkpoint.

The publisher protocol is HTTP over the configured Unix socket, using
`POST /v1/codex-goal-turn-checkpoints` with JSON:

```json
{
  "schemaVersion": 1,
  "manifest": "<exact UTF-8 manifest bytes>",
  "patch": "<base64 of exact patch bytes>",
  "manifestSha256": "<lowercase hex>",
  "patchSha256": "<lowercase hex>"
}
```

The publisher must durably store the exact bytes off the worker host before
returning HTTP 200 and a JSON receipt with `schemaVersion: 1`, `jobId`,
`taskId`, `turnOrdinal`, `manifestSha256`, `patchSha256`, and a nonempty
`remoteKey`. The runtime validates the receipt against the current manifest
and content hash. A rejected, missing, malformed, or mismatched receipt stops
the goal with `checkpoint_unprotected`; operators should inspect local
artifacts and offsite state before any manual recovery. The publisher owns
offsite storage credentials and retention policy; neither is passed to Codex.
The launcher must keep the socket accessible to the trusted Host process and
inaccessible to the provider sandbox.
