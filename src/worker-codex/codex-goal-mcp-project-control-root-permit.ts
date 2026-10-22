import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { LocalProjectControlEvidenceCustody } from "../worker-local/project-control-evidence-custody-local-adapter";

export const permitHash = z.string().regex(/^[a-f0-9]{64}$/);
export const permitAbsolutePath = z.string().refine(value => isAbsolute(value) && resolve(value) === value && !value.includes("\\"));

export const rootPermitSha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Shared secure read of a root-admin owner-intent file: effective UID 0, an
 * absolute canonical path, a regular non-symlink root-owned 0600 file of at most
 * 128 KiB whose bytes match the expected hash and did not change while read.
 * Callers parse their own strict schema from the returned bytes. Error codes
 * are `<errorPrefix>_root_required`, `_permit_security_invalid` and
 * `_permit_hash_mismatch`.
 */
export async function readRootOwnedPermitBytes(input: {
  readonly permitFile: string;
  readonly expectedPermitSha256: string;
  readonly errorPrefix: string;
}): Promise<Buffer> {
  if (process.geteuid?.() !== 0) throw new Error(`${input.errorPrefix}_root_required`);
  permitAbsolutePath.parse(input.permitFile);
  permitHash.parse(input.expectedPermitSha256);
  await new LocalProjectControlEvidenceCustody().canonicalDirectory(dirname(input.permitFile));
  const handle = await open(input.permitFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || (before.mode & 0o777n) !== 0o600n || before.size > 128n * 1024n) {
      throw new Error(`${input.errorPrefix}_permit_security_invalid`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        rootPermitSha256(bytes) !== input.expectedPermitSha256) throw new Error(`${input.errorPrefix}_permit_hash_mismatch`);
    return bytes;
  } finally { await handle.close(); }
}
