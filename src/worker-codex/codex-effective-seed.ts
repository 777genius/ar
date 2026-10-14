import { readFile, rm, writeFile } from "node:fs/promises";
import { createCodexRuntimeTempRoot } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedOrdinaryEffectPaths } from "../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { join } from "node:path";
import { FileBackendCodexSeedWriteback } from "./file-backend-codex-seed-writeback";

/** Login authorization and usable provider refresh are distinct snapshots.
 * Host-side supported readers use this contract, not a raw source-path copy.
 * The login writer owns sourcePath; runtime never renames or writes it.
 */
export type CodexEffectiveSeed = {
  readonly sourcePath: string;
  readonly source: string;
  readonly bytes: string;
};

export async function readCodexEffectiveSeed(sourcePath: string): Promise<CodexEffectiveSeed> {
  const source = await readFile(sourcePath, "utf8");
  const bytes = await new FileBackendCodexSeedWriteback(sourcePath).read(source);
  return { sourcePath, source, bytes };
}

export async function publishCodexEffectiveSeed(seed: CodexEffectiveSeed, next: string): Promise<boolean> {
  return new FileBackendCodexSeedWriteback(seed.sourcePath).publishRefresh({ source: seed.source, expected: seed.bytes, next });
}

/** A probe may rotate auth too. Give it a private home and retain its successful
 * refresh through the same custody contract before deleting that home. If
 * publication fails, leave this 0700/0600 recovery home and propagate failure.
 */
export async function materializeCodexEffectiveSeed(sourcePath: string, sourceEnv?: Readonly<Record<string, string | undefined>>): Promise<{
  readonly seed: CodexEffectiveSeed;
  readonly home: string;
  readonly authJsonPath: string;
  readonly finish: (successful: boolean) => Promise<void>;
}> {
  const seed = await readCodexEffectiveSeed(sourcePath);
  const home = await createCodexRuntimeTempRoot({ prefix: "subscription-runtime-codex-effective-", sourceEnv });
  const authJsonPath = join(home, "auth.json");
  assertHostedOrdinaryEffectPaths([home, authJsonPath]);
  await writeFile(authJsonPath, seed.bytes, { mode: 0o600 });
  return { seed, home, authJsonPath, finish: async successful => {
    if (successful) await publishCodexEffectiveSeed(seed, await readFile(authJsonPath, "utf8"));
    assertHostedOrdinaryEffectPaths([home]);
    await rm(home, { recursive: true, force: true });
  } };
}
