import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { renderMimoAttachment } from "../hosted-mimo-project-attachment";
import { renderMimoAttachmentFromFile } from "../hosted-mimo-project-attachment-file";
import { genericMimoAdmission, hasPinnedRequiredCheck } from "../hosted-mimo-project-admission";
import { parseMimoProjectClientRoutes } from "../mimo-project-bridge-client";

const commit = "a".repeat(40);
const card = { projectId: "test-project", repositoryUrl: "https://github.com/example/test-repo.git", branch: "main", commit,
  sandboxSubdir: "sandbox", ownedPaths: ["src/", "docs/", "README.md"],
  taskTimeoutMs: 14400000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, diskPeak: { scratch: 21474836480, durable: 2147483648 },
  host: { alias: "test-host", machineId: "b".repeat(32), socketDir: "/private/tmp/subscription-runtime-ssh", authRootDir: "/srv/worker-state/account-pools/auth", codexBinaryPath: "/opt/codex/bin/codex" } };

it("renders the reviewed files for a short card (golden)", () => {
  const out = renderMimoAttachment(card);
  expect(out.workstreamYaml).toEqual({ path: "/etc/subscription-runtime/projects/test-project.d/main.yml", content: `---
schema_version: 1
project_id: "test-project"
workstream_id: "main"
service_tier: "default"
routing_enabled: true
heavy_lock_path: "/run/lock/hosted-v1-heavy.lock"
state_root: "/srv/worker-state/jobs/test-project/main"
quarantine_root: "/srv/worker-state/quarantine/test-project/main"
scratch_root: "/srv/workers/jobs/test-project/main"
repositories:
  source:
    branch: "main"
    exact_head: "${commit}"
    url: "https://github.com/example/test-repo.git"
` });
  expect(JSON.parse(out.preparationPlan.content)).toEqual({ schemaVersion: 1, sourceSnapshotPath: "/srv/workers/mimo-project-snapshots/test-project/main/source",
    repositoryKey: "source", repositoryUrl: card.repositoryUrl, workerJobPrefix: "test-project-main-job-", authRootDir: card.host.authRootDir,
    commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" },
    binding: { schemaVersion: 1, projectId: "test-project", workstreamId: "main", machineId: card.host.machineId, routingEnabled: true,
      stateRoot: "/srv/worker-state/mimo-projects/test-project/main", scratchRoot: "/srv/workers/mimo-projects/test-project/main",
      registryRootDir: "/srv/worker-state/mimo-projects/test-project/main/registry", controllerJobId: "test-project-main-controller",
      sourceWorkspacePath: "/srv/workers/mimo-projects/test-project/main/source", sourceCommit: commit, sourceRef: "origin/main",
      codexBinaryPath: card.host.codexBinaryPath, taskTimeoutMs: 14400000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000,
      admission: { mode: "serial-builtin", contract: { kind: "worker-launch", format: 1, canonicalSha: commit, baseSha: commit, phaseStartSha: commit,
        packetRevision: "generic-r1", controllerPacket: "AGENTS.md", lanePacket: "AGENTS.md", phaseId: "phase-01", laneId: "generic", inputPatchHash: null,
        reviewKind: "implementation", ownedPaths: ["src/", "docs/", "README.md"], mandatoryDocs: ["AGENTS.md"], mandatoryScripts: [], mandatoryFixtures: [],
        requiredChecks: [{ id: "tree", cwd: "sandbox", command: "git status --short" }],
        executionPolicy: { mode: "sandbox-only", sandboxRoot: "/srv/workers/mimo-projects/test-project/main/source/sandbox", forbiddenRealProjects: ["/srv/workers/jobs"] } } } } });
  expect(parseMimoProjectClientRoutes(JSON.parse(out.localRoute.content))).toEqual([{ projectId: "test-project", workstreamId: "main", host: "test-host", machineId: card.host.machineId, socketDir: card.host.socketDir }]);
  expect(out.preparationPlan.path).toBe("/etc/subscription-runtime/reviewed-mimo-preparation-test-project.main.json");
  expect(out.diskPeak).toMatchObject({ scratchBytes: 21474836480, durableBytes: 2147483648 });
  expect(out.snapshot.commands).toContain(`git -C '/home/<operator>/mimo-staging/test-project.main' checkout --detach ${commit}`);
  expect(out.derivedDefaults.map(row => row.field)).toEqual(["workstreamId", "packet", "jobIdPrefix",
    "repositoryKey", "controllerJobId", "commitIdentity", "service_tier", "heavy_lock_path"]);
});
it("emits no SHA or digest in requiredChecks and keeps explicit card values out of the defaults list", () => {
  const out = renderMimoAttachment({ ...card, workstreamId: "docs", packet: "README.md", jobIdPrefix: "tp-docs-", taskTimeoutMs: 1200000 });
  const plan = JSON.parse(out.preparationPlan.content);
  expect(hasPinnedRequiredCheck(plan.binding.admission.contract.requiredChecks)).toBe(false);
  expect(plan.binding.admission.contract.mandatoryDocs).toEqual(["README.md"]);
  expect(plan.workerJobPrefix).toBe("tp-docs-"); expect(plan.binding.taskTimeoutMs).toBe(1200000);
  expect(out.derivedDefaults.map(row => row.field)).not.toEqual(expect.arrayContaining(["workstreamId", "packet", "jobIdPrefix", "taskTimeoutMs"]));
});
it.each([
  ["unknown key", { ...card, peakBytes: 1 }],
  ["dotted project id", { ...card, projectId: "test.project" }],
  ["underscore workstream id", { ...card, workstreamId: "main_line" }],
  ["ssh repository url", { ...card, repositoryUrl: "git@github.com:example/test-repo.git" }],
  ["url without .git", { ...card, repositoryUrl: "https://github.com/example/test-repo" }],
  ["short commit", { ...card, commit: "abc123" }],
  ["absolute owned path", { ...card, ownedPaths: ["/etc/"] }],
  ["escaping sandbox", { ...card, sandboxSubdir: "../x" }],
  ["controller-prefix overlap", { ...card, jobIdPrefix: "test-project-main-" }],
  ["bad machine id", { ...card, host: { ...card.host, machineId: "123" } }],
  ["long host alias", { ...card, host: { ...card.host, alias: "a".repeat(64) } }],
  ["glob in owned paths", { ...card, ownedPaths: ["src/*"] }],
  ["control character in owned paths", { ...card, ownedPaths: ["src/\u0007"] }],
  ["missing task timeout", { ...card, taskTimeoutMs: undefined }],
  ["missing disk peak", { ...card, diskPeak: undefined }],
  ["zero disk peak", { ...card, diskPeak: { scratch: 0, durable: 1 } }],
])("refuses a card with %s", (_name, value) => {
  expect(() => renderMimoAttachment(value)).toThrow("mimo_project_bridge_render_card_invalid");
});
it("reads a card file and reports typed issues without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "TEST-attach-")); afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json"), bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(card)); writeFileSync(bad, JSON.stringify({ ...card, commit: "x" }));
  expect(renderMimoAttachmentFromFile(good)).toMatchObject({ ok: true });
  expect(renderMimoAttachmentFromFile(bad)).toMatchObject({ ok: false, error: "mimo_project_bridge_render_card_invalid", issues: [expect.stringContaining("commit")] });
  expect(renderMimoAttachmentFromFile(join(dir, "missing.json"))).toMatchObject({ ok: false });
});

const docs = readFileSync(fileURLToPath(new URL("../../../docs/hosted-mimo-project-workers.md", import.meta.url)), "utf8");
const jsonBlock = (heading: string) => JSON.parse(docs.slice(docs.indexOf(heading)).split("```json\n")[1]!.split("\n```")[0]!);
it("keeps the docs admission template equal to the builder output", () => {
  const template = jsonBlock("### Generic admission template");
  const sandbox = template.contract.requiredChecks[0].cwd;
  expect(genericMimoAdmission({ sourceCommit: "<sourceCommit>", packet: "AGENTS.md", ownedPaths: template.contract.ownedPaths, sandboxSubdir: sandbox, scratchRoot: "<scratchRoot>" })).toEqual(template);
});
it("renders the card example from the docs", () => {
  expect(renderMimoAttachment(jsonBlock("### Rendering an attachment from a card"))).toMatchObject({ workstreamYaml: { path: "/etc/subscription-runtime/projects/my-project.d/main.yml" } });
});
it("rejects a card file that is a symlink, a directory or invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "TEST-attach-")); afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json"), link = join(dir, "link.json"), junk = join(dir, "junk.json");
  writeFileSync(good, JSON.stringify(card)); symlinkSync(good, link); writeFileSync(junk, "{");
  for (const path of [link, dir, junk]) expect(renderMimoAttachmentFromFile(path)).toMatchObject({ ok: false, error: "mimo_project_bridge_render_card_invalid" });
  writeFileSync(join(dir, "big.json"), " ".repeat(70000));
  expect(renderMimoAttachmentFromFile(join(dir, "big.json"))).toMatchObject({ ok: false });
});
