import { createHash, timingSafeEqual } from "node:crypto";

/** These readers are supplied by the root dispatcher, under its retained host
 * fence. The model and pipe protocol carry none of these values. */
export type HostedControllerRetainedOrigin = Readonly<{
  installationId: string;
  startId: string;
  jobId: string;
  originSha256: string;
}>;

export function bindHostedControllerOriginAndGrant(input: {
  readonly readRetainedOrigin: () => HostedControllerRetainedOrigin;
  readonly readPrivateGrant: (origin: HostedControllerRetainedOrigin) => Buffer;
}): () => boolean {
  const origin = readOrigin(input.readRetainedOrigin);
  const grantDigest = digestGrant(input.readPrivateGrant(origin));
  return () => {
    try {
      const current = readOrigin(input.readRetainedOrigin);
      if (current.installationId !== origin.installationId || current.startId !== origin.startId ||
          current.jobId !== origin.jobId || current.originSha256 !== origin.originSha256) return false;
      return timingSafeEqual(grantDigest, digestGrant(input.readPrivateGrant(current)));
    } catch { return false; }
  };
}

function readOrigin(read: () => HostedControllerRetainedOrigin): HostedControllerRetainedOrigin {
  const origin = read();
  if (!origin || !/^[a-f0-9-]{36}$/.test(origin.installationId) ||
      !/^[a-f0-9-]{36}$/.test(origin.startId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(origin.jobId) ||
      !/^[a-f0-9]{64}$/.test(origin.originSha256)) throw new Error("hosted_controller_origin_invalid");
  return Object.freeze({ ...origin });
}

function digestGrant(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 4096) {
    throw new Error("hosted_controller_private_grant_invalid");
  }
  return createHash("sha256").update(bytes).digest();
}
