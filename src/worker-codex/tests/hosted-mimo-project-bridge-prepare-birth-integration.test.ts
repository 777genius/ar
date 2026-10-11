import { host, setupResearchFixture, cleanupResearchFixture, researchScratchBackingPath } from "./research-launch-fixture";
import { AsyncResource } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareHostedMimoProject } from "../hosted-mimo-project-bridge-prepare";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth } from "../protected-job-birth";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";
import { withProjectAdmissionPublicationLock } from "../codex-goal-project-workspace-lock";
import { recordRawGoalStateOrigin } from "../application/project-control/codex-goal-controller-state-location";

const nativeProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
beforeEach(() => {
  setupResearchFixture({ offlineGit: true });
  // /srv must never fall through to the real Host filesystem.
  mkdirSync("/TEST-project/srv", { mode: 0o700 });
  host.pins.set("/srv", "/TEST-project/srv");
  host.spawn.mockImplementation(() => { throw new Error("TEST prepare must not launch a runtime"); });
});
afterEach(cleanupResearchFixture);

function file(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
}

// RED: writing the controller prompt before controlled birth makes its root
// already exist. The real readers then report unknown instead of released.
it.skipIf(process.platform !== "linux")("prepares a never-started MiMo controller with protected writer release", async () => {
  const snapshot = "/srv/reviewed/test-source";
  const stateRoot = "/srv/worker-state/mimo-projects/test-project/test-work";
  const scratchRoot = "/srv/workers/mimo-projects/test-project/test-work";
  const registryRootDir = stateRoot + "/registry", controllerJobId = "test-controller";
  const sourceWorkspacePath = scratchRoot + "/source";
  const repositoryUrl = "https://github.com/example/project.git", machineId = "b".repeat(32);
  for (const directory of [snapshot, "/srv/workers", "/srv/worker-state/account-pools/auth"])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backing = researchScratchBackingPath(snapshot);
  if (!backing) throw new Error("Expected allocated TEST source backing");
  const git = (...args: string[]): string => nativeProcess.execFileSync("/usr/bin/git", ["-C", backing,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  git("init"); git("config", "user.name", "iliya"); git("config", "user.email", "iliyazelenkog@gmail.com");
  git("remote", "add", "origin", repositoryUrl);
  for (const path of ["controller.md", "lane.md", "doc.md", "sandbox/.keep"]) file(snapshot + "/" + path, "TEST reviewed proof\n");
  git("add", "."); git("commit", "-m", "test: isolated prepare birth fixture");
  const sha = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", sha);
  file("/etc/machine-id", machineId);
  file("/etc/subscription-runtime/projects/test-project.d/test-work.yml", `project_id: test-project\nworkstream_id: test-work\nstate_root: /srv/worker-state/jobs/test-project/test-work\nscratch_root: /srv/workers/jobs/test-project/test-work\nrouting_enabled: true\nrepositories:\n  runtime:\n    url: "${repositoryUrl}"\n    branch: main\n    exact_head: "${sha}"\n`);
  file("/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js", "TEST executable");
  const admission = { mode: "serial-builtin", contract: { kind: "worker-launch", format: 1, canonicalSha: sha,
    baseSha: sha, phaseStartSha: sha, packetRevision: "test-r1", controllerPacket: "controller.md", lanePacket: "lane.md",
    phaseId: "phase-01", laneId: "test-lane", inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["sandbox"],
    mandatoryDocs: ["controller.md", "lane.md", "doc.md"], mandatoryScripts: [], mandatoryFixtures: [],
    requiredChecks: [{ id: "test-check", cwd: "sandbox", command: "true" }],
    executionPolicy: { mode: "sandbox-only", sandboxRoot: sourceWorkspacePath + "/sandbox", forbiddenRealProjects: ["/srv/workers/jobs"] } } };
  const binding = { schemaVersion: 1, projectId: "test-project", workstreamId: "test-work", machineId, routingEnabled: true,
    stateRoot, scratchRoot, registryRootDir, controllerJobId, sourceWorkspacePath, sourceCommit: sha, sourceRef: "origin/main",
    codexBinaryPath: "/usr/bin/TEST-codex", taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission };
  const planPath = "/etc/subscription-runtime/TEST-prepare-birth-plan.json";
  file(planPath, JSON.stringify({ schemaVersion: 1, binding, sourceSnapshotPath: snapshot, repositoryKey: "runtime", repositoryUrl,
    workerJobPrefix: "test-worker-", authRootDir: "/srv/worker-state/account-pools/auth", commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" } }));

  await expect(prepareHostedMimoProject(planPath)).resolves.toMatchObject({ ok: true, sourceCommit: sha });
  const controller = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
  expect(readFileSync(controller.promptPath, "utf8")).toBe("Operator-owned MiMo project controller. Never launch this controller.\n");
  expect(JSON.parse(readFileSync("/etc/subscription-runtime/mimo-projects/test-project/test-work.json", "utf8"))).toMatchObject(binding);
  const outsider = new AsyncResource("TEST-prepare-independent-first-effect");
  try {
    await withProjectAdmissionPublicationLock({ registryRootDir, owner: "TEST-prepare-census", effect: async () => {
      expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "released" });
      expect(await observeResearchJobWriterAuthority(controller)).toEqual({ status: "released" });
      expect(() => outsider.runInAsyncScope(() => recordRawGoalStateOrigin(controller.jobRootDir)))
        .toThrow("protected_job_birth_publication_busy");
    } });
  } finally { outsider.emitDestroy(); }
  expect(host.spawn).not.toHaveBeenCalled();
  expect(host.calls.some(call => call.command === "/usr/bin/systemd-run")).toBe(false);
  expect(host.authReads).toBe(0);
});
