import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tree: new Map<string, string[]>(), awaiting: new Set<string>(), pending: new Map<string, { startId: string; candidateSha256: string; runtimeDirectory: string }>(),
  ops: new Map<string, { state: string; result?: unknown; entry?: string; cold?: boolean }>(), binding: new Set<string>(), observed: 0,
  closure: new Map<string, string>(), badCustody: new Set<string>(), notDirectory: new Set<string>(), awaitingCalls: 0,
}));
const root = "/etc/subscription-runtime/mimo-projects";
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  existsSync: (path: string) => state.tree.has(path),
  readdirSync: (path: string) => { if (state.notDirectory.has(path)) throw Object.assign(new Error("TEST private ENOTDIR /srv/x"), { code: "ENOTDIR" }); return state.tree.get(path) ?? []; } }));
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn() }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(),
  researchCustody: (path: string) => { if ([...state.badCustody].some(prefix => path.startsWith(prefix))) throw new Error("TEST private custody /srv/x"); } }));
vi.mock("../hosted-mimo-project-bridge", () => ({
  hostedMimoBridgeMetadataBytes: (path: string) => Buffer.from(path === "/etc/machine-id" ? "a".repeat(32) : "{}"),
  parseHostedMimoProjectBinding: (_value: unknown, request: { projectId: string; workstreamId: string }) => {
    if (state.binding.has(`${request.projectId}/${request.workstreamId}`)) throw new Error("TEST private binding path /srv/x");
    return { stateRoot: `/srv/worker-state/mimo-projects/${request.projectId}/${request.workstreamId}` };
  } }));
vi.mock("../hosted-mimo-project-workstream-fence", async original => ({ ...await original<object>(),
  observeHostedMimoWorkstreamClosure: (stateRoot: string) => state.closure.get(stateRoot) }));
const key = (request: { jobId: string; operation: string }) => `${request.jobId}.${request.operation}`;
vi.mock("../hosted-mimo-project-bridge-operation", async original => ({ ...await original<object>(),
  observeHostedMimoProjectOperation: (request: { jobId: string; operation: string }) => { state.observed++; return state.ops.get(key(request)) ?? { state: "absent" }; },
  hostedMimoProjectOperationCold: (request: { jobId: string; operation: string }) => state.ops.get(key(request))?.cold === true,
  readHostedMimoProjectOperationOwner: (request: { jobId: string; operation: string }) => ({ value: { entry: state.ops.get(key(request))?.entry } }) }));
vi.mock("../research-launch-lifecycle", () => ({
  observeMimoCandidateAwaitingPublication: (jobId: string) => { state.awaitingCalls++; return state.awaiting.has(jobId) ? { directory: "/x" } : undefined; },
  observePendingMimoFinalization: (jobId: string) => state.pending.get(jobId) }));
import { HostedMimoPendingFinalizationUncertain as Uncertain, listHostedMimoPendingFinalization } from "../hosted-mimo-pending-finalization";

const sha = "c".repeat(64), release = "f".repeat(40), jobRelease = "e".repeat(40), startId = "0f0e0d0c-0b0a-4908-8706-000000000001";
const entry = (sha40: string) => `/opt/subscription-runtime/releases/${sha40}/dist/worker-codex/hosted-mimo-project-bridge-cli.js`;
const allOperations = ["create", "start", "status", "stop", "repair-admission", "finalize-admission-repair"];
const opsDir = (stream = "w") => `/srv/worker-state/mimo-projects/p/${stream}/mimo-bridge-operations`;
function job(jobId: string, over: { waiting?: boolean; operations?: string[]; stream?: string } = {}) {
  const dir = opsDir(over.stream), ops = state.tree.get(dir) ?? [];
  for (const operation of over.operations ?? ["create", "start", "status"]) ops.push(`${jobId}.${operation}.owner.json`, `${jobId}.${operation}.request.json`);
  state.tree.set(dir, ops);
  if (over.waiting !== false) {
    state.awaiting.add(jobId);
    state.pending.set(jobId, { startId, candidateSha256: sha, runtimeDirectory: `/opt/subscription-runtime/releases/${jobRelease}` });
  }
}
beforeEach(() => {
  for (const value of [state.tree, state.pending, state.ops, state.closure]) value.clear();
  for (const value of [state.awaiting, state.binding, state.badCustody, state.notDirectory]) value.clear();
  state.observed = 0; state.awaitingCalls = 0;
  state.tree.set(root, ["p"]); state.tree.set(`${root}/p`, ["w.json"]); state.tree.set(opsDir(), []);
});

describe("pending MiMo finalization listing", () => {
  it("lists a waiting candidate with the last Status failure, its closed cause and both releases", () => {
    job("job-a");
    state.ops.set("job-a.status", { state: "settled", entry: entry(release), result: { ok: false, error: "mimo_project_bridge_handoff_unavailable", cause: "handoff_sensitive_path_rejected" } });
    expect(listHostedMimoPendingFinalization()).toEqual({ ok: true, uncertain: [], pending: [{ projectId: "p", workstreamId: "w", jobId: "job-a",
      startId, candidateSha256: sha, jobRelease, error: "mimo_project_bridge_handoff_unavailable", cause: "handoff_sensitive_path_rejected", statusRelease: release }] });
  });
  it("lists a job that never had a Status with the job release only", () => {
    job("job-a");
    expect(listHostedMimoPendingFinalization().pending).toEqual([{ projectId: "p", workstreamId: "w", jobId: "job-a", startId, candidateSha256: sha, jobRelease }]);
  });
  // Systemd is asked only about jobs that pass the filesystem filter.
  it("makes no operation or unit observation for a finished job", () => {
    job("job-a", { waiting: false });
    expect(listHostedMimoPendingFinalization()).toEqual({ ok: true, pending: [], uncertain: [] });
    expect(state.awaitingCalls).toBe(1);
    expect(state.observed).toBe(0);
  });
  it.each(allOperations)("leaves out a job with a running %s and says why", operation => {
    job("job-a", { operations: allOperations });
    state.ops.set(`job-a.${operation}`, { state: "running" });
    expect(listHostedMimoPendingFinalization()).toEqual({ ok: true, pending: [], uncertain: [{ reason: Uncertain.OperationBusy, projectId: "p", workstreamId: "w", jobId: "job-a" }] });
  });
  // Ingress returns without scheduling for an unresolved repair, cold or not: the timer would otherwise run a no-op Status each tick.
  it.each(["repair-admission", "finalize-admission-repair"])("leaves out an unresolved %s even when its unit is cold", operation => {
    job("job-a", { operations: allOperations });
    state.ops.set(`job-a.${operation}`, { state: "unresolved", cold: true });
    expect(listHostedMimoPendingFinalization()).toMatchObject({ pending: [], uncertain: [{ reason: Uncertain.RepairUnresolved, jobId: "job-a" }] });
  });
  it("leaves out an unresolved Status whose unit is not cold, and lists one that is", () => {
    job("job-a");
    state.ops.set("job-a.status", { state: "unresolved", cold: false, entry: entry(release) });
    expect(listHostedMimoPendingFinalization()).toMatchObject({ pending: [], uncertain: [{ reason: Uncertain.OperationBusy }] });
    state.ops.set("job-a.status", { state: "unresolved", cold: true, entry: entry(release) });
    expect(listHostedMimoPendingFinalization().pending).toHaveLength(1);
  });
  it("does not list a candidate whose units are not inactive", () => {
    job("job-a");
    state.pending.delete("job-a");
    expect(listHostedMimoPendingFinalization()).toEqual({ ok: true, pending: [], uncertain: [] });
  });
  // The conditions under which ingress refuses the whole workstream; no job of it is examined.
  it.each(["recovery_pending", "retirement_pending", "maintenance_fence_active"])("leaves out a workstream with %s without examining its jobs", reason => {
    job("job-a");
    state.closure.set("/srv/worker-state/mimo-projects/p/w", reason);
    expect(listHostedMimoPendingFinalization()).toEqual({ ok: true, pending: [], uncertain: [{ reason, projectId: "p", workstreamId: "w" }] });
    expect(state.awaitingCalls).toBe(0);
  });
  it("lists the other workstreams when one has bad custody, a bad binding or is not a directory", () => {
    state.tree.set(`${root}/p`, ["bad-custody.json", "bad-binding.json", "good.json"]);
    for (const stream of ["bad-custody", "bad-binding", "good"]) state.tree.set(opsDir(stream), []);
    job("job-good", { stream: "good" }); job("job-x", { stream: "bad-custody" });
    state.badCustody.add(opsDir("bad-custody")); state.binding.add("p/bad-binding");
    state.tree.set(root, ["p", "stray", "q"]); state.tree.set(`${root}/q`, []); state.tree.set(`${root}/stray`, []); state.notDirectory.add(`${root}/stray`);
    const listing = listHostedMimoPendingFinalization();
    expect(listing.pending.map(row => row.jobId)).toEqual(["job-good"]);
    expect(listing.uncertain).toEqual(expect.arrayContaining([
      { reason: Uncertain.RecordUnreadable, projectId: "p", workstreamId: "bad-custody" },
      { reason: Uncertain.RecordUnreadable, projectId: "p", workstreamId: "bad-binding" },
      { reason: Uncertain.RecordUnreadable, projectId: "stray" }]));
    expect(JSON.stringify(listing)).not.toContain("TEST private");
  });
  it("copies no path or free text from a result, an owner or a binding", () => {
    job("job-a");
    state.ops.set("job-a.status", { state: "settled", entry: "/srv/TEST/private/hosted-mimo-project-bridge-cli.js",
      result: { ok: false, error: "TEST private /srv/path error", cause: "/srv/TEST/private cause", extra: "TEST private" } });
    expect(listHostedMimoPendingFinalization().pending[0]).toEqual({ projectId: "p", workstreamId: "w", jobId: "job-a", startId, candidateSha256: sha, jobRelease });
    state.ops.set("job-a.status", { state: "settled", entry: entry(release), result: { ok: false, error: "hosted_research_launch_denied", cause: "TEST private" } });
    expect(listHostedMimoPendingFinalization().pending[0]).toMatchObject({ error: "hosted_research_launch_denied", statusRelease: release });
    expect(listHostedMimoPendingFinalization().pending[0]).not.toHaveProperty("cause");
    state.pending.set("job-a", { startId, candidateSha256: sha, runtimeDirectory: "/srv/TEST/private" });
    expect(listHostedMimoPendingFinalization().pending[0]).not.toHaveProperty("jobRelease");
  });
});
