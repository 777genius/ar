import { createHmac, timingSafeEqual } from "node:crypto";
import {
  openAiBridgeRuntimeAttestationCanonicalBytes,
  type OpenAiBridgeRuntimeAttestationInput,
} from "../../domain/runtime-attestation.js";

export type OpenAiBridgeRuntimeAttestationVerification = {
  readonly attestationSecret: string | Uint8Array;
  readonly expectedHmacSha256: string;
  readonly attestation: OpenAiBridgeRuntimeAttestationInput;
};

/** Verify a v2 receipt without accepting or returning prompt/output plaintext. */
export function verifyOpenAiBridgeRuntimeAttestationHmac(
  input: OpenAiBridgeRuntimeAttestationVerification,
): boolean {
  const secret = typeof input.attestationSecret === "string"
    ? Buffer.from(input.attestationSecret, "utf8")
    : Buffer.from(input.attestationSecret);
  if (
    secret.byteLength < 32 ||
    !/^[a-f0-9]{64}$/.test(input.expectedHmacSha256)
  ) {
    return false;
  }
  const actual = createHmac("sha256", secret)
    .update(openAiBridgeRuntimeAttestationCanonicalBytes(input.attestation))
    .digest();
  const expected = Buffer.from(input.expectedHmacSha256, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
