import { HostedInventoryCategory, parseHostedInventoryV5, type HostedInventoryV5 } from "../host-infrastructure/host-inventory";

/**
 * TEST fixture builder shared by the successor tests: real V5 inventories through the real parser, so a case can only be
 * "congruent" or "not congruent" for reasons the production parser and congruence check actually evaluate.
 */
export const successorDigest = (c: string) => c.repeat(64);
export const SUCCESSOR_BOOT = "11111111-1111-1111-1111-111111111111";
export const SUCCESSOR_OLD_OPERATION = "11111111-1111-1111-1111-111111111111";
export const SUCCESSOR_NEW_OPERATION = "22222222-2222-2222-2222-222222222222";
export const SUCCESSOR_HOST = "d".repeat(32);

export type SuccessorInventoryInput = {
  supervisorUnit: string; birth: string; operationId: string; borrowed?: readonly string[];
  creator?: Partial<{ jobId: string; childSlotSha256: string; creatorId: string; rootBase: string }>; disabledCreators?: readonly string[]; bootId?: string; hostId?: string;
  tamper?: (units: Record<string, unknown>[]) => Record<string, unknown>[];
  /** The artifact's own runtime directory (the creator launch runs the CLI beneath it); predecessor and candidate differ, as real artifacts do. */
  runtimeDirectory?: string;
  /** Rewrites the creator launch AFTER it is built (the parser still requires `runtimeLaunch` to equal it, so it is applied to both). */
  launchTamper?: (launch: { command: string; args: string[]; cwd: string }) => { command: string; args: string[]; cwd: string };
};
export function successorInventory(input: SuccessorInventoryInput): HostedInventoryV5 {
  const names = [input.supervisorUnit, ...(input.borrowed ?? ["fixture-1.service", "fixture-2.service"])];
  const units: Record<string, unknown>[] = names.map((name, i) => ({ category: i === 0 ? HostedInventoryCategory.Supervisor : HostedInventoryCategory.Borrowed, name, aliases: [],
    controlGroup: `/${name}`, fragmentPath: `/fixture/${name}`, fragmentSha256: successorDigest("a"), dropIns: [], loadState: "loaded", activeState: i === 0 ? "active" : "inactive",
    unitFileState: "static", invocationId: i === 0 ? "c".repeat(32) : "", mainPidBirth: i === 0 ? input.birth : null, job: "", delegate: false as const }));
  const tampered = input.tamper ? input.tamper(units) : units;
  const jobId = input.creator?.jobId ?? "TEST-codec";
  const jobRootDir = `${input.creator?.rootBase ?? "/fixture"}/jobs/${jobId}`;
  const built = { command: "/fixture/node", args: [`${input.runtimeDirectory ?? "/fixture/runtime"}/dist/worker-codex/codex-goal-cli.js`, "tool", "codex_goal_project_start", "--args-json", "{}", "--json"], cwd: `${jobRootDir}/workspace` };
  const launch = input.launchTamper ? input.launchTamper(built) : built;
  return parseHostedInventoryV5({ schemaVersion: 5, hostId: input.hostId ?? SUCCESSOR_HOST, bootId: input.bootId ?? SUCCESSOR_BOOT, supervisorUnit: input.supervisorUnit, units: tampered,
    cgroups: [{ path: "", parent: null, ownerUnit: null, dev: "1", ino: "1", members: [] }, ...tampered.map((u, i) => ({ path: u.controlGroup, parent: "", ownerUnit: u.name,
      dev: "1", ino: String(i + 2 + (u.name === input.supervisorUnit ? 100 : 0)), members: i === 0 ? [{ birth: input.birth, controlGroup: u.controlGroup }] : [] }))],
    activators: [], supervisor: { birth: input.birth, executable: { path: "/fixture/node", sha256: successorDigest("e") }, bootstrap: { path: "/fixture/bootstrap.js", sha256: successorDigest("f") },
      operationId: input.operationId, workEndEpochMs: 1000, cleanupEndEpochMs: 2000 },
    ordinaryCreators: [{ creatorId: input.creator?.creatorId ?? "fixture-creator", jobId, jobRootDir, workspacePath: launch.cwd, launch,
      ...(input.creator?.childSlotSha256 ? { childSlotSha256: input.creator.childSlotSha256 } : {}) }],
    disabledCreators: input.disabledCreators ?? [], runtimeLaunch: launch, collectorProfile: { path: "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json", sha256: successorDigest("a") },
    systemBusInfrastructure: {} });
}
export const predecessorInventory = (over: Partial<SuccessorInventoryInput> = {}) =>
  successorInventory({ supervisorUnit: "subscription-runtime-installation-old.service", birth: "100:200", operationId: SUCCESSOR_OLD_OPERATION, runtimeDirectory: "/fixture/runtime-old", ...over });
export const candidateInventory = (over: Partial<SuccessorInventoryInput> = {}) =>
  successorInventory({ supervisorUnit: "subscription-runtime-installation-new.service", birth: "300:400", operationId: SUCCESSOR_NEW_OPERATION, runtimeDirectory: "/fixture/runtime-new", ...over });
