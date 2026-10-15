import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ files: new Map<string, string>(), command: vi.fn(), create: vi.fn(), onboard: vi.fn(), route: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<object>(), execFileSync: state.command }));
vi.mock("node:fs", async original => ({ ...await original<object>(), lstatSync: () => ({ isDirectory: () => true, isFile: () => true, nlink: 1 }), readdirSync: () => [], readFileSync: () => "[core]\n bare = false\n", existsSync: (p: string) => state.files.has(p), mkdirSync: (p: string) => state.files.set(p, "DIR"), writeFileSync: (p: string, data: string) => state.files.set(p, data) }));
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: state.command }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: vi.fn() }));
// The imported project-control composition reads the real job readers at load; only creation is the fixture.
vi.mock("../codex-goal-jobs", async original => ({
  ...await original<typeof import("../codex-goal-jobs")>(),
  createCodexGoalJob: state.create,
}));
vi.mock("../hosted-mimo-project-bridge-onboard", () => ({ onboardHostedMimoProject: state.onboard }));
vi.mock("../hosted-mimo-project-bridge", () => ({ hostedMimoBridgeMetadataBytes: (p: string) => { const bytes = state.files.get(p); if (bytes === undefined) throw new Error("TEST mandatory file missing"); return Buffer.from(bytes); },
  assertHostedMimoProjectRouteOpen: state.route, parseHostedMimoProjectBinding: (value: unknown) => value }));
vi.mock("../application/project-control/worker-launch-spec", async original => ({ ...await original<object>(), workerLaunchAdmissionSchema: { parse: (v: unknown) => v } }));
import { prepareHostedMimoProject, parseHostedMimoPreparationPlan } from "../hosted-mimo-project-bridge-prepare";
const sha = "a".repeat(40), source = "/srv/reviewed-snapshots/test-source", stateRoot = "/srv/worker-state/mimo-projects/test-project/test-work", scratch = "/srv/workers/mimo-projects/test-project/test-work";
const binding = { schemaVersion: 1, projectId: "test-project", workstreamId: "test-work", machineId: "b".repeat(32), sourceCommit: sha, sourceRef: "origin/main", stateRoot, scratchRoot: scratch, sourceWorkspacePath: scratch + "/source", registryRootDir: stateRoot + "/registry", controllerJobId: "test-controller",
  admission: { mode: "serial-builtin", contract: { canonicalSha: sha, baseSha: sha, phaseStartSha: sha, controllerPacket: "controller.md", lanePacket: "lane.md", mandatoryDocs: ["doc.md"], mandatoryScripts: [], mandatoryFixtures: [], executionPolicy: { sandboxRoot: scratch + "/source/sandbox" } } } };
const plan = { schemaVersion: 1, binding, sourceSnapshotPath: source, repositoryKey: "runtime", repositoryUrl: "https://github.com/example/project.git", workerJobPrefix: "test-worker-", authRootDir: "/srv/worker-state/account-pools/auth", commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" } };
beforeEach(() => { state.files.clear(); vi.clearAllMocks(); state.route.mockReset(); state.onboard.mockResolvedValue({ ok: true });
  state.files.set("/etc/subscription-runtime/TEST-plan.json", JSON.stringify(plan)); state.files.set("/etc/machine-id", binding.machineId);
  state.files.set("/etc/subscription-runtime/projects/test-project.d/test-work.yml", `repositories:\n  runtime:\n    url: "${plan.repositoryUrl}"\n    branch: "main"\n    exact_head: "${sha}"\n`);
  for (const file of ["controller.md", "lane.md", "doc.md"]) state.files.set(source + "/" + file, "TEST reviewed packet");
  state.command.mockImplementation((_exe: string, args: string[]) => args.includes("get-url") ? plan.repositoryUrl : args.includes("rev-parse") ? sha : args.includes("ls-files") ? args.at(-1)!.endsWith("/") ? args.at(-1) + ".keep" : args.at(-1) : "");
});
it("prepares fresh isolated roots/controller from reviewed source without provider launch", async () => {
  await expect(prepareHostedMimoProject("/etc/subscription-runtime/TEST-plan.json")).resolves.toEqual({ ok: true, workerJobPrefix: plan.workerJobPrefix });
  expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ registryRootDir: binding.registryRootDir, overwrite: false,
    manifest: expect.objectContaining({ projectAccessScope: expect.objectContaining({ allowedAccountIds: ["account-q"], workspaceRoots: [scratch] }) }) }));
  expect(state.command.mock.calls.every(([exe]) => exe === "/usr/bin/git")).toBe(true);
  expect(state.command.mock.calls.find(([, args]) => args.includes("clone"))?.[1]).toEqual(expect.arrayContaining(["clone", "--no-hardlinks", "--no-local", "--", source, binding.sourceWorkspacePath]));
  await expect(prepareHostedMimoProject("/etc/subscription-runtime/TEST-plan.json")).rejects.toThrow("mimo_project_bridge_prepare_already_exists");
});
it.each(["route", "repository", "packet", "dirty", "head"])("refuses %s failure before creating any roots/controller", async fault => {
  if (fault === "route") state.route.mockImplementation(() => { throw new Error("TEST disabled route"); });
  if (fault === "repository") state.files.set("/etc/subscription-runtime/projects/test-project.d/test-work.yml", "repositories:\n  runtime:\n    url: https://github.com/foreign/repo\n");
  if (fault === "packet") state.files.delete(source + "/doc.md");
  if (fault === "dirty") state.command.mockImplementation((_exe: string, args: string[]) => args.includes("get-url") ? plan.repositoryUrl : args.includes("rev-parse") ? sha : " M doc.md");
  if (fault === "head") state.command.mockReturnValue("c".repeat(40));
  await expect(prepareHostedMimoProject("/etc/subscription-runtime/TEST-plan.json")).rejects.toThrow();
  expect(state.files.has(stateRoot)).toBe(false); expect(state.create).not.toHaveBeenCalled(); expect(state.onboard).not.toHaveBeenCalled();
});
it.each([{ ...plan, argv: ["sh"] }, { ...plan, repositoryUrl: "https://user:secret@github.com/example/repo" }, { ...plan, authRootDir: scratch + "/auth" }])("rejects nonclosed or overlapping operator data", value => {
  expect(() => parseHostedMimoPreparationPlan(value)).toThrow();
});
it("retains partial preparation and refuses replay after a clone outcome failure", async () => {
  state.command.mockImplementation((_exe: string, args: string[]) => {
    if (args.includes("clone")) throw new Error("TEST clone outcome unknown");
    return args.includes("get-url") ? plan.repositoryUrl : args.includes("rev-parse") ? sha : args.includes("ls-files") ? args.at(-1)!.endsWith("/") ? args.at(-1) + ".keep" : args.at(-1) : "";
  });
  await expect(prepareHostedMimoProject("/etc/subscription-runtime/TEST-plan.json")).rejects.toThrow("TEST clone outcome unknown");
  expect(state.files.has(stateRoot + "/preparation.json")).toBe(true);
  await expect(prepareHostedMimoProject("/etc/subscription-runtime/TEST-plan.json")).rejects.toThrow("mimo_project_bridge_prepare_already_exists");
  expect(state.command.mock.calls.filter(([, args]) => args.includes("clone"))).toHaveLength(1);
  expect(state.create).not.toHaveBeenCalled();
});
it("refuses non-owner commit identity", () => {
  expect(() => parseHostedMimoPreparationPlan({ ...plan, commitIdentity: { name: "other", email: "other@example.com" } })).toThrow("mimo_project_bridge_prepare_plan_invalid");
});
