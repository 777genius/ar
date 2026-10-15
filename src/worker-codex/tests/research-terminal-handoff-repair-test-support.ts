import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { host, local } from "./research-launch-fixture";
import { researchCurrentStart, researchJobAuthority } from "../research-launch-admission";
import { repairOwnedMimoWorkerTerminalHandoff, finalizeOwnedMimoWorker } from "../research-launch-lifecycle";
import { researchRead, researchPublish } from "../research-launch-files";
import { prepareResearchJobWriterObservation } from "../research-writer-observation";
import { codexGoalJobManifestPath, readCodexGoalJob } from "../codex-goal-jobs";
import * as materialization from "../codex-goal-terminal-handoff-materialization";
import * as admission from "../research-launch-admission";
import * as runtimeArtifact from "../research-runtime-artifact";
import { researchArtifactDigest } from "../research-launch-files";
export { registeredStoppedBeforeProviderTests } from "./research-stopped-before-provider-test-support";

/** Runs inside the existing registered suite's genuinely constructed native
 * fixture. Only kernel PID disappearance is an explicit offline Host port. */
export function registeredTerminalRepairTests(input: {
  candidate(dirty?: boolean): Promise<ReturnType<typeof researchCurrentStart> & { jobId: string; startId: string; specSha256: string; unit: string }>;
  scope(): ProjectAccessScope; setScope(scope: ProjectAccessScope): void; registry(): string;
}): void {
  const identity = (current: Awaited<ReturnType<typeof input.candidate>>) => ({ jobId: current.jobId, startId: current.startId,
    specSha256: current.specSha256, requestSha256: current.spec.requestSha256 });
  async function cold() {
    const current = await input.candidate(true), historical = structuredClone(input.scope());
    input.setScope({ ...historical, allowedAccountIds: [...historical.allowedAccountIds!, "TEST-appended-account"] });
    host.units.get(current.unit)!.active = false;
    const stat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
      if (String(path) === `/proc/${process.pid}`) throw Object.assign(new Error("TEST original PID gone"), { code: "ENOENT" });
      return stat(path, options as fs.StatOptions & { bigint?: false });
    }) as typeof fs.lstatSync);
    return { current, historical };
  }
  describe("authenticated account-tail terminal repair", () => {
    it("preserves partial packet without Stop, keeps old binding, and exposes only its authenticated release", async () => {
      const { current, historical } = await cold(), original = researchRead(join(current.directory, "spec.json"));
      const producer = join(host.root, "TEST-qualified-current-producer");
      fs.cpSync(local("/TEST-artifact"), producer, { recursive: true });
      vi.spyOn(admission, "installedResearchRuntimeDirectory").mockReturnValue(producer);
      vi.mocked(runtimeArtifact.assertQualifiedResearchRuntimeArtifact).mockImplementation((directory, hash) => {
        expect(["/TEST-artifact", producer]).toContain(directory); expect(researchArtifactDigest(directory)).toBe(hash);
      });
      const activePath = join(researchJobAuthority(current.jobId), "active.json"), active = researchRead(activePath);
      const manifest = await readCodexGoalJob({ registryRootDir: input.registry(), jobId: current.jobId });
      await expect(finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).rejects.toThrow();
      const calls = host.calls.length;
      expect(await repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).toMatchObject({ status: "partial" });
      expect(host.calls.slice(calls).some(call => ["stop", "kill"].includes(call.args[0] ?? ""))).toBe(false);
      expect(researchRead(join(current.directory, "spec.json"))).toEqual(original);
      const reader = await prepareResearchJobWriterObservation(manifest);
      expect(await reader()).toEqual({ status: "released" });
      const originalModel = manifest.model; Object.assign(manifest, { model: "TEST-contradictory-caller" });
      expect(await reader()).toEqual({ status: "unknown" });
      if (originalModel === undefined) Reflect.deleteProperty(manifest, "model"); else Object.assign(manifest, { model: originalModel });
      const publication = JSON.parse(researchRead(join(current.directory, "mimo-publication.json")).toString());
      const patch = publication.result.artifacts.find((item: { kind: string }) => item.kind === "handoff_worktree").path;
      const packetBytes = fs.readFileSync(patch); fs.appendFileSync(patch, "TEST drift\n");
      expect(await reader()).toEqual({ status: "unknown" }); fs.writeFileSync(patch, packetBytes);
      for (const name of ["status.porcelain-v2.z", "untracked.paths.z", "quarantine.json"]) {
        const path = join(publication.result.details.handoffPacketPath, name), bytes = fs.readFileSync(path);
        fs.appendFileSync(path, "TEST hidden member drift"); expect(await reader()).toEqual({ status: "unknown" });
        fs.unlinkSync(path); expect(await reader()).toEqual({ status: "unknown" });
        fs.writeFileSync(path, bytes, { mode: 0o600 }); expect(await reader()).toEqual({ status: "released" });
      }
      fs.writeFileSync(local(activePath), active, { mode: 0o600 });
      expect(await reader()).toEqual({ status: "unknown" }); fs.unlinkSync(local(activePath));
      const laterStart = join(researchJobAuthority(current.jobId), "starts", "22222222-2222-4222-8222-222222222222");
      fs.mkdirSync(local(laterStart), { mode: 0o700 });
      expect(await reader()).toEqual({ status: "unknown" }); fs.rmdirSync(local(laterStart));
      expect(await reader()).toEqual({ status: "released" });
      expect(await (await prepareResearchJobWriterObservation({ ...manifest, taskId: "TEST-contradiction" }))()).toEqual({ status: "unknown" });
      const receipt = join(current.directory, "terminal-handoff-repair.json");
      const retained = researchRead(receipt); researchPublish(receipt, { invalid: true });
      expect(await reader()).toEqual({ status: "unknown" });
      fs.writeFileSync(local(receipt), retained, { mode: 0o600 });
      expect(await repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).toMatchObject({ status: "partial" });
      expect(researchRead(receipt)).toEqual(retained);
      const grantPath = join(researchJobAuthority(current.jobId), "grant.json");
      const grant = JSON.parse(researchRead(grantPath).toString()); researchPublish(grantPath,
        { ...grant, grantId: "33333333-3333-4333-8333-333333333333" });
      expect(await reader()).toEqual({ status: "unknown" });
    });
    it.each(["historical", "revoked", "receipt", "live", "queued"] as const)("refuses %s before publication/release", async fault => {
      const { current, historical } = await cold();
      const candidateScope = fault === "historical" ? { ...historical, allowedAccountIds: ["TEST-wrong"] } : historical;
      if (fault === "revoked") input.setScope({ ...input.scope(), workspaceRoots: [] });
      if (fault === "receipt") {
        const manifest = await readCodexGoalJob({ registryRootDir: input.registry(), jobId: current.jobId });
        researchPublish(manifest.projectPreStartAdmission!.receiptPath, { status: "revoked" });
      }
      if (fault === "live") host.units.get(current.unit)!.active = true;
      if (fault === "queued") host.jobs.add(current.unit);
      await expect(repairOwnedMimoWorkerTerminalHandoff(identity(current), candidateScope)).rejects.toThrow();
      expect(researchCurrentStart(current.jobId).bytes).toEqual(current.bytes);
      expect(fs.existsSync(local(join(current.directory, "mimo-publication.json")))).toBe(false);
    });
    it.each(["cold", "live", "owner-missing", "descendant", "events-missing"] as const)("requires original provider %s closure", async fault => {
      const { current, historical } = await cold();
      const unit = "subscription-runtime-research-provider-11111111-1111-4111-8111-111111111111.service";
      const description = `subscription-runtime-research-provider:${current.startId}:${unit}`, group = "/sys/fs/cgroup/system.slice/" + unit;
      const owner = JSON.parse(researchRead(join(current.directory, "binding.json")).toString());
      const record = { schemaVersion: 1, process: { ...owner.process, controlGroup: "/system.slice/" + unit },
        service: { ...owner.service, unit, controlGroup: "/system.slice/" + unit, description } };
      researchPublish(join(current.directory, "providers", unit + ".json"), { schemaVersion: 1, unit,
        runtimeUnit: current.unit, specSha256: current.specSha256, description });
      if (fault !== "owner-missing") researchPublish(join(current.directory, "providers", unit + ".owner.json"), record);
      if (fault === "live") host.units.set(unit, { pid: process.pid, invocation: record.service.invocationId, active: true, description });
      if (fault === "descendant" || fault === "events-missing") {
        host.scratchNodes.set(group, fs.lstatSync(current.directory));
        const read = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
          if (String(path) === group + "/cgroup.events") {
            if (fault === "events-missing") throw Object.assign(new Error("TEST missing events"), { code: "ENOENT" });
            return "populated 1\nfrozen 0\n";
          }
          return read(path, options as BufferEncoding);
        }) as typeof fs.readFileSync);
      }
      if (fault === "cold") expect(await repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).toMatchObject({ status: "partial" });
      else {
        await expect(repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).rejects.toThrow();
        expect(researchCurrentStart(current.jobId).bytes).toEqual(current.bytes);
      }
    });
    it("retains the writer if an unlisted packet member changes after preservation but before release", async () => {
      const { current, historical } = await cold();
      const capture = materialization.materializeReconciledTerminalCodexGoalHandoff;
      vi.spyOn(materialization, "materializeReconciledTerminalCodexGoalHandoff").mockImplementationOnce(async input => {
        const result = await capture(input);
        fs.appendFileSync(join(result.handoff!.packetPath!, "quarantine.json"), "TEST drift");
        return result;
      });
      await expect(repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).rejects.toThrow();
      expect(researchCurrentStart(current.jobId).bytes).toEqual(current.bytes);
      expect(fs.existsSync(local(join(current.directory, "terminal-handoff-repair.json")))).toBe(false);
    });
    it("retains incomplete intent through a post-release crash, then completes the same publication", async () => {
      const { current, historical } = await cold();
      const manifest = await readCodexGoalJob({ registryRootDir: input.registry(), jobId: current.jobId });
      const rename = fs.renameSync, receipt = join(current.directory, "terminal-handoff-repair.json");
      const denied = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === receipt) throw new Error("TEST receipt publication crash");
        return rename(from, to);
      });
      await expect(repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).rejects.toThrow("TEST receipt publication crash");
      expect(fs.existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(false);
      expect(await (await prepareResearchJobWriterObservation(manifest))()).toEqual({ status: "unknown" });
      const publication = researchRead(join(current.directory, "mimo-publication.json"));
      denied.mockRestore();
      expect(await repairOwnedMimoWorkerTerminalHandoff(identity(current), historical)).toMatchObject({ status: "partial" });
      expect(researchRead(join(current.directory, "mimo-publication.json"))).toEqual(publication);
      const reader = await prepareResearchJobWriterObservation(manifest);
      expect(await reader()).toEqual({ status: "released" });
      const controller = codexGoalJobManifestPath({ registryRootDir: input.registry(), jobId: "TEST-controller" });
      researchPublish(controller, { TEST: "controller bytes drift" });
      expect(await reader()).toEqual({ status: "unknown" });
    });
  });
}
