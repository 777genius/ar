// TEST child only: inject one annotated imports refusal into the real built bootstrap.
// Actual digest guard tests separately prove role binding; this fixture proves transport.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const diagnostics = await import(pathToFileURL(resolve("dist/worker-codex/research-launch-diagnostics.js")).href) as typeof import("../../research-launch-diagnostics");
const NativeError = globalThis.Error;
const refusal = new NativeError("hosted_research_launch_denied", { cause: "file-deadline" });
Object.defineProperty(refusal, "stack", { value: "TEST-private-bootstrap-path-token-stack" });
diagnostics.annotateResearchMaterialFailure(refusal, diagnostics.ResearchMaterialRole.RuntimeArtifact);
globalThis.Error = new Proxy(NativeError, { construct: () => refusal });
