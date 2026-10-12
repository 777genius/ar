import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AccessBoundary, HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { ChildContinuationMode, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile } from "@vioxen/subscription-runtime/provider-codex";
const facts = vi.hoisted(() => ({ root: "", creators: [] as unknown[], phase: "CLOSED", directories: new Map<number, string>() }));
// Synthetic host ownership and procfs directory-FD lookup only; real private
// bytes, modes, links, inode comparisons and no-follow I/O remain observable.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const anchored = (path: string) => {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/([^/]+))?$/.exec(path);
    if (!match) return path;
    const parent = facts.directories.get(Number(match[1]));
    if (!parent || !parent.startsWith(facts.root + "/")) throw new Error("unplanned synthetic directory FD");
    return match[2] ? join(parent, match[2]) : parent;
  };
  return { ...fs,
    openSync: (path: string, flags: number, mode?: number) => {
      const local = anchored(path), fd = fs.openSync(local, flags, mode);
      if (fs.fstatSync(fd).isDirectory()) facts.directories.set(fd, local);
      return fd;
    },
    closeSync: (fd: number) => { facts.directories.delete(fd); fs.closeSync(fd); },
    statSync: (path: string) => {
      const match = /^\/proc\/self\/fd\/(\d+)$/.exec(path);
      if (!match) return fs.statSync(path);
      anchored(path); // Require an actually opened directory owned by this fixture.
      return fs.fstatSync(Number(match[1]));
    },
    lstatSync: (path: string) => {
      const stat = fs.lstatSync(path);
      const ancestor = facts.root.startsWith(path.endsWith("/") ? path : path + "/");
      return ancestor || path === facts.root || path.startsWith(facts.root + "/")
        ? Object.assign(stat, { uid: 0, mode: ancestor ? stat.mode & ~0o022 : stat.mode }) : stat;
    },
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: 0 }),
  };
});
vi.mock("../hosted-installation-activation", () => ({
  readHostedInstallationActivation: () => ({ activation: { phase: facts.phase }, installation: { runtimeSha: "b".repeat(40) } }),
  isHostedOrdinaryRuntime: () => false,
}));
vi.mock("../hosted-readonly-host-kernel", () => ({ readHostedReadonlyHostInventory: () => ({ ordinaryCreators: facts.creators }) }));
vi.mock("../hosted-readonly-custody", async original => ({
  ...await original<typeof import("../hosted-readonly-custody")>(), readonlySupervisorRoot: facts.root,
}));
vi.mock("../hosted-test-egress-files", async original => ({
  ...await original<typeof import("../hosted-test-egress-files")>(), hostedTestEgressGrantRoot: join(facts.root, "grants"),
}));
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/provider-codex")>(), assertHostedActivationFence: () => undefined,
}));

facts.root = realpathSync(mkdtempSync(join(tmpdir(), "pr3-TEST-slot-inventory-")));
for (const name of ["child-slots", "grants", "private-prompts"]) mkdirSync(join(facts.root, name), { mode: 0o700 });
const { enrollHostedChildSlot, readHostedChildSlot, childSlotName } = await import("../hosted-child-slot-files");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const jobId = "test-slot-child", jobRootDir = join(facts.root, "jobs", jobId), workspacePath = join(jobRootDir, "workspace");
  const promptPath = join(facts.root, "private-prompts", "slot-task.md");
  const grant = { schemaVersion: 3, jobId, jobRootDir, workspacePath, profileId: CodexProviderEgressProfileId.MimoTokenPlan,
    accountId: "account-s", hostedProfile: HostedMimoProfile.Child, slotId: "finite-slot-1", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    executionEngine: "app-server-goal", namedPermissions: true, globalScanGuard: true, nativeToolSurface: "disabled" };
  const grantBytes = Buffer.from(JSON.stringify(grant) + "\n");
  writeFileSync(join(facts.root, "grants", digest(jobId) + ".json"), grantBytes, { mode: 0o600 });
  const lifetime = parseChildLifetime({ schemaVersion: 1, accountId: "account-s", deadlineEpochMs: Date.now() + 60_000,
    maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: AccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile] });
  const launch = { command: process.execPath, cwd: workspacePath, args: ["/test/cli.js", "run", "--prompt", promptPath,
    "--workspace", workspacePath, "--job-root", jobRootDir, "--job-id", jobId, "--task-id", jobId,
    "--auth-root", join(jobRootDir, "capacity"), "--codex-binary", "/test/pinned-codex", "--accounts", "account-s", "--max-account-cycles", "1",
    "--max-attempts", "1", "--continuation-mode", "disabled", "--max-goal-turns", "2", "--child-lifetime-json", JSON.stringify(lifetime), "--execution-engine", "app-server-goal",
    "--model-backend", "xiaomi-mimo-token-plan", "--model", "mimo-v2.6-pro", "--access-boundary", "read_only",
    "--edit-mode", "read-only", "--project-access-scope-json", JSON.stringify({ projectId: jobId, readRoots: [workspacePath] })] };
  const slot = { schemaVersion: 1, slotId: "finite-slot-1", creatorId: "test-creator", jobId, jobRootDir, workspacePath, promptPath,
    sourceSha: "a".repeat(40), artifactSha: "b".repeat(40), grantSha256: digest(grantBytes), launch, lifetime };
  const bytes = Buffer.from(JSON.stringify(slot) + "\n");
  const creator = { creatorId: slot.creatorId, jobId, jobRootDir, workspacePath, launch, childSlotSha256: digest(bytes) };
  facts.creators = [creator];
  return { slot, bytes, creator, target: join(facts.root, "child-slots", childSlotName(slot.creatorId)) };
}
const fence = { held: true as const };
describe("finite slot private publication", () => {
  beforeEach(() => { facts.phase = HostedActivationPhase.Closed; rmSync(join(facts.root, "child-slots", childSlotName("test-creator")), { force: true }); });
  afterAll(() => rmSync(facts.root, { recursive: true, force: true }));
  // Bug: rename replacement silently changes an already accepted immutable child contract.
  it("publishes once and replays the exact original bytes", () => {
    const f = fixture();
    enrollHostedChildSlot(fence, f.bytes); enrollHostedChildSlot(fence, f.bytes);
    expect(readFileSync(f.target).equals(f.bytes)).toBe(true);
    expect(readHostedChildSlot(f.creator)?.lifetime.accountId).toBe("account-s");
    const conflicting = Buffer.from(JSON.stringify({ ...f.slot, sourceSha: "c".repeat(40) }) + "\n");
    expect(() => enrollHostedChildSlot(fence, conflicting)).toThrow("binding_invalid");
    expect(readFileSync(f.target).equals(f.bytes)).toBe(true);
  });
  // Bug: an ORDINARY installation accepts new enrollment or a partial private record is overwritten.
  it("denies ORDINARY writes and retains partial records for CLOSED reconciliation", () => {
    const f = fixture(); facts.phase = HostedActivationPhase.Ordinary;
    expect(() => enrollHostedChildSlot(fence, f.bytes)).toThrow("binding_invalid");
    facts.phase = HostedActivationPhase.Closed;
    writeFileSync(f.target, "partial", { mode: 0o600 });
    expect(() => enrollHostedChildSlot(fence, f.bytes)).toThrow("conflicting_enrollment");
    expect(() => readHostedChildSlot(f.creator)).toThrow("binding_invalid");
    expect(readFileSync(f.target, "utf8")).toBe("partial");
    expect(facts.phase).toBe(HostedActivationPhase.Closed);
  });
  // Bug: first publication follows an unsafe private directory before any retained record can validate it.
  it("rejects unsafe private ancestry before creating the first record", () => {
    const f = fixture(), directory = join(facts.root, "child-slots"); chmodSync(directory, 0o777);
    try {
      expect(() => enrollHostedChildSlot(fence, f.bytes)).toThrow();
      expect(() => readFileSync(f.target)).toThrow();
    } finally { chmodSync(directory, 0o700); }
  });
  // Bug: a source revision is used as a substitute for the enrolled artifact identity or grant/account.
  it.each([{ artifactSha: "a".repeat(40) }, { grantSha256: "0".repeat(64) }, { creatorId: "foreign-creator" }])("rejects mismatched immutable identities %j", change => {
    const f = fixture(), bytes = Buffer.from(JSON.stringify({ ...f.slot, ...change }) + "\n");
    facts.creators = [{ ...f.creator, childSlotSha256: digest(bytes) }];
    expect(() => enrollHostedChildSlot(fence, bytes)).toThrow();
  });
});
