export interface RuntimeAttestationSignerPort {
  sign(payload: Uint8Array): string;
}
