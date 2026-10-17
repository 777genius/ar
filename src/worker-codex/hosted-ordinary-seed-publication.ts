import { publishCodexEffectiveSeed, readCodexEffectiveSeed, type CodexEffectiveSeed } from "./codex-effective-seed";

/** Official CAS/readback only. This returns no owner, reservation or release
 * authority; the original broker must still rejoin and drain before finish. */
export async function verifyOriginalOrdinarySeedPublication(seed: CodexEffectiveSeed, next: string): Promise<void> {
  const published = await publishCodexEffectiveSeed(seed, next);
  if (!published && next !== seed.bytes) throw new Error("ordinary_launcher_qualification_held");
  const committed = await readCodexEffectiveSeed(seed.sourcePath);
  if (committed.source !== seed.source || committed.bytes !== next) throw new Error("ordinary_launcher_qualification_held");
}
