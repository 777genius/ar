import { realpathSync } from "node:fs";
import { researchArtifactDigest, researchCustody } from "./research-launch-files";

/** A protected origin chooses executable composition only, never writer release. */
export function assertQualifiedResearchRuntimeArtifact(directory: string, digest: string): void {
  if (!/^\/opt\/subscription-runtime\/releases\/[a-f0-9]{40}$/.test(directory) || !/^[a-f0-9]{64}$/.test(digest) ||
      realpathSync(directory) !== directory) throw new Error("mimo_project_runtime_routing_invalid");
  researchCustody(directory);
  if (researchArtifactDigest(directory) !== digest) throw new Error("mimo_project_runtime_routing_invalid");
}
