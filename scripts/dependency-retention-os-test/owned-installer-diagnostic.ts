// TEST-only observation after the exact synthetic fresh CLI fails. No result,
// marker, unit state or diagnostic below grants release, retry or completion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseDependencyConsumerAttempt } from "../../dist/core/index.js";
import { sameSyntheticDiagnosticFile } from "./synthetic-cli-diagnostic.ts";
import { cleanEnv, digest, policy, runtimeDiagnostic } from "./common.ts";
const root = policy + "/dependency-installers", uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, sha = /^[a-f0-9]{64}$/;
export type SyntheticInstallerParent = Readonly<{ startId: string; unit: string; installationId: string; bootId: string;
  runtimeSha: string; grantSha256: string | null; workspacePath: string; workspaceDev: string; workspaceIno: string }>;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
/** Pure closed correlation. Returns only the derived unit identity, never inputs. */
export function correlateSyntheticInstallerRecords(attemptId: string, mappingBytes: Buffer, startBytes: Buffer,
  parent: SyntheticInstallerParent, profileSha256: string): Readonly<{ startId: string; unit: string }> | undefined {
  try {
    const m = JSON.parse(mappingBytes.toString("utf8")), s = JSON.parse(startBytes.toString("utf8"));
    assert(Object.keys(m).sort().join(",") === "attempt,schemaVersion,startId,unit" && m.schemaVersion === 1 && uuid.test(m.startId));
    assert(m.unit === `subscription-runtime-installer-${m.startId}.service` && encode(m).equals(mappingBytes));
    const attempt = parseDependencyConsumerAttempt(m.attempt), launch = attempt.launch;
    assert(uuid.test(attemptId) && attempt.attemptId === attemptId && !("kind" in launch));
    assert(launch.startId === parent.startId && launch.unit === parent.unit && launch.installationId === parent.installationId &&
      launch.bootId === parent.bootId && launch.runtimeSha === parent.runtimeSha && launch.grantDigest === parent.grantSha256);
    assert(Object.keys(s).sort().join(",") === "attempt,inputSha256,profileSha256,recipe,schemaVersion,startId,unit,workspace" &&
      s.schemaVersion === 1 && s.recipe === "npm_registry_no_scripts_v1" && s.startId === m.startId && s.unit === m.unit &&
      encode(s.attempt).equals(encode(m.attempt)) && encode(s).equals(startBytes) && sha.test(s.inputSha256) &&
      s.profileSha256 === profileSha256 && sha.test(profileSha256));
    assert(Object.keys(s.workspace).sort().join(",") === "canonicalPath,dev,ino" && s.workspace.canonicalPath === parent.workspacePath &&
      s.workspace.dev === parent.workspaceDev && s.workspace.ino === parent.workspaceIno);
    return Object.freeze({ startId: m.startId, unit: m.unit });
  } catch { return undefined; }
}
function privateStat(path: string) {
  for (let p = dirname(path);; p = dirname(p)) {
    const s = lstatSync(p); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022));
    if (p === dirname(path)) assert(!(s.mode & 0o077)); if (p === "/") break;
  }
  const s = lstatSync(path); assert(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o077) && s.size <= 65536);
  return s;
}
function privateBytes(path: string): Buffer {
  const before = privateStat(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(sameSyntheticDiagnosticFile(before, fstatSync(fd))); const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, length); if (!n) break; length += n; }
    const bytes = buffer.subarray(0, length);
    assert(bytes.length === before.size && sameSyntheticDiagnosticFile(before, fstatSync(fd)) && sameSyntheticDiagnosticFile(before, privateStat(path)));
    return bytes;
  } finally { closeSync(fd); }
}
function marker(path: string) {
  try { const s = privateStat(path); return { present: true, bytes: s.size }; }
  catch (e) { return { present: false, unavailable: (e as NodeJS.ErrnoException).code !== "ENOENT" }; }
}
const allowedStates: Readonly<Record<string, readonly string[]>> = {
  LoadState: ["loaded", "not-found", "error", "bad-setting", "masked", "merged"],
  ActiveState: ["active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing"],
  SubState: ["dead", "condition", "start-pre", "start", "start-post", "running", "exited", "reload", "reload-signal", "reload-notify", "stop", "stop-watchdog", "stop-sigterm", "stop-sigkill", "stop-post", "final-watchdog", "final-sigterm", "final-sigkill", "failed", "auto-restart", "auto-restart-queued", "cleaning"],
  Result: ["success", "resources", "protocol", "timeout", "exit-code", "signal", "core-dump", "watchdog", "start-limit-hit", "exec-condition", "oom-kill", "skip-condition"],
};
export function closedInstallerUnitStates(text: string, expectedUnit: string): Record<string, string> {
  const states: Record<string, string> = {};
  if (!/^subscription-runtime-installer-[a-f0-9-]{36}\.service$/.test(expectedUnit) ||
      text.split("\n").filter(line => line.startsWith("Id=")).join("\n") !== "Id=" + expectedUnit) return states;
  for (const line of text.trim().split("\n")) {
    const [key, value, ...rest] = line.split("=");
    if (!key || value === undefined || rest.length || key in states) continue;
    if (Object.hasOwn(allowedStates, key) && allowedStates[key]!.includes(value) || ["ExecMainCode", "ExecMainStatus"].includes(key) && /^(?:0|[1-9][0-9]{0,2})$/.test(value)) states[key] = value;
  }
  return states;
}
export function observeOwnedSyntheticInstallerFailure(parent: SyntheticInstallerParent) {
  const purpose = "TEST_correlated_synthetic_installer_failure_only";
  try {
    const names = readdirSync(root); assert(names.length <= 128);
    const profileBytes = privateBytes(policy + "/dependency-installer-profile.json"), profileSha = digest(profileBytes);
    const attempts = names.filter(name => /^attempt-[a-f0-9-]{36}\.json$/.test(name)); assert(attempts.length <= 16);
    let correlated = 0;
    return { purpose, attemptMappingsScanned: attempts.length, attempts: attempts.flatMap<Record<string, unknown>>(name => {
      try {
        const mappingBytes = privateBytes(root + "/" + name), m = JSON.parse(mappingBytes.toString("utf8"));
        assert(typeof m.startId === "string" && uuid.test(m.startId));
        const directory = root + "/" + m.startId, startBytes = privateBytes(directory + "/start.json");
        const selected = correlateSyntheticInstallerRecords(name.slice(8, -5), mappingBytes, startBytes, parent, profileSha);
        if (!selected) return []; assert(++correlated <= 1);
        const markers = Object.fromEntries(["consumed", "creator", "creator-completion", "revoked", "terminal", "submitter-fenced"]
          .map(name => [name, marker(directory + "/" + name + ".json")]));
        const show = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus", "--", selected.unit],
          { env: cleanEnv, encoding: "utf8", timeout: 3000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
        const journal = spawnSync("/usr/bin/journalctl", ["--unit", selected.unit, "--no-pager", "--output=cat", "--lines=32"],
          { env: cleanEnv, encoding: "utf8", timeout: 3000, maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
        // Rejoin the same immutable input records after both bounded queries.
        assert(privateBytes(policy + "/dependency-installer-profile.json").equals(profileBytes) && privateBytes(root + "/" + name).equals(mappingBytes) && privateBytes(directory + "/start.json").equals(startBytes));
        return [{ ...selected, mappingSha256: digest(mappingBytes), startSha256: digest(startBytes), markers,
          showStatus: show.status, showFailed: !!show.error, states: !show.error && show.status === 0 ? closedInstallerUnitStates(show.stdout, selected.unit) : {},
          journalStatus: journal.status, journalFailed: !!journal.error, journalDiagnostic: runtimeDiagnostic(journal.stdout ?? "") }];
      } catch { return [{ unavailable: true }]; }
    }) };
  } catch { return { purpose, unavailable: true }; }
}
