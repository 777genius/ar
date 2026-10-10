import { join } from "node:path";
import { CodexModelBackend } from "../provider-codex/codex-model-backend";
import { HostedMimoProfile } from "../provider-codex/hosted-mimo-profile";
import type { ResearchRootMountAccess } from "./research-provider-root";
import type { ResearchOperatorRequest } from "./research-launch-contract";
import { researchInvalid, researchPath } from "./research-launch-files";

// Fixed guest-only paths. None is a bind of a Host job, session or tool home.
export const researchMimoCodingHome = "/home/coding";
export const researchMimoCodingCodexHome = "/home/coding/.codex";
export const researchMimoCodingPrivateHome = Object.freeze({
  target: researchMimoCodingHome, options: "rw,nosuid,nodev,mode=0700,size=128M",
});
const bootstrapNames = Object.freeze([
  "hosted-app-server-launcher.js", "hosted-process-descriptors.js",
  "hosted-fd-prelude.js", "hosted-app-server-launch-frame.js",
]);

/** Layout selection only. A request/profile is never provider admission or the
 * still-closed independent coding activation capability. */
export function researchMimoCodingRoot(request: ResearchOperatorRequest): boolean {
  if (request.hostedProfile !== HostedMimoProfile.CodingV1) return false;
  if (request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) researchInvalid();
  return true;
}

/** Preparation receipts cannot enable coding before proxy/start ownership and
 * the installed native network oracle are connected. The independent origin
 * has its own closed gate; keep this effect boundary closed as well. */
export function assertResearchMimoCodingRootActivation(request: ResearchOperatorRequest): void {
  if (researchMimoCodingRoot(request)) throw new Error("hosted_mimo_coding_activation_closed");
}

/** The first-exec launcher imports exactly these four installed modules and
 * Node builtins. A package leaf retains ESM interpretation without importing
 * the complete installed runtime directory. The artifact fence remains owned
 * by the existing provider material/authority checks. */
export function researchMimoCodingBootstrapPaths(runtimeDirectory: string): readonly string[] {
  researchPath(runtimeDirectory);
  return Object.freeze([join(runtimeDirectory, "package.json"),
    ...bootstrapNames.map(name => join(runtimeDirectory, "dist/provider-codex/app-server/adapters", name))]);
}

/** Finite structural defense after the common native graph checks. This helper
 * cannot mint a root receipt, select source descriptors or authorize a launch. */
export function assertResearchMimoCodingRootBindings(input: Readonly<{
  workspace: string; workspaceSource: string; readonlyTargets: readonly string[];
  bindings: readonly Readonly<{ source: string; target: string; file: boolean; access: ResearchRootMountAccess }>[];
}>): void {
  researchPath(input.workspace); researchPath(input.workspaceSource);
  const writable = input.bindings.filter(binding => binding.access === "read-write");
  if (writable.length !== 1 || writable[0]!.target !== input.workspace ||
      writable[0]!.source !== input.workspaceSource || writable[0]!.file) researchInvalid();
  const allowed = new Set(input.readonlyTargets);
  if (input.bindings.some(binding => binding.access !== "read-write" &&
      (binding.access !== "read-only" || !allowed.has(binding.target)))) researchInvalid();
}
