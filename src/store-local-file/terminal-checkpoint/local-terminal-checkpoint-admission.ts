import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTerminalCheckpointClaimIdentity,
  type TerminalCheckpointClaimIdentity,
} from "@vioxen/subscription-runtime/worker-core";

export type LocalTerminalCheckpointClaim = {
  readonly checkpointId: string;
  readonly fence: number;
  readonly ownerToken: string;
  readonly identity: TerminalCheckpointClaimIdentity;
};

/**
 * One gate per job root. An abandoned mutex, writer, or claim is deliberately
 * not reaped by time: ownership recovery needs external process proof.
 */
export class LocalTerminalCheckpointAdmission {
  constructor(private readonly jobRootDir: string) {}

  private async root(): Promise<string> {
    await mkdir(this.jobRootDir, { recursive: true, mode: 0o700 });
    const jobRoot = await realpath(this.jobRootDir);
    const root = join(jobRoot, ".terminal-checkpoint-admission");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertDirectory(root);
    await mkdir(join(root, "writers"), { recursive: true, mode: 0o700 });
    await assertDirectory(join(root, "writers"));
    return root;
  }

  async withWriter<T>(effect: () => Promise<T>): Promise<T> {
    const root = await this.root();
    const token = randomUUID();
    await this.withMutex(root, async () => {
      const claim = await readState(root);
      if (claim.phase === "claimed") throw new Error("terminal_checkpoint_job_fenced");
      await durableWrite(join(root, "writers", token), `${process.pid}\n`, true);
      await syncDirectory(join(root, "writers"));
    });
    try {
      return await effect();
    } finally {
      await this.withMutex(root, async () => {
        await rm(join(root, "writers", token));
        await syncDirectory(join(root, "writers"));
      });
    }
  }

  async claim(checkpointId: string, identity: TerminalCheckpointClaimIdentity): Promise<LocalTerminalCheckpointClaim> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(checkpointId)) {
      throw new Error("terminal_checkpoint_invalid_id");
    }
    assertTerminalCheckpointClaimIdentity(identity);
    // Live inventory and controller-route coverage are not yet complete.
    if (!identity.projectId.startsWith("test-")) {
      throw new Error("terminal_checkpoint_live_claim_unsupported");
    }
    const root = await this.root();
    return this.withMutex(root, async () => {
      const state = await readState(root);
      if (state.phase === "claimed") {
        throw new Error("terminal_checkpoint_job_fenced");
      }
      if ((await readdir(join(root, "writers"))).length !== 0) {
        throw new Error("terminal_checkpoint_writers_active");
      }
      const next = { phase: "claimed" as const, checkpointId, fence: state.fence + 1,
        ownerToken: randomUUID(), identity };
      await durableReplaceState(root, next);
      return { checkpointId, fence: next.fence, ownerToken: next.ownerToken, identity };
    });
  }

  async assertClaim(claim: LocalTerminalCheckpointClaim): Promise<void> {
    const root = await this.root();
    await this.withMutex(root, async () => {
      const state = await readState(root);
      if (state.phase !== "claimed" || state.checkpointId !== claim.checkpointId ||
          state.fence !== claim.fence || state.ownerToken !== claim.ownerToken ||
          JSON.stringify(state.identity) !== JSON.stringify(claim.identity) ||
          (await readdir(join(root, "writers"))).length !== 0) {
        throw new Error("terminal_checkpoint_stale_fence");
      }
    });
  }

  async release(claim: LocalTerminalCheckpointClaim, sealed: boolean): Promise<void> {
    const root = await this.root();
    await this.withMutex(root, async () => {
      const state = await readState(root);
      if (state.phase !== "claimed" || state.checkpointId !== claim.checkpointId ||
          state.fence !== claim.fence || state.ownerToken !== claim.ownerToken ||
          JSON.stringify(state.identity) !== JSON.stringify(claim.identity) ||
          (await readdir(join(root, "writers"))).length !== 0) {
        throw new Error("terminal_checkpoint_stale_fence");
      }
      await durableReplaceState(root, {
        phase: sealed ? "sealed" : "open", checkpointId: claim.checkpointId, fence: claim.fence,
        ownerToken: claim.ownerToken, identity: claim.identity,
      });
    });
  }

  private async withMutex<T>(root: string, effect: () => Promise<T>): Promise<T> {
    const mutex = join(root, "mutex");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(mutex, { mode: 0o700 });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try {
        await durableWrite(join(mutex, "owner"), `${process.pid}\n`, true);
        await syncDirectory(mutex);
        return await effect();
      } finally {
        await rm(mutex, { recursive: true });
        await syncDirectory(root);
      }
    }
    throw new Error("terminal_checkpoint_mutex_busy_owner_unproven");
  }
}

type State = { readonly phase: "open" | "claimed" | "sealed"; readonly checkpointId: string;
  readonly fence: number; readonly ownerToken?: string; readonly identity?: TerminalCheckpointClaimIdentity };

async function readState(root: string): Promise<State> {
  let raw: string;
  try {
    const stateFile = await lstat(join(root, "state.json"));
    if (!stateFile.isFile() || stateFile.isSymbolicLink()) throw new Error("terminal_checkpoint_state_invalid");
    raw = await readFile(join(root, "state.json"), "utf8");
  }
  catch (error) {
    if (isCode(error, "ENOENT")) return { phase: "open", checkpointId: "", fence: 0 };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("terminal_checkpoint_state_invalid");
  const state = value as Record<string, unknown>;
  if (!["open", "claimed", "sealed"].includes(String(state.phase)) ||
      typeof state.checkpointId !== "string" || !Number.isSafeInteger(state.fence) ||
      Number(state.fence) < 0) throw new Error("terminal_checkpoint_state_invalid");
  if (state.phase === "claimed") {
    if (typeof state.ownerToken !== "string" || !state.identity ||
      typeof state.identity !== "object") throw new Error("terminal_checkpoint_state_invalid");
    assertTerminalCheckpointClaimIdentity(state.identity as TerminalCheckpointClaimIdentity);
  }
  return state as State;
}

async function durableReplaceState(root: string, state: State): Promise<void> {
  const temporary = join(root, `.state-${randomUUID()}.tmp`);
  await durableWrite(temporary, `${JSON.stringify(state)}\n`, true);
  await rename(temporary, join(root, "state.json"));
  await syncDirectory(root);
}

async function durableWrite(path: string, data: string, exclusive: boolean): Promise<void> {
  const file = await open(path, exclusive ? "wx" : "w", 0o600);
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertDirectory(path: string): Promise<void> {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("terminal_checkpoint_path_untrusted");
}
