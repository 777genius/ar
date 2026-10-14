// The caller supplies canonical inventory bytes. Publication is not install attestation.
// Different installations sharing an install key may have different content digests.
export interface DependencyManifestBlobStore {
  put(canonicalManifestBytes: Uint8Array): Promise<string>;
  get(contentDigest: string): Promise<Uint8Array>;
}
