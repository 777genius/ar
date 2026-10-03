import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAuthorityMode, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectAuthorityTupleStore } from "../../worker-local/project-authority-tuple-local-adapter";
import { parseCodexGoalProjectAccessScopeJson } from "../codex-goal-access-plan";
import { prepareProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import { withProjectPreStartAdmissionLaunchAuthorization } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import { cleanupProjectPreStartAdmissionFixtures, createBuiltinFixture } from "./codex-goal-project-pre-start-admission-fixture";

afterEach(cleanupProjectPreStartAdmissionFixtures);

describe("Hosted project pre-start authority", () => {
  it.each(["serial", "serial-builtin"] as const)(
    "rejects optional Hosted authority in the %s parser",
    (mode) => {
      expect(() => parseCodexGoalProjectAccessScopeJson(JSON.stringify({
        projectId: "project",
        preStartAdmission: {
          required: false,
          mode,
          authorityMode: ProjectAuthorityMode.HostedWebCoreV1,
          ...(mode === "serial" ? {
            validatorBundle: [{ path: "validator.mjs", sha256: "a".repeat(64) }],
          } : {}),
        },
      }))).toThrow("projectAccessScope.preStartAdmission.authorityMode_requires_required");
    },
  );

  it.each(["serial", "serial-builtin"] as const)(
    "preserves local optional admission in the %s parser",
    (mode) => {
      expect(parseCodexGoalProjectAccessScopeJson(JSON.stringify({
        projectId: "project",
        preStartAdmission: {
          required: false,
          mode,
          ...(mode === "serial" ? {
            validatorBundle: [{ path: "validator.mjs", sha256: "a".repeat(64) }],
          } : {}),
        },
      }))).toMatchObject({ preStartAdmission: { required: false, mode } });
    },
  );

  it("blocks an unchecked optional Hosted launch with stale persisted authority and no descriptor", async () => {
    const fixture = await createBuiltinFixture();
    const scope: ProjectAccessScope = { ...fixture.scope, preStartAdmission: {
      required: false,
      mode: "serial-builtin",
      authorityMode: ProjectAuthorityMode.HostedWebCoreV1,
    } };
    const rootDir = join(fixture.root, "authority-TEST");
    const stateDir = join(rootDir, scope.projectId);
    const statePath = join(stateDir, "authority-tuple.json");
    await mkdir(rootDir, { mode: 0o700 });
    await mkdir(stateDir, { mode: 0o700 });
    const staleDocument = JSON.stringify({ schemaVersion: 1, projectId: scope.projectId,
      tuple: { packetRevision: "stale-TEST-r0", baseSha: "a".repeat(40),
        phaseStartSha: null, inputPatchHash: "b".repeat(64) } }) + "\n";
    await writeFile(statePath, staleDocument, { mode: 0o600 });
    const authorityStore = new LocalProjectAuthorityTupleStore({ rootDir, projectId: scope.projectId });
    const launchedPath = join(fixture.root, "fake-launch-TEST.txt");
    let eligibilityChecks = 0;
    await expect(withProjectPreStartAdmissionLaunchAuthorization({
      manifest: fixture.storedManifest,
      scope,
      authorityStore,
      assertLaunchEligible: async () => { eligibilityChecks += 1; },
    }, async () => {
      await writeFile(launchedPath, "synthetic launch executed\n");
    })).rejects.toThrow("project_authority_explicit_pre_start_configuration_required");
    expect(eligibilityChecks).toBe(0);
    await expect(access(launchedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(statePath, "utf8")).toBe(staleDocument);
  });

  it("blocks unchecked optional Hosted authorization even with a valid descriptor", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    const manifest = { ...fixture.storedManifest, projectPreStartAdmission: plan.descriptor };
    await prepareProjectPreStartAdmission({ plan, manifest, scope: fixture.scope });
    const previousReceipt = await readFile(plan.descriptor.receiptPath, "utf8");
    const scope: ProjectAccessScope = { ...fixture.scope, preStartAdmission: {
      required: false, mode: "serial-builtin", authorityMode: ProjectAuthorityMode.HostedWebCoreV1,
    } };
    let eligibilityChecks = 0;
    await expect(withProjectPreStartAdmissionLaunchAuthorization({ manifest, scope,
      assertLaunchEligible: async () => { eligibilityChecks += 1; },
    }, async () => {
      await writeFile(join(fixture.root, "fake-launch-TEST.txt"), "synthetic launch executed\n");
    })).rejects.toThrow("project_authority_explicit_pre_start_configuration_required");
    expect(eligibilityChecks).toBe(0);
    expect(await readFile(plan.descriptor.receiptPath, "utf8")).toBe(previousReceipt);
    await expect(access(join(fixture.root, "fake-launch-TEST.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes a legitimate local optional launch without a descriptor", async () => {
    const fixture = await createBuiltinFixture();
    const scope: ProjectAccessScope = { ...fixture.scope, preStartAdmission: {
      required: false, mode: "serial-builtin",
    } };
    const launchedPath = join(fixture.root, "fake-launch-TEST.txt");
    await expect(withProjectPreStartAdmissionLaunchAuthorization({
      manifest: fixture.storedManifest, scope,
    }, async () => {
      await writeFile(launchedPath, "synthetic launch executed\n");
      return "launched";
    })).resolves.toBe("launched");
    expect(await readFile(launchedPath, "utf8")).toBe("synthetic launch executed\n");
  });

  it("checks persisted Hosted authority before a valid descriptor can launch", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    const manifest = { ...fixture.storedManifest, projectPreStartAdmission: plan.descriptor };
    const scope: ProjectAccessScope = { ...fixture.scope, preStartAdmission: {
      required: true, mode: "serial-builtin", authorityMode: ProjectAuthorityMode.HostedWebCoreV1,
    } };
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    const previousReceipt = await readFile(plan.descriptor.receiptPath, "utf8");
    const rootDir = join(fixture.root, "authority-TEST");
    await mkdir(rootDir, { mode: 0o700 });
    const authorityStore = new LocalProjectAuthorityTupleStore({ rootDir, projectId: scope.projectId });
    await authorityStore.initialize({ packetRevision: "stale-TEST-r0",
      baseSha: "a".repeat(40), phaseStartSha: null, inputPatchHash: "b".repeat(64) });
    const statePath = join(rootDir, scope.projectId, "authority-tuple.json");
    const previousState = await readFile(statePath, "utf8");
    const launchedPath = join(fixture.root, "fake-launch-TEST.txt");
    await expect(withProjectPreStartAdmissionLaunchAuthorization({ manifest, scope, authorityStore }, async () => {
      await writeFile(launchedPath, "synthetic launch executed\n");
    })).rejects.toThrow("project_authority_initialize_conflict");
    await expect(access(launchedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(statePath, "utf8")).toBe(previousState);
    expect(await readFile(plan.descriptor.receiptPath, "utf8")).toBe(previousReceipt);
  });
});
