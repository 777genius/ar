import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isExpectedEvidencePathError } from "../application/project-control/codex-goal-ledger-epoch-evidence";
import { ledgerFixture } from "./codex-goal-consumed-output-ledger-epoch.test";

describe("consumed-output ledger epoch evidence custody", () => {
  it("quarantines external archive and preexisting patch paths", async () => {
    const fixture = await ledgerFixture();
    const path = join(fixture.oldRoot, "items/current-v4.json");
    const value = { ...JSON.parse(await readFile(path, "utf8")),
      archivePath: join(dirname(fixture.root), "external-archive"),
      preexistingWorkspacePatch: {
        path: join(dirname(fixture.root), "external-preexisting.patch"),
        sha256: "a".repeat(64),
      } };
    await writeFile(path, `${JSON.stringify(value)}\n`);
    const plan = await fixture.buildPlan();
    expect(plan.files.find((file) => file.relativePath === "items/current-v4.json"))
      .toMatchObject({ disposition: "quarantine", quarantineReason: "invalid_or_missing_evidence" });
    expect(plan.evidenceBindings.some((binding) =>
      binding.declaredPath === value.archivePath ||
      binding.declaredPath === value.preexistingWorkspacePatch.path)).toBe(false);
  });

  it("quarantines malformed backup workspace NUL paths deterministically", async () => {
    const fixture = await ledgerFixture();
    const path = join(fixture.oldRoot, "items/current-v4.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    value.backup.workspace = `${fixture.root}\0malformed`;
    await writeFile(path, `${JSON.stringify(value)}\n`);
    const plan = await fixture.buildPlan();
    expect(plan.files.find((file) => file.relativePath === "items/current-v4.json"))
      .toMatchObject({ disposition: "quarantine", quarantineReason: "invalid_or_missing_evidence" });
    expect(plan.evidenceBindings.some((binding) => binding.declaredPath.includes("\0"))).toBe(false);
    expect((await fixture.buildPlan()).planSha256).toBe(plan.planSha256);
  });

  it("quarantines optional payloads unless each binds as a file", async () => {
    for (const state of ["missing", "denied", "symlink", "directory"] as const) {
      const fixture = await ledgerFixture();
      const path = join(fixture.oldRoot, "items/current-v4.json");
      const optional = join(fixture.archivePath, `optional-${state}`);
      if (state === "denied") await writeFile(optional, "denied\n");
      if (state === "symlink") await symlink(fixture.statusPath, optional);
      if (state === "directory") await mkdir(optional);
      const value = JSON.parse(await readFile(path, "utf8"));
      value.backup.untrackedArchivePath = optional;
      await writeFile(path, `${JSON.stringify(value)}\n`);
      const plan = await fixture.buildPlan(undefined, state === "denied" ? [optional] : []);
      expect(plan.files.find((file) => file.relativePath === "items/current-v4.json"))
        .toMatchObject({ disposition: "quarantine", quarantineReason: "invalid_or_missing_evidence" });
      expect(plan.evidenceBindings).toContainEqual(expect.objectContaining({ declaredPath: optional, state }));
      expect(plan.evidenceBindings).toContainEqual(expect.objectContaining({ declaredPath: fixture.statusPath, state: "file" }));
    }
  });

  it("quarantines known custody path errors but rethrows operational failures", () => {
    for (const message of ["consumed_output_evidence_path_outside_root", "evidence_custody_root_noncanonical"])
      expect(isExpectedEvidencePathError(new Error(message))).toBe(true);
    for (const code of ["EIO", "EACCES", "EPERM"])
      expect(isExpectedEvidencePathError(Object.assign(new Error(), { code }))).toBe(false);
    expect(isExpectedEvidencePathError(new Error("consumed_output_evidence_file_changed"))).toBe(false);
  });
});
