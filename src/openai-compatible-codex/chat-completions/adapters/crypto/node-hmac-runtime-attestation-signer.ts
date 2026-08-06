import { createHmac } from "node:crypto";
import type { RuntimeAttestationSignerPort } from "../../ports/runtime-attestation-signer-port.js";

export class NodeHmacRuntimeAttestationSigner implements RuntimeAttestationSignerPort {
  constructor(private readonly secret: string) {}

  sign(payload: Uint8Array): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}
