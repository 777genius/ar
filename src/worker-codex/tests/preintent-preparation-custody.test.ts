import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { joinOriginalPreparation } from "../../worker-core/hosted-custody/application/preintent-preparation";
import type { OriginalPreparationCustodyPort } from "../../worker-core/hosted-custody/ports/preintent-preparation";
import { KeyedChildLedger, KeyedChildProfile, KeyedChildState } from "../../worker-core/project-control/domain/keyed-child-launch";

/** Negative source/process boundary regression. This is an original owned Git
 * process in a NEW disposable TEST repository. No native positive authority is
 * fabricated, and this test does not qualify the missing installed supervisor. */
it("a real held Git writer and its eventual exit cannot establish preparation quiescence", async () => {
  const root = mkdtempSync(join(tmpdir(), "C1-TEST-git-"));
  execFileSync("/usr/bin/git", ["init", "--bare", "--", root], { env: {}, stdio: "ignore" });
  const body = "C1 disposable original Git writer\n";
  const objectId = createHash("sha1").update(`blob ${Buffer.byteLength(body)}\0${body}`).digest("hex");
  const object = join(root, "objects", objectId.slice(0, 2), objectId.slice(2));
  const child = spawn("/usr/bin/git", ["-C", root, "hash-object", "-w", "--stdin"], { env: {}, stdio: ["pipe", "ignore", "ignore"] });
  const exit = once(child, "exit");
  const scope = { projectId: "C1-TEST", workstreamId: "TEST-work", controllerId: "TEST-controller" };
  const authority = { ...scope, grantDigest: "a".repeat(64), reviewedSnapshotDigest: "b".repeat(64),
    accountId: "TEST-account", sourceSha: "c".repeat(40), artifactSha: "d".repeat(40),
    absoluteDeadline: Date.now() + 30_000, maxGoalTurns: 2, effectiveOptionDigest: "e".repeat(64) };
  const slot = { slotId: "TEST-slot", requestId: "TEST-request", operationId: "TEST-operation",
    childHandle: "TEST-child", startId: "TEST-start", unitCorrelation: "TEST-unit", profile: KeyedChildProfile.ReadOnly };
  let ledger = KeyedChildLedger.create(authority, [slot]).accept(0,
    { key: "TEST-key", task: "harmless disposable test", profile: KeyedChildProfile.ReadOnly }, Date.now());
  ledger = ledger.advance(ledger.observe(scope, slot.childHandle), KeyedChildState.Materializing, Date.now());
  const binding = ledger.observe(scope, slot.childHandle);
  ledger = ledger.stop(binding);
  let rereads = 0, stopRequests = 0;
  // Domain port fixture reports uncertainty, never a genuine custody proof.
  const custody: OriginalPreparationCustodyPort = {
    owner: { correlation: binding, preparationGeneration: 1, ownershipDigest: "f".repeat(64),
      preparationPlanDigest: "a".repeat(64),
      deadlineEpochMs: authority.absoluteDeadline, maxGoalTurns: authority.maxGoalTurns },
    assertAdmission: () => { throw new Error("TEST admission is closed"); },
    requestStop: () => { stopRequests++; }, join: async () => null,
    authenticateQuiescence: () => { throw new Error("TEST has no native provenance"); },
  };
  try {
    await once(child, "spawn");
    expect(child.exitCode).toBeNull(); expect(existsSync(object)).toBe(false);
    expect(await joinOriginalPreparation(custody, exit.then(() => {}), () => { rereads++; })).toBeNull();
    expect(ledger.occupied).toBe(true); expect(rereads).toBe(0);
    // Independently observe a real late effect from the still-owned original
    // operation. Neither stopRequested nor the earlier null proof releases it.
    child.stdin.end(body);
    const [code] = await exit;
    expect(code).toBe(0); expect(existsSync(object)).toBe(true);
    expect(await joinOriginalPreparation(custody, Promise.resolve(), () => { rereads++; })).toBeNull();
    expect(stopRequests).toBe(2); expect(rereads).toBe(0);
    expect(ledger.observe(scope, slot.childHandle).dispatchIntent).toBeNull();
    expect(ledger.occupied).toBe(true); expect(ledger.remainingAllowance).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); child.kill("SIGKILL"); await exit; }
    rmSync(root, { recursive: true, force: true });
  }
});
