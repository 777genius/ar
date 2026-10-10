import { join } from "node:path";
import { CodexModelBackend } from "../provider-codex/codex-model-backend";
import { HostedMimoProfile } from "../provider-codex/hosted-mimo-profile";
import type { ResearchRootMountAccess } from "./research-provider-root";
import type { ResearchOperatorRequest, ResearchStartSpec } from "./research-launch-contract";
import { decodeHostedMimoCodingExpectedBinding, hostedMimoCodingGuestHome, hostedMimoCodingGuestCodexHome, type HostedMimoCodingExpectedBinding } from "../provider-codex/hosted-mimo-coding-bootstrap";
import { researchInvalid, researchPath } from "./research-launch-files";

// Fixed guest-only paths. None is a bind of a Host job, session or tool home.
export const researchMimoCodingHome = hostedMimoCodingGuestHome;
export const researchMimoCodingCodexHome = hostedMimoCodingGuestCodexHome;
export const researchMimoCodingPrivateHome = Object.freeze({
  target: researchMimoCodingHome, options: "rw,nosuid,nodev,mode=0700,size=128M",
});
const bootstrapNames = Object.freeze([
  "hosted-app-server-launcher.js", "hosted-process-descriptors.js",
  "hosted-blocking-output.js", "managed-provider-scratch-environment.js",
  "hosted-fd-prelude.js", "hosted-app-server-launch-frame-decoder.js",
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

/** The first-exec launcher imports only these installed modules, the light DTO, and
 * Node builtins. A package leaf retains ESM interpretation without importing
 * the complete installed runtime directory. The artifact fence remains owned
 * by the existing provider material/authority checks. */
export function researchMimoCodingBootstrapPaths(runtimeDirectory: string): readonly string[] {
  researchPath(runtimeDirectory);
  return Object.freeze([join(runtimeDirectory, "package.json"),
    ...bootstrapNames.map(name => join(runtimeDirectory, "dist/provider-codex/app-server/adapters", name)),
    join(runtimeDirectory, "dist/provider-codex/hosted-mimo-coding-bootstrap.js")]);
}

/** Public expected values come from the sealed reservation, never from the
 * incoming launch frame. This mapper grants no root or execution authority. */
export function researchMimoCodingBootstrapBinding(spec: Pick<ResearchStartSpec, "request" | "startId">, specSha256: string): HostedMimoCodingExpectedBinding | undefined {
  if (!researchMimoCodingRoot(spec.request)) return undefined;
  researchPath(spec.request.workspacePath);
  return decodeHostedMimoCodingExpectedBinding(Buffer.from(JSON.stringify({ schemaVersion: 1,
    startId: spec.startId, specSha256, workspacePath: spec.request.workspacePath })).toString("base64url"));
}

/** Only public identity fields cross argv; config and capability stay on the
 * owned input channel. Ordinary Worker keeps its existing launcher mode. */
export function researchMimoCodingLauncherArguments(binding: HostedMimoCodingExpectedBinding | undefined): readonly string[] {
  if (!binding) return Object.freeze(["--research-ready-v1"]);
  const encoded = Buffer.from(JSON.stringify(binding)).toString("base64url");
  decodeHostedMimoCodingExpectedBinding(encoded);
  return Object.freeze(["--research-coding-ready-v1", encoded]);
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
