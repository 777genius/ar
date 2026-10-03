import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readOrCreateCodexGoalEncryptionKey(
  keyPath: string,
): Promise<Uint8Array> {
  if (existsSync(keyPath)) {
    const value = (await readFile(keyPath, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error("codex_goal_encryption_key_invalid");
    }
    return Buffer.from(value, "hex");
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("hex")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return key;
}
