import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({ files: new Map<string, string>(), present: new Set<string>(), birth: "released", ordinaryAbsent: true,
  validate: vi.fn(), workspace: { workspaceHead: "b".repeat(40), workspaceStatus: "", workspaceUnstagedDirty: false }, changedDirectory: false, inPublication: false }));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = "/srv/worker-state/mimo-projects/p/s", registry = root + "/registry", workspace = "/scratch/p/s/workspaces/j";
const job = { jobId: "j", jobRootDir: root + "/jobs/j", workspacePath: workspace, modelBackend: "xiaomi-mimo-token-plan", promptPath: root + "/jobs/j/prompt.md",
  projectPreStartAdmission: { receiptPath: root + "/jobs/j/pre-start-admission/receipt.json", contractPath: root + "/jobs/j/pre-start-admission/contract.json", statePath: root + "/jobs/j/pre-start-admission/state.json" } };
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), lstatSync: (path: string) => { if (state.present.has(path)) return {}; throw Object.assign(new Error("TEST absent"), { code: "ENOENT" }); } }));
vi.mock("../hosted-mimo-project-bridge", () => ({ hostedMimoBridgeMetadataBytes: (path: string) => Buffer.from(state.files.get(path) ?? "TEST immutable bytes"),
  parseHostedMimoProjectBinding: () => ({ projectId: "p", registryRootDir: registry, controllerJobId: "c", stateRoot: root, scratchRoot: "/scratch/p/s", sourceWorkspacePath: "/source/p", sourceCommit: "b".repeat(40) }) }));
vi.mock("../codex-goal-jobs", () => ({ readCodexGoalJob: async () => job }));
vi.mock("../codex-goal-mcp-project-control-deps", () => ({ loadProjectControlController: async () => ({ controller: { jobId: "c" }, scope: { projectId: "p", allowedAccountIds: ["account-q"] } }) }));
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn() }));
vi.mock("../research-launch-files", () => ({ researchAuthorityRoot: "/run/user/subscription-runtime-research-v1", researchHash: (value: string | Buffer) => createHash("sha256").update(value).digest("hex"),
  researchDirectoryIdentity: (path: string) => ({ path, device: 1, inode: state.changedDirectory ? 3 : 2 }) }));
vi.mock("../hosted-ordinary-writer-authority", () => ({ hostedOrdinaryWriterAuthorityAbsent: () => state.ordinaryAbsent }));
vi.mock("../protected-job-birth", () => ({ withProtectedCodexGoalJobBirthPublication: async (effect: () => Promise<unknown>) => { state.inPublication = true; try { return await effect(); } finally { state.inPublication = false; } }, observeCompatibleProtectedCodexGoalJobBirth: async () => ({ status: state.birth }) }));
vi.mock("../application/project-control/codex-goal-project-pre-start-admission", () => ({ assertProjectPreStartAdmissionLaunchBinding: (...args: unknown[]) => state.validate(...args), assertProjectPreStartAdmissionDescriptorPaths: (descriptor: typeof job.projectPreStartAdmission, jobRoot: string) => { for (const field of ["contractPath", "statePath", "receiptPath"] as const) if (descriptor[field] !== jobRoot + "/pre-start-admission/" + field.replace("Path", ".json")) throw new Error("project_control_pre_start_path_invalid"); } }));
vi.mock("../application/project-control/codex-goal-project-pre-start-binding", () => ({ captureProjectPreStartBinding: async () => { expect(state.inPublication).toBe(false); return state.workspace; } }));
import { capturePublicationBusyStartRearm, assertPublicationBusyStartRearmCurrent, isPublicationBusyResult } from "../hosted-mimo-publication-busy-rearm";
import { MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
const request = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "p", workstreamId: "s", jobId: "j", operation: MimoProjectBridgeOperation.Start } as const;
beforeEach(() => { state.files.clear(); state.present.clear(); state.birth = "released"; state.ordinaryAbsent = true; state.changedDirectory = false;
  job.modelBackend = CodexModelBackend.XiaomiMimoTokenPlan; state.workspace = { workspaceHead: "b".repeat(40), workspaceStatus: "", workspaceUnstagedDirty: false };
  state.files.set("/etc/subscription-runtime/mimo-projects/p/s.json", "{}"); state.files.set(job.projectPreStartAdmission.receiptPath, JSON.stringify({ status: "validated_not_launched" })); state.inPublication = false; state.validate.mockReset().mockImplementation(async () => { expect(state.inPublication).toBe(false); }); });
it("proves untouched positive birth with legacy absent count meaning zero, and rechecks the snapshot", async () => {
  const proof = await capturePublicationBusyStartRearm(request);
  expect(proof.bindings).toHaveLength(9); expect(proof.directories).toHaveLength(4);
  await expect(assertPublicationBusyStartRearmCurrent(request, proof)).resolves.toBeUndefined();
  state.files.set(job.promptPath, "TEST changed");
  await expect(assertPublicationBusyStartRearmCurrent(request, proof)).rejects.toThrow("publication_busy_rearm_refused");
});
it.each(["authorized", "count", "native-authority", "reservation", "lexical-first-effect", "physical-first-effect", "ordinary-writer", "unknown-birth", "dirty", "head", "receipt-drift", "manifest-drift", "directory-drift", "intervening-first-effect"])("refuses consumed, unknown or changed authority: %s", async fault => {
  if (fault === "authorized") state.files.set(job.projectPreStartAdmission.receiptPath, JSON.stringify({ status: "launch_authorized" }));
  if (fault === "count") state.files.set(job.projectPreStartAdmission.receiptPath, JSON.stringify({ status: "validated_not_launched", launchAuthorizationCount: 1 }));
  if (fault === "native-authority") state.present.add("/run/user/subscription-runtime-research-v1/" + hash("j"));
  if (fault === "reservation") state.present.add(job.jobRootDir + "/account-reservation.json");
  if (fault === "lexical-first-effect") state.present.add("/run/user/subscription-runtime-research-v1/job-births/" + hash(job.jobRootDir) + ".first-effect.json");
  if (fault === "physical-first-effect") state.present.add("/run/user/subscription-runtime-research-v1/job-births/physical-1-2.first-effect.json");
  if (fault === "ordinary-writer") state.ordinaryAbsent = false;
  if (fault === "unknown-birth") state.birth = "unknown";
  if (fault === "dirty") state.workspace.workspaceUnstagedDirty = true;
  if (fault === "head") state.workspace.workspaceHead = "c".repeat(40);
  if (fault === "receipt-drift") state.validate.mockImplementation(async () => { state.files.set(job.projectPreStartAdmission.receiptPath, "TEST replaced"); });
  if (fault === "manifest-drift") state.validate.mockImplementation(async () => { state.files.set(registry + "/j/job.json", "TEST replaced"); });
  if (fault === "directory-drift") state.validate.mockImplementation(async () => { state.changedDirectory = true; });
  if (fault === "intervening-first-effect") state.validate.mockImplementation(async () => { state.present.add("/run/user/subscription-runtime-research-v1/job-births/physical-1-2.first-effect.json"); });
  await expect(capturePublicationBusyStartRearm(request)).rejects.toThrow("publication_busy_rearm_refused");
});
it("accepts only the exact closed busy envelope", () => {
  expect(isPublicationBusyResult({ ok: false, error: "protected_job_birth_publication_busy" })).toBe(true);
  for (const value of [{ ok: true, error: "protected_job_birth_publication_busy" }, { ok: false, error: "other" }, { ok: false, error: "protected_job_birth_publication_busy", result: {} }]) expect(isPublicationBusyResult(value)).toBe(false);
});
