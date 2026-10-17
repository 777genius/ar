import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { local } from "./research-launch-fixture";
import { researchCurrentStart, researchJobAuthority } from "../research-launch-admission";
import { finalizeOwnedMimoWorker } from "../research-launch-lifecycle";
import * as workspaceChanges from "../codex-goal-workspace-changes";
import * as changedFilesReport from "../codex-goal-changed-files-report";
import { researchRead } from "../research-launch-files";

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
