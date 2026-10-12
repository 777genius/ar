import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, DependencyAdmissionError, DependencyAdmissionFailure,
  DependencyOwnerPhase, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "../hosted-dependency-workspace";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import * as workspace from "../hosted-dependency-workspace";
import * as capture from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { materializeHostedDependencyAbsence } from "../hosted-dependency-materialization";
import { HostedDependencyInstaller } from "../hosted-dependency-installer";
import * as installerRecipe from "../hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRevision, type HostedDependencyInstallerProfile } from "../hosted-dependency-installer-recipe";
import * as receipts from "../hosted-dependency-receipts";
import type { HostedOrdinaryStart, HostedOrdinaryReservation } from "../../worker-core/hosted-custody/domain/hosted-installation-activation";

function profile(): HostedDependencyInstallerProfile {
  return { schemaVersion: 1, recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127",
    platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    npmSha256: "b".repeat(64), npmVersion: "10.9.3", npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
    libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
    toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
    networkInputs: { hosts: "e".repeat(64), "resolv.conf": "f".repeat(64), "nsswitch.conf": "e".repeat(64) },
    privilegeDropper: { path: "/usr/bin/setpriv", sha256: "f".repeat(64), version: "2.39.3",
      libraries: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }] } };
}


/** Registers in the real ordinary installation fixture. Only filesystem/kernel
 * facts are projected; the actual fence, sole original-origin collector, owner
 * reader, byte capture and protected owner/receipt transport stay production. */
export function registerMaterializationAttemptTest(input: {
  prepared: () => { binding: HostedDependencyBinding; retained: { start: HostedOrdinaryStart; reservation: HostedOrdinaryReservation } };
  local: (path: string) => string;
  fixture: { captureAncestry: boolean; captureDirectories: Map<number, string> };
}): void {
  describe.skipIf(process.platform !== "linux")("materialization attempt after async input capture", () => {
    it("rejects a replaced same-launch owner before Installing publication or installer launch", async () => {
      // Red if the final current-owner join accepts only launch identity: a
      // replacement owner has the same launch and a different epoch/attempt.
      const p = input.prepared(), binding = p.binding, path = binding.workspace.canonicalPath;
      const pkg = { name: "attempt-replacement-TEST", version: "1.0.0" };
      const packageBytes = Buffer.from(JSON.stringify(pkg));
      const lockBytes = Buffer.from(JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
      const sentinelBytes = Buffer.from("TEST original source bytes");
      for (const [name, bytes] of [["package.json",packageBytes],["package-lock.json",lockBytes],["TEST-source-sentinel",sentinelBytes]] as const)
        writeFileSync(input.local(join(path,name)),bytes,{mode:0o600});
      const absencePath = `/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`;
      const absenceBytes = Buffer.from(JSON.stringify({version:1,workspace:binding.workspace,coverageRevision:receipts.dependencyCoverageRevision(binding)})+"\n");
      mkdirSync(input.local(dirname(absencePath)),{recursive:true,mode:0o700});
      writeFileSync(input.local(absencePath),absenceBytes,{mode:0o600});
      let attempt!: DependencyAttempt, replacement: DependencyAttempt | undefined;
      const mutateOwner = (action: (owners: LocalDependencyOwnerStore) => void) => withHostedActivationFence(() => {
        const owners = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
        try { action(owners); } finally { owners.close(); }
      });
      mutateOwner(owners => { attempt = claimDependencyConsumer(owners,binding.workspace,{
        installationId:binding.installationId,bootId:p.retained.start.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,
        startId:p.retained.reservation.startId,unit:p.retained.reservation.unit},randomUUID()); });
      const realCapture = capture.captureNpmInstallInputs, statuses: NpmInputCaptureStatus[] = [];
      vi.spyOn(capture,"captureNpmInstallInputs").mockImplementationOnce(async request => {
        input.fixture.captureAncestry = true;
        let captured: Awaited<ReturnType<typeof realCapture>>;
        try { captured = await realCapture(request); }
        finally { input.fixture.captureAncestry = false; input.fixture.captureDirectories.clear(); }
        statuses.push(captured.status);
        mutateOwner(owners => {
          fenceDependencyConsumer(owners,binding.workspace,attempt);
          const fenced = owners.read(binding.workspace);
          if (!fenced || fenced.owner?.phase !== DependencyOwnerPhase.Fenced) throw new Error("TEST owner not fenced");
          owners.compareAndSwap(binding.workspace,fenced.revision,{...fenced,revision:fenced.revision+1,owner:null});
          replacement = claimDependencyConsumer(owners,binding.workspace,attempt.launch,randomUUID());
        });
        return captured;
      });
      // Pure key inputs only. No installer runs and no profile grants an origin.
      vi.spyOn(installerRecipe,"readHostedDependencyInstallerProfile").mockImplementation(() => profile());
      const observed = vi.spyOn(workspace,"readHostedDependencyAttempt");
      const publish = vi.spyOn(receipts,"publishHostedDependencyReceipt");
      const install = vi.spyOn(HostedDependencyInstaller.prototype,"install").mockRejectedValue(new Error("TEST unexpected installer launch"));
      const materialization = materializeHostedDependencyAbsence(binding,attempt);
      await expect(materialization).rejects.toBeInstanceOf(DependencyAdmissionError);
      await expect(materialization).rejects.toMatchObject({reason:DependencyAdmissionFailure.StaleAttempt});
      expect(statuses).toEqual([NpmInputCaptureStatus.Qualified]);
      expect(replacement?.launch).toEqual(attempt.launch);
      expect(replacement?.attemptId).not.toBe(attempt.attemptId); expect(replacement?.epoch).toBe(attempt.epoch+1);
      expect(observed).toHaveReturnedWith(attempt); expect(observed).toHaveReturnedWith(replacement);
      expect(publish).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
      expect(receipts.readHostedDependencyReceipt(binding)).toBeNull();
      const historyRoot = input.local(receipts.hostedDependencyReceiptHistoryRoot);
      expect(existsSync(historyRoot) ? readdirSync(historyRoot) : []).toEqual([]);
      mutateOwner(owners => expect(owners.read(binding.workspace)?.owner).toMatchObject({phase:DependencyOwnerPhase.ExclusiveMutation,attempt:replacement}));
      for (const [name,bytes] of [["package.json",packageBytes],["package-lock.json",lockBytes],["TEST-source-sentinel",sentinelBytes]] as const)
        expect(readFileSync(input.local(join(path,name)))).toEqual(bytes);
      expect(readFileSync(input.local(absencePath))).toEqual(absenceBytes);
    });
  });
}
