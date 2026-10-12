import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deriveRuntimeStorageRoots, type RuntimeStorageRoots } from "@vioxen/subscription-runtime/core";

/** Validate the selected transport root before request or filesystem IO. */
export function agentCliStorageRoots(value: string | undefined, cwd: string): RuntimeStorageRoots | undefined {
  if (value === undefined) return undefined;
  if (!value) throw new Error("Invalid runtime storageRootDir");
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return deriveRuntimeStorageRoots(resolve(cwd, expanded));
}

/** Existing state and ephemeral precedence, with one owned temporary allocation. */
export async function agentCliStateRoot(input: {
  readonly stateRootDir?: string | undefined;
  readonly ephemeral: boolean;
  readonly envStateRootDir?: string | undefined;
  readonly roots?: RuntimeStorageRoots | undefined;
  readonly consumer: "agent-task" | "agent-runtime-task";
  readonly provider: string;
}): Promise<{ readonly stateRootDir?: string; readonly temporaryRoot?: string }> {
  if (input.stateRootDir !== undefined) return { stateRootDir: input.stateRootDir };
  if (input.ephemeral) {
    const parent = input.roots?.tmpRootDir ?? tmpdir();
    if (input.roots) await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryRoot = await mkdtemp(join(parent, `subscription-runtime-${input.consumer}-`));
    return { stateRootDir: temporaryRoot, temporaryRoot };
  }
  const stateRootDir = input.envStateRootDir ?? (input.roots && join(input.roots.stateRootDir, input.consumer, input.provider));
  return stateRootDir === undefined ? {} : { stateRootDir };
}
