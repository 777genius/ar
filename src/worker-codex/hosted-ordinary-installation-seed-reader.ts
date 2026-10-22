import { verifyPinnedFdCollectorProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { fstatSync, readFileSync, readlinkSync, statSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readCodexEffectiveSeed } from "./codex-effective-seed";
import { qualificationCandidate, qualificationHeld, qualificationJson, qualificationObject, qualificationRead, qualificationRoot, qualificationSha } from "./hosted-ordinary-installation-qualification";
import type { OrdinaryLauncherCandidate } from "./hosted-ordinary-installation-qualification";

const entry = fileURLToPath(import.meta.url);
const alias = qualificationRoot + "/broker/account-test/auth.json";
/** Only the original host owner starts this fixed entry in its retained guest
 * mount/root/PID namespaces. FD3 is a private inherited runtime channel; it is
 * never a public receipt, stdout, journal, caller path or capability issuer. */
async function captureOriginalSeed(): Promise<void> {
  assertHostedActivationOperator();
  if (process.argv.length !== 3 || process.argv[2] !== "--capture-original-seed" ||
      !fstatSync(3).isSocket() || !readlinkSync("/proc/self/fd/3").startsWith("socket:[") ||
      ![1, 2].every(fd => readlinkSync(`/proc/self/fd/${fd}`) === "/dev/null")) qualificationHeld();
  const inputBytes = qualificationRead(qualificationRoot + "/usable-input.json", 65536, true);
  const input = qualificationObject(qualificationJson(inputBytes), "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure,creator,tools");
  const operation = qualificationObject(input.operation, "operationId,workEndEpochMs,cleanupEndEpochMs");
  const fixture = qualificationObject(input.fixture, "testId,guestMachineId,guestHostname,guestEntrySha256");
  const candidate = qualificationObject(input.candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256") as unknown as OrdinaryLauncherCandidate;
  const funded = qualificationRead(qualificationRoot + "/funded-operation.json", 65536, true);
  const fundedData = qualificationJson(funded) as Record<string, unknown>;
  if (fundedData.schemaVersion !== 2 || Object.entries(operation).some(([key,value]) => fundedData[key] !== value)) qualificationHeld();
  const readyBytes = qualificationRead(qualificationRoot + "/usable-ready.json", 65536, true);
  const ready = qualificationObject(qualificationJson(readyBytes), "schemaVersion,operationSha256,guestInputSha256,unit,invocationId,namespaces,bootId");
  if (input.schemaVersion !== 1 || Date.now() >= Number(operation.workEndEpochMs) ||
      entry !== candidate.candidateArtifactPath + "/dist/worker-codex/hosted-ordinary-installation-seed-reader.js" ||
      ready.schemaVersion !== 1 || ready.operationSha256 !== qualificationSha(funded) || ready.guestInputSha256 !== qualificationSha(inputBytes) ||
      ready.unit !== "subscription-runtime-ordinary-" + fixture.testId + ".service" ||
      ready.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
      readFileSync("/etc/machine-id", "utf8").trim() !== fixture.guestMachineId || !Array.isArray(ready.namespaces) || ready.namespaces.length !== 4) qualificationHeld();
  const manifestBytes = qualificationCandidate(candidate);
  const manifest = qualificationJson(manifestBytes) as { files: { path: string; sha256: string }[] };
  const pins = manifest.files.filter(pin => pin.path === "dist/worker-codex/hosted-ordinary-installation-seed-reader.js");
  if (pins.length !== 1 || pins[0]!.sha256 !== qualificationSha(qualificationRead(entry))) qualificationHeld();
  const rejoin = () => {
    assertHostedActivationOperator();
    if (Date.now() >= Number(operation.workEndEpochMs) || !qualificationRead(qualificationRoot + "/usable-input.json", 65536, true).equals(inputBytes) ||
        !qualificationRead(qualificationRoot + "/usable-ready.json", 65536, true).equals(readyBytes) ||
        !qualificationRead(qualificationRoot + "/funded-operation.json", 65536, true).equals(funded)) qualificationHeld();
    for (const name of ["user", "mnt", "pid", "net"]) {
      const rows = ready.namespaces as Record<string, unknown>[];
      const selected = rows.filter(row => row.name === name);
      if (selected.length !== 1) qualificationHeld();
      qualificationObject(selected[0], "name,dev,ino");
      const own = statSync(`/proc/self/ns/${name}`), initial = statSync(`/proc/1/ns/${name}`);
      if (own.dev !== initial.dev || own.ino !== initial.ino || own.dev !== selected[0]!.dev || own.ino !== selected[0]!.ino) qualificationHeld();
    }
  };
  rejoin();
  const profile = verifyPinnedFdCollectorProfile({ path: "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json", sha256: candidate.profileSha256 }, () => {
    rejoin(); const remaining = Number(operation.workEndEpochMs) - Date.now(); if (remaining < 1) qualificationHeld(); return remaining;
  });
  if (process.execPath !== profile.node.path) qualificationHeld();
  // SAME logical source path as the actual guest provider. Reading through
  // /proc/<pid>/root from the host would select a different journal scope.
  const seed = await readCodexEffectiveSeed(alias);
  rejoin();
  const bytes = Buffer.from(JSON.stringify({ source: seed.source, bytes: seed.bytes }));
  if (bytes.length > 2 * 1024 * 1024) qualificationHeld();
  let written = 0;
  try {
    while (written < bytes.length) {
      rejoin(); const count = writeSync(3, bytes, written, bytes.length - written);
      if (count < 1) qualificationHeld(); written += count;
    }
  } finally { bytes.fill(0); }
}
if (process.argv[1] === entry) {
  void captureOriginalSeed().then(() => { process.exitCode = 0; }, () => { process.exitCode = 70; });
}
