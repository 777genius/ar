import { describe, expect, it } from "vitest";
import { CodexModelBackend, codexMimoDefaultModel } from "../../provider-codex/codex-model-backend";
import { HostedMimoProfile } from "../../provider-codex/hosted-mimo-profile";
import { decodeHostedMimoCodingExpectedBinding, assertHostedMimoCodingExpectedBinding } from "../../provider-codex/hosted-mimo-coding-bootstrap";
import type { ResearchOperatorRequest } from "../research-launch-contract";
import { ResearchRootMountAccess } from "../research-provider-root";
import { assertResearchMimoCodingRootActivation, assertResearchMimoCodingRootBindings,
  researchMimoCodingBootstrapBinding, researchMimoCodingBootstrapPaths, researchMimoCodingLauncherArguments, researchMimoCodingRoot } from "../research-mimo-coding-root";

const request: ResearchOperatorRequest = { schemaVersion: 1, jobId: "TEST-coding-root", taskId: "TEST-task",
  jobRootDir: "/TEST/job", workspacePath: "/TEST/workspace", promptPath: "/TEST/job/prompt.md", authRootDir: "/TEST/auth",
  accounts: ["account-q"], codexBinaryPath: "/usr/bin/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
  hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: 64, model: codexMimoDefaultModel,
  reasoningEffort: "high", serviceTier: "default", taskTimeoutMs: 60_000, maxAccountCycles: 1, prewarmOnStart: false };
const workspace = { source: "/TEST/pins/workspace", target: request.workspacePath, file: false, access: ResearchRootMountAccess.ReadWrite };
const publicRoot = { source: "/usr", target: "/usr", file: false, access: ResearchRootMountAccess.ReadOnly };
const verify = (bindings: readonly typeof workspace[]) => assertResearchMimoCodingRootBindings({
  workspace: request.workspacePath, workspaceSource: workspace.source, readonlyTargets: ["/usr"], bindings });

describe("closed MiMo coding root recipe", () => {
  it("keeps activation closed even for an explicit coding request", () => {
    expect(researchMimoCodingRoot(request)).toBe(true);
    expect(() => assertResearchMimoCodingRootActivation(request)).toThrow("hosted_mimo_coding_activation_closed");
    const { hostedProfile: _profile, maxGoalTurns: _turns, ...worker } = request;
    expect(researchMimoCodingRoot(worker)).toBe(false);
    expect(() => assertResearchMimoCodingRootActivation(worker)).not.toThrow();
    expect(() => researchMimoCodingRoot({ ...request, modelBackend: CodexModelBackend.OpenAiChatGpt })).toThrow("hosted_research_launch_denied");
  });
  it("accepts exactly one pinned workspace writer and finite public readers", () => {
    expect(() => verify([workspace, publicRoot])).not.toThrow();
    expect(() => verify([publicRoot])).toThrow("hosted_research_launch_denied");
    expect(() => verify([{ ...workspace, source: "/TEST/foreign-workspace" }, publicRoot])).toThrow("hosted_research_launch_denied");
    expect(() => verify([{ ...workspace, file: true }, publicRoot])).toThrow("hosted_research_launch_denied");
  });
  it.each(["/TEST/job", "/TEST/auth", "/home/coding", "/run/TEST-control"])("rejects an additional Host writer at %s", target => {
    expect(() => verify([workspace, publicRoot, { ...workspace, source: target, target }])).toThrow("hosted_research_launch_denied");
  });
  it("rejects an unlisted read-only source target", () => {
    expect(() => verify([workspace, publicRoot, { ...publicRoot, source: "/TEST/job", target: "/TEST/job" }]))
      .toThrow("hosted_research_launch_denied");
  });
  it("binds fixed launcher identity to the sealed start and workspace while keeping Worker mode unchanged", () => {
    const spec = { request, startId: "11111111-1111-1111-1111-111111111111" };
    const binding = researchMimoCodingBootstrapBinding(spec, "a".repeat(64))!;
    const args = researchMimoCodingLauncherArguments(binding);
    expect(args[0]).toBe("--research-coding-ready-v1");
    const expected = decodeHostedMimoCodingExpectedBinding(args[1]!);
    expect(expected).toEqual({ schemaVersion: 1, startId: spec.startId, specSha256: "a".repeat(64), workspacePath: request.workspacePath });
    expect(() => assertHostedMimoCodingExpectedBinding({ ...expected, configToml: "" }, expected)).not.toThrow();
    for (const changed of [{ startId: "22222222-2222-2222-2222-222222222222" }, { specSha256: "b".repeat(64) }, { workspacePath: "/TEST/foreign" }]) {
      expect(() => assertHostedMimoCodingExpectedBinding({ ...expected, ...changed, configToml: "" }, expected)).toThrow("mismatch");
    }
    const { hostedProfile: _profile, maxGoalTurns: _turns, ...worker } = request;
    expect(researchMimoCodingBootstrapBinding({ ...spec, request: worker }, "a".repeat(64))).toBeUndefined();
    expect(researchMimoCodingLauncherArguments(undefined)).toEqual(["--research-ready-v1"]);
    expect(() => researchMimoCodingBootstrapBinding(spec, "invalid")).toThrow();
  });
  it("exposes only the finite launcher files instead of an installed runtime directory", () => {
    const paths = researchMimoCodingBootstrapPaths("/TEST/runtime");
    expect(paths).toHaveLength(6);
    expect(new Set(paths).size).toBe(6);
    expect(paths.some(path => path.endsWith("/hosted-app-server-launch-frame-decoder.js"))).toBe(true);
    expect(paths.some(path => path.endsWith("/hosted-mimo-coding-bootstrap.js"))).toBe(true);
    expect(paths.some(path => /(?:credential|registry|launch-frame\.js)/.test(path))).toBe(false);
    expect(paths.every(path => path.startsWith("/TEST/runtime/") && path !== "/TEST/runtime")).toBe(true);
    expect(() => researchMimoCodingBootstrapPaths("relative/TEST-runtime")).toThrow("hosted_research_launch_denied");
  });
});
