import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalFileProviderLock } from "../shared/local-file-custody-lock";

export type CapturedLocalFileLock = {
  storageVersion: string;
  lockId: string;
  providerInstanceIdHash: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
  ownerProcess?: { bootId: string; pidNamespace: string; startTimeTicks: string };
};

/** Capture the actual writer format before seeding a simulated dead owner. */
export async function captureLocalFileLock(rootDir: string,
  providerInstanceId = "test-lock-identity-probe"): Promise<CapturedLocalFileLock> {
  const name = createHash("sha256").update(providerInstanceId).digest("hex");
  return new LocalFileProviderLock({ rootDir }).run(providerInstanceId, async () =>
    JSON.parse(await readFile(join(rootDir, "leases", "locks", `${name}.lock`), "utf8")) as CapturedLocalFileLock);
}
