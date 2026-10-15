import { assertHostedMimoCodingWorkerOriginCurrent, type HostedMimoCodingWorkerOrigin, readHostedMimoWorkerOrigin } from "./hosted-mimo-worker-origin";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import { CodexProviderEgressProfileId } from "./codex-provider-egress-policy";
import { assertHostedActivationOperator, readHostedOrdinaryProcessOrigin, withHostedActivationFence } from "./app-server/adapters/hosted-process-activation";

export const hostedMimoCredentialPath = "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key";
const maximumCredentialBytes = 4096;

/** Readiness check reads metadata only; the key is opened for bytes at launch. */
export function hostedMimoCredentialSourceReady(): boolean {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return false;
  try {
    if (!readHostedMimoWorkerOrigin()) assertHostedActivationOperator();
    const ancestry: string[] = [];
    for (let current = dirname(hostedMimoCredentialPath);; current = dirname(current)) {
      ancestry.unshift(current);
      if (current === "/") break;
    }
    for (const directory of ancestry) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    }
    const fd = openSync(hostedMimoCredentialPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      return stat.isFile() && stat.uid === 0 && stat.nlink === 1 &&
        (stat.mode & 0o7777) === 0o600 && stat.size > 0 && stat.size <= maximumCredentialBytes;
    } finally { closeSync(fd); }
  } catch { return false; }
}

/** Host-only source. A caller cannot select another credential or pass its bytes. */
export function resolveHostedMimoCredential(redactor: RedactorPort): string {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("hosted_mimo_credential_operator_required");
  }
  assertHostedActivationOperator();
  return readHostedMimoCredentialAtPath(hostedMimoCredentialPath, redactor);
}

/** Origin is independently read before touching the shared source. */
export function resolveAuthorizedHostedMimoCredential(redactor: RedactorPort): string {
  const worker = readHostedMimoWorkerOrigin();
  if (worker) {
    const credential = readHostedMimoCredentialAtPath(hostedMimoCredentialPath, redactor);
    if (readHostedMimoWorkerOrigin()?.digest !== worker.digest) throw new Error("hosted_mimo_worker_origin_invalid");
    return credential;
  }
  return withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    if ((origin.profileId as CodexProviderEgressProfileId) !== CodexProviderEgressProfileId.MimoTokenPlan) {
      throw new Error("hosted_mimo_admission_invalid");
    }
    return resolveHostedMimoCredential(redactor);
  });
}

/** Coding keys go only to the outside owned proxy, never session.env. A plain
 * DTO cannot substitute for the independently minted retained-origin proof. */
export function resolveHostedMimoCodingProxyCredential(proof: HostedMimoCodingWorkerOrigin, redactor: RedactorPort,
  assertActive: () => void): string {
  assertActive();
  assertHostedMimoCodingWorkerOriginCurrent(proof);
  assertActive();
  const credential = readHostedMimoCredentialAtPath(hostedMimoCredentialPath, redactor);
  assertHostedMimoCodingWorkerOriginCurrent(proof);
  assertActive();
  return credential;
}

/** Adapter-local captured source authority, never a serialized admission DTO. */
export type HostedMimoCodingCredentialCapture = Readonly<{
  bytes: Buffer;
  credentialFingerprint: string;
  assertCurrent(): void;
}>;
const credentialCaptures = new WeakSet<object>();

export function hostedMimoCredentialFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update("subscription-runtime:mimo-current-credential:v1\0").update(bytes).digest("hex");
}

export function assertHostedMimoCodingCredentialCapture(capture: HostedMimoCodingCredentialCapture, bytes: Uint8Array): void {
  if (!credentialCaptures.has(capture) || capture.credentialFingerprint !== hostedMimoCredentialFingerprint(bytes)) {
    throw new Error("hosted_mimo_credential_capture_invalid");
  }
  capture.assertCurrent();
}

export function captureHostedMimoCodingProxyCredential(origin: HostedMimoCodingWorkerOrigin, redactor: RedactorPort,
  assertActive: () => void): HostedMimoCodingCredentialCapture {
  const bytes = Buffer.from(resolveHostedMimoCodingProxyCredential(origin, redactor, assertActive));
  const credentialFingerprint = hostedMimoCredentialFingerprint(bytes);
  const capture = Object.freeze({ bytes, credentialFingerprint,
    assertCurrent() {
      // Final proof validation may run after task disposal. Recheck custody and
      // origin without extending or reopening the task's execution lifetime.
      const current = Buffer.from(resolveHostedMimoCodingProxyCredential(origin, redactor, () => {}));
      try {
        if (hostedMimoCredentialFingerprint(current) !== credentialFingerprint) throw new Error("hosted_mimo_credential_changed");
      } finally { current.fill(0); }
    },
  });
  credentialCaptures.add(capture);
  return capture;
}

/** Narrow filesystem seam for synthetic tests. Production uses the fixed path above. */
export function readHostedMimoCredentialAtPath(path: string, redactor: RedactorPort,
  expectedOwnerUid = 0, expectedFileOwnerUid = expectedOwnerUid): string {
  const invalid = () => { throw new Error("hosted_mimo_credential_invalid"); };
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") invalid();
  const ancestry: string[] = [];
  for (let current = dirname(path);; current = dirname(current)) {
    ancestry.unshift(current);
    if (current === "/") break;
  }
  try {
    for (const directory of ancestry) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== expectedOwnerUid || (stat.mode & 0o022) !== 0) invalid();
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== expectedFileOwnerUid || before.nlink !== 1 ||
          (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > maximumCredentialBytes) invalid();
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const next = readSync(fd, bytes, count, bytes.length - count, count);
        if (next === 0) break;
        count += next;
      }
      const after = fstatSync(fd), current = lstatSync(path);
      if (current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs ||
          count !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
          after.mtimeMs !== before.mtimeMs || after.uid !== expectedFileOwnerUid || after.nlink !== 1 ||
          (after.mode & 0o7777) !== 0o600) invalid();
      const credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)).trim();
      if (!credential || /[\u0000-\u001f\u007f\s]/.test(credential)) invalid();
      redactor.registerSecret(credential, "hosted-mimo-token-plan");
      return credential;
    } finally { closeSync(fd); }
  } catch { return invalid(); }
}
