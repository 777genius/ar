import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { request } from "node:http";
import { assertExactPatchSecretSafe, captureCodexGoalExactWorkspacePatch, type HandoffArtifactLimits } from "./codex-goal-handoff-artifacts";
import { assertSafeHandoffId } from "./codex-goal-handoff-artifact-guards";
import { handoffGitText } from "./codex-goal-handoff-git-snapshot";
import { publishImmutableTextArtifact } from "./local-immutable-text-artifact";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const receiptRemoteKey = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const checkpointFile = /^(\d{6,})\.(intent|patch|manifest\.json|receipt\.json)$/;
const identityFile = "identity.json";

export type CodexGoalTurnCheckpointManifest = {
  readonly schemaVersion: 1;
  readonly kind: "codex-goal-turn-checkpoint";
  readonly jobId: string;
  readonly taskId: string;
  readonly initialBaseCommit: string;
  readonly turnOrdinal: number;
  readonly state: "patch" | "clean";
  readonly changedPaths: readonly string[];
  readonly patchSha256: string;
};

export type CodexGoalTurnCheckpointReceipt = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly taskId: string;
  readonly turnOrdinal: number;
  readonly manifestSha256: string;
  readonly patchSha256: string;
  readonly remoteKey: string;
};

export type CodexGoalTurnCheckpointPublisher = (input: {
  readonly manifest: CodexGoalTurnCheckpointManifest;
  readonly manifestText: string;
  readonly manifestSha256: string;
  readonly patch: string;
  readonly patchPath: string;
  readonly manifestPath: string;
}) => Promise<CodexGoalTurnCheckpointReceipt>;

type CheckpointIdentity = {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly initialBaseCommit: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
};

async function privateCheckpointRoot(jobRootDir: string): Promise<string> {
  const root = join(jobRootDir, "turn-checkpoints");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Persist the job and checkpoint directory entries before acknowledging
  // the identity or any intent inside them.
  for (const directory of [dirname(jobRootDir), jobRootDir]) {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("checkpoint_private_root_invalid");
  }
  if (await realpath(root) !== root) throw new Error("checkpoint_root_symlink_invalid");
  return root;
}

async function readCheckpointFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("checkpoint_history_invalid");
    }
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content) > maxBytes || (await handle.stat()).size !== stat.size) {
      throw new Error("checkpoint_history_invalid");
    }
    return content;
  } finally {
    await handle.close();
  }
}

/** Fail closed on any partial or contradictory prior publication. Called before provider execution. */
export async function assertCodexGoalTurnCheckpointHistory(input: CheckpointIdentity): Promise<number> {
  assertSafeHandoffId(input.jobId, "checkpoint_job_id");
  assertSafeHandoffId(input.taskId, "checkpoint_task_id");
  if (!/^[0-9a-f]{40,64}$/.test(input.initialBaseCommit)) throw new Error("checkpoint_initial_base_invalid");
  const root = await privateCheckpointRoot(input.jobRootDir);
  const identityPath = join(root, identityFile);
  const names = await readdir(root);
  const identityText = `${JSON.stringify({ schemaVersion: 1, jobId: input.jobId,
    taskId: input.taskId, initialBaseCommit: input.initialBaseCommit })}\n`;
  if (!names.includes(identityFile)) {
    if (names.length !== 0) throw new Error("checkpoint_identity_missing");
    await publishImmutableTextArtifact({ path: identityPath, content: identityText,
      existingPathUnsafeError: "checkpoint_identity_unsafe",
      contentMismatchError: "checkpoint_identity_mismatch", durable: true });
  } else if (await readCheckpointFile(identityPath, 4096) !== identityText) {
    throw new Error("checkpoint_identity_mismatch");
  }
  const byOrdinal = new Map<number, Set<string>>();
  for (const name of names) {
    if (name === identityFile) continue;
    const match = checkpointFile.exec(name);
    if (!match) throw new Error("checkpoint_history_invalid");
    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || String(ordinal).padStart(6, "0") !== match[1]) {
      throw new Error("checkpoint_history_invalid");
    }
    const kinds = byOrdinal.get(ordinal) ?? new Set<string>();
    kinds.add(match[2]!);
    byOrdinal.set(ordinal, kinds);
  }
  const maxPatchBytes = input.limits?.maxPatchBytes ?? 16 * 1024 * 1024;
  for (let ordinal = 1; ordinal <= byOrdinal.size; ordinal++) {
    const kinds = byOrdinal.get(ordinal);
    if (!kinds || kinds.size !== 4) throw new Error("checkpoint_history_incomplete");
    const prefix = String(ordinal).padStart(6, "0");
    if (await readCheckpointFile(join(root, `${prefix}.intent`), 4096) !==
      `${JSON.stringify({ schemaVersion: 1, jobId: input.jobId, taskId: input.taskId,
        initialBaseCommit: input.initialBaseCommit, turnOrdinal: ordinal })}\n`) {
      throw new Error("checkpoint_history_mismatch");
    }
    let manifest: CodexGoalTurnCheckpointManifest;
    let receipt: CodexGoalTurnCheckpointReceipt;
    let patch: string;
    let manifestText: string;
    try {
      [patch, manifestText] = await Promise.all([
        readCheckpointFile(join(root, `${prefix}.patch`), maxPatchBytes),
        readCheckpointFile(join(root, `${prefix}.manifest.json`), 64 * 1024),
      ]);
      manifest = JSON.parse(manifestText) as CodexGoalTurnCheckpointManifest;
      receipt = JSON.parse(await readCheckpointFile(join(root, `${prefix}.receipt.json`), 64 * 1024)) as CodexGoalTurnCheckpointReceipt;
    } catch {
      throw new Error("checkpoint_history_invalid");
    }
    if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== "codex-goal-turn-checkpoint" ||
      manifest.jobId !== input.jobId || manifest.taskId !== input.taskId ||
      manifest.initialBaseCommit !== input.initialBaseCommit || manifest.turnOrdinal !== ordinal ||
      (manifest.state !== "patch" && manifest.state !== "clean") ||
      !Array.isArray(manifest.changedPaths) || !manifest.changedPaths.every((path) => typeof path === "string") ||
      manifest.patchSha256 !== sha256(patch) ||
      (manifest.state === "clean" && (patch !== "" || manifest.changedPaths.length !== 0)) ||
      (manifest.state === "patch" && (patch === "" || manifest.changedPaths.length === 0)) ||
      !receipt || receipt.schemaVersion !== 1 || receipt.jobId !== input.jobId ||
      receipt.taskId !== input.taskId || receipt.turnOrdinal !== ordinal ||
      receipt.manifestSha256 !== sha256(manifestText) ||
      receipt.patchSha256 !== manifest.patchSha256 ||
      typeof receipt.remoteKey !== "string" || !receiptRemoteKey.test(receipt.remoteKey)) {
      throw new Error("checkpoint_history_mismatch");
    }
  }
  return byOrdinal.size;
}

/** One instance per admitted goal job. The publisher belongs to the trusted Host. */
export function createCodexGoalTurnCheckpoint(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly initialBaseCommit: string;
  readonly publisher: CodexGoalTurnCheckpointPublisher;
  readonly limits?: Partial<HandoffArtifactLimits>;
  readonly testHooks?: Parameters<typeof captureCodexGoalExactWorkspacePatch>[0]["testHooks"];
}): (turn: { readonly workspacePath: string; readonly runId: string; readonly turnNumber: number }) => Promise<void> {
  assertSafeHandoffId(input.jobId, "checkpoint_job_id");
  assertSafeHandoffId(input.taskId, "checkpoint_task_id");
  if (!/^[0-9a-f]{40,64}$/.test(input.initialBaseCommit)) throw new Error("checkpoint_initial_base_invalid");
  let ordinal: number | undefined;
  let failed = false;
  return async (turn) => {
    if (turn.workspacePath !== input.workspacePath) throw new Error("checkpoint_workspace_mismatch");
    if (failed) throw new Error("checkpoint_previous_turn_unprotected");
    try {
    ordinal ??= await assertCodexGoalTurnCheckpointHistory(input);
    const turnOrdinal = ++ordinal;
    const root = await privateCheckpointRoot(input.jobRootDir);
    const privateRoot = root;
    const prefix = `${String(turnOrdinal).padStart(6, "0")}`;
    // Persist the ordinal before capture or offsite publication. A crash at
    // any later boundary leaves an incomplete history and blocks relaunch.
    await publishImmutableTextArtifact({ path: join(root, `${prefix}.intent`),
      content: `${JSON.stringify({ schemaVersion: 1, jobId: input.jobId,
        taskId: input.taskId, initialBaseCommit: input.initialBaseCommit, turnOrdinal })}\n`,
      existingPathUnsafeError: "checkpoint_intent_unsafe",
      contentMismatchError: "checkpoint_intent_conflict", durable: true });
    const capture = () => captureCodexGoalExactWorkspacePatch({
      workspacePath: input.workspacePath,
      expectedBaseCommit: input.initialBaseCommit,
      enforceSingleWorkspaceLayer: false,
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.testHooks ? { testHooks: input.testHooks } : {}),
    });
    const snapshot = await capture();
    // A clean capture returns early from the shared serializer. Scan it twice
    // so a clean tombstone cannot retain a previous dirty patch by accident.
    if (!snapshot && await capture() !== null) throw new Error("checkpoint_workspace_changed_during_capture");
    const patch = snapshot?.patch ?? "";
    if (snapshot) {
      await assertExactPatchSecretSafe({ workspacePath: input.workspacePath,
        jobRootDir: privateRoot, baseCommit: input.initialBaseCommit,
        patch, changedPaths: snapshot.changedPaths,
        ...(input.limits ? { limits: input.limits } : {}) });
    }
    const manifest: CodexGoalTurnCheckpointManifest = {
      schemaVersion: 1,
      kind: "codex-goal-turn-checkpoint",
      jobId: input.jobId,
      taskId: input.taskId,
      initialBaseCommit: input.initialBaseCommit,
      turnOrdinal,
      state: snapshot ? "patch" : "clean",
      changedPaths: snapshot?.changedPaths ?? [],
      patchSha256: sha256(patch),
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    const manifestSha256 = sha256(manifestText);
    const patchPath = join(root, `${prefix}.patch`);
    const manifestPath = join(root, `${prefix}.manifest.json`);
    for (const [path, content] of [[patchPath, patch], [manifestPath, manifestText]] as const) {
      await publishImmutableTextArtifact({ path, content,
        existingPathUnsafeError: "checkpoint_artifact_unsafe",
        contentMismatchError: "checkpoint_artifact_conflict", durable: true });
    }
    const receipt = await input.publisher({ manifest, manifestText, manifestSha256, patch, patchPath, manifestPath });
    if (!receipt || receipt.schemaVersion !== 1 || receipt.jobId !== input.jobId || receipt.taskId !== input.taskId ||
      receipt.turnOrdinal !== turnOrdinal || receipt.manifestSha256 !== manifestSha256 ||
      receipt.patchSha256 !== manifest.patchSha256 || typeof receipt.remoteKey !== "string" ||
      !receiptRemoteKey.test(receipt.remoteKey)) {
      throw new Error("checkpoint_receipt_invalid");
    }
    // Detect changes while the offsite publisher was working. Such a turn is
    // unprotected until a later, explicit recovery captures the new state.
    const after = await capture();
    if ((after?.patch ?? "") !== patch || JSON.stringify(after?.changedPaths ?? []) !== JSON.stringify(manifest.changedPaths)) {
      throw new Error("checkpoint_workspace_changed_during_publish");
    }
    if ((await handoffGitText(input.workspacePath, ["rev-parse", "--verify", "HEAD"])) !== input.initialBaseCommit) {
      throw new Error("checkpoint_head_moved_during_publish");
    }
    if ((await readFile(patchPath, "utf8")) !== patch || (await readFile(manifestPath, "utf8")) !== manifestText) {
      throw new Error("checkpoint_artifact_changed_during_publish");
    }
    const safeReceipt: CodexGoalTurnCheckpointReceipt = {
      schemaVersion: 1, jobId: input.jobId, taskId: input.taskId, turnOrdinal,
      manifestSha256, patchSha256: manifest.patchSha256, remoteKey: receipt.remoteKey,
    };
    await publishImmutableTextArtifact({ path: join(root, `${prefix}.receipt.json`),
      content: `${JSON.stringify(safeReceipt)}\n`, existingPathUnsafeError: "checkpoint_receipt_unsafe",
      contentMismatchError: "checkpoint_receipt_conflict", durable: true });
    } catch (error) {
      failed = true;
      throw error;
    }
  };
}

/** Fixed Unix socket protocol; no shell, provider command, or credentials. */
export function codexGoalTurnCheckpointSocketPublisher(socketPath: string): CodexGoalTurnCheckpointPublisher {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw new Error("checkpoint_socket_path_invalid");
  return async (input) => {
    const body = JSON.stringify({ schemaVersion: 1, manifest: input.manifestText, patch: Buffer.from(input.patch).toString("base64"), manifestSha256: input.manifestSha256, patchSha256: input.manifest.patchSha256 });
    const response = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, method: "POST", path: "/v1/codex-goal-turn-checkpoints", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 120_000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error("checkpoint_publisher_rejected")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16_384) { req.destroy(new Error("checkpoint_receipt_too_large")); return; } chunks.push(chunk); });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("checkpoint_publisher_timeout")));
      req.on("error", reject);
      req.end(body);
    });
    try { return JSON.parse(response) as CodexGoalTurnCheckpointReceipt; }
    catch { throw new Error("checkpoint_receipt_invalid_json"); }
  };
}
