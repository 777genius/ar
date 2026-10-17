import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, local } from "./research-launch-fixture";
import { researchCurrentStart, researchJobAuthority } from "../research-launch-admission";
import { finalizeOwnedMimoWorker, observeMimoCandidateAwaitingPublication, observePendingMimoFinalization } from "../research-launch-lifecycle";
import * as workspaceChanges from "../codex-goal-workspace-changes";
import * as changedFilesReport from "../codex-goal-changed-files-report";
import { researchRead, researchPublish, researchHash } from "../research-launch-files";
import { buildRuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";

/** A byte-level picture of a tree: names, sizes, modes and times. */
function snapshot(root: string): string[] {
  const rows: string[] = [];
  const walk = (path: string): void => {
    const stat = statSync(path);
    rows.push(`${path} ${stat.isDirectory() ? "d" : stat.size} ${stat.mode} ${stat.mtimeMs}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return rows;
}

/** Runs inside the registered suite's native fixture, with a real Git workspace and the real status reader. */
export function registeredChangedFilesTests(input: {
  candidate(dirty?: boolean): Promise<ReturnType<typeof researchCurrentStart> & { jobId: string; startId: string; specSha256: string }>;
}): void {
  describe("changed files of a finalized MiMo worker", () => {
    // Regression: a failed workspace scan was reported as the generic launch denial, hiding why finalization could not run.
    it.each(Object.values(changedFilesReport.WorkspaceChangedFilesWarning))("names the closed %s warning instead of denying launch admission", async warning => {
      const current = await input.candidate();
      vi.spyOn(workspaceChanges, "changedFilesFromWorkspace").mockResolvedValueOnce({ changedFiles: [], warning });
      await expect(finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).rejects.toThrow(new Error(`hosted_mimo_worker_changed_files_unavailable:${warning}`));
      expect(existsSync(local(join(current.directory, "mimo-publication.json")))).toBe(false);
      expect(existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(true);
    });

    describe("pending finalization selection", () => {
      it("selects a candidate without a publication whose units are inactive, and stops once it is published", async () => {
        const current = await input.candidate(true);
        // The fixture's runtime unit starts active; the runner has exited by the time a candidate waits.
        host.units.get((current as unknown as { unit: string }).unit)!.active = false;
        const authority = local(researchJobAuthority(current.jobId)), before = snapshot(authority);
        expect(observePendingMimoFinalization(current.jobId)).toEqual({ startId: current.startId, runtimeDirectory: current.spec.runtimeDirectory,
          candidateSha256: researchHash(researchRead(join(current.directory, "mimo-candidate.json"))) });
        expect(observeMimoCandidateAwaitingPublication(current.jobId)?.spec.startId).toBe(current.startId);
        // Read-only: no file of the job authority was created, changed or removed.
        expect(snapshot(authority)).toEqual(before);
        expect(existsSync(local(join(current.directory, "mimo-publication.json")))).toBe(false);
        await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256);
        expect(observePendingMimoFinalization(current.jobId)).toBeUndefined();
      });
      it("does not select a job with an active provider unit, and selects it again once that unit is cold", async () => {
        const current = await input.candidate(true);
        host.units.get((current as unknown as { unit: string }).unit)!.active = false;
        const unit = "subscription-runtime-research-provider-11111111-1111-4111-8111-111111111111.service";
        const description = `subscription-runtime-research-provider:${current.startId}:${unit}`;
        researchPublish(join(current.directory, "providers", unit + ".json"), { schemaVersion: 1, unit,
          runtimeUnit: (current as unknown as { unit: string }).unit, specSha256: current.specSha256, description });
        writeFileSync(local(`/run/systemd/transient/${unit}`), "TEST service fragment", { mode: 0o644 });
        host.units.set(unit, { pid: 4242, invocation: "a".repeat(32), active: true, description });
        // A live provider is either rejected as not selectable or refused as unverifiable (the listing counts that as uncertain); never selected.
        let selected: ReturnType<typeof observePendingMimoFinalization>;
        try { selected = observePendingMimoFinalization(current.jobId); } catch { selected = undefined; }
        expect(selected).toBeUndefined();
        host.units.get(unit)!.active = false;
        expect(observePendingMimoFinalization(current.jobId)?.startId).toBe(current.startId);
      });
      it("does not select a job whose runtime unit is active", async () => {
        const current = await input.candidate(true);
        host.units.get((current as unknown as { unit: string }).unit)!.active = true;
        expect(observePendingMimoFinalization(current.jobId)).toBeUndefined();
      });
      it("does not select a job without a candidate", async () => {
        const current = await input.candidate(true);
        host.units.get((current as unknown as { unit: string }).unit)!.active = false;
        const stored = readFileSync(local(join(current.directory, "mimo-candidate.json")));
        rmSync(local(join(current.directory, "mimo-candidate.json")));
        expect(observePendingMimoFinalization(current.jobId)).toBeUndefined();
        writeFileSync(local(join(current.directory, "mimo-candidate.json")), stored, { mode: 0o600 });
        expect(observePendingMimoFinalization(current.jobId)).toBeDefined();
      });
    });

    // The candidate describes its own list; the publication states the count and marker of the list it carries.
    it("does not carry a stale count or truncation marker from the candidate into a complete publication", async () => {
      const current = await input.candidate(true), candidatePath = join(current.directory, "mimo-candidate.json");
      const stored = JSON.parse(researchRead(candidatePath).toString());
      researchPublish(candidatePath, { ...stored, result: buildRuntimeResultEnvelope({ ...stored.result, updatedAt: new Date(stored.result.updatedAt),
        evidence: [...stored.result.evidence, changedFilesReport.changedFilesTruncatedEvidence], details: { ...stored.result.details, changedFilesCount: "99999" } }) });
      expect(await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).toMatchObject({ status: "partial" });
      const result = JSON.parse(researchRead(join(current.directory, "mimo-publication.json")).toString()).result;
      expect(result.changedFiles).toEqual(["proof.txt"]);
      expect(result.evidence).not.toContain(changedFilesReport.changedFilesTruncatedEvidence);
      expect(result.details?.changedFilesCount).toBeUndefined();
    });

    // Regression: a status listing above 1 MiB failed the scan, and a full path list above 1 MiB made the
    // publication unreadable. Finalization must finish and publish a bounded sample with the exact count.
    it("finalizes with git status output above 1 MiB and publishes a bounded changed-files sample", async () => {
      const current = await input.candidate(true), workspace = current.spec.request.workspacePath, cache = join(workspace, "cache");
      mkdirSync(cache);
      const total = 14_000;
      for (let index = 0; index < total; index++) writeFileSync(join(cache, `${"x".repeat(80)}-${String(index).padStart(6, "0")}.txt`), "");
      expect(await finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256)).toMatchObject({ status: "partial" });
      const publicationPath = join(current.directory, "mimo-publication.json");
      expect(statSync(local(publicationPath)).size).toBeLessThan(changedFilesReport.reportedChangedFilesLimit.bytes * 2);
      const result = JSON.parse(researchRead(publicationPath).toString()).result;
      expect(result.changedFiles.length).toBeGreaterThan(0);
      expect(result.changedFiles.length).toBeLessThanOrEqual(changedFilesReport.reportedChangedFilesLimit.paths);
      expect(result.changedFiles).toEqual([...result.changedFiles].sort());
      expect(result.evidence).toContain(changedFilesReport.changedFilesTruncatedEvidence);
      expect(result.details.changedFilesCount).toBe(String(total + 1));
      const latest = JSON.parse(readFileSync(local(join(current.spec.request.jobRootDir, `${current.spec.request.taskId}.latest-result.json`)), "utf8"));
      expect(latest.changedFiles).toEqual(result.changedFiles);
      expect(existsSync(local(join(researchJobAuthority(current.jobId), "active.json")))).toBe(false);
    }, 120_000);
  });
}
