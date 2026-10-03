#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const label = "com.vioxen.codex-limit-alarm";
const uid = process.getuid?.();
if (!Number.isInteger(uid)) throw new Error("macOS user id is unavailable");

const sourceDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDir, "../..");
const appDir = join(homedir(), "Library/Application Support/Codex Limit Alarm");
const runtimeDir = join(appDir, "runtime");
const runtimeScriptsDir = join(runtimeDir, "scripts/ops");
const logsDir = join(homedir(), "Library/Logs");
const plistPath = join(homedir(), `Library/LaunchAgents/${label}.plist`);
const serviceTarget = `gui/${uid}/${label}`;
const domainTarget = `gui/${uid}`;
const uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  await launchctl(["bootout", serviceTarget], true);
  await rm(plistPath, { force: true });
  console.log("Codex limit alarm uninstalled");
  process.exit(0);
}

await mkdir(runtimeScriptsDir, { recursive: true });
await mkdir(logsDir, { recursive: true });
await mkdir(dirname(plistPath), { recursive: true });

for (const fileName of [
  "codex-limit-alarm.mjs",
  "codex-limit-alarm-state.mjs",
  "codex-account-quota-table.mjs",
]) {
  const destination = join(runtimeScriptsDir, fileName);
  await copyFile(join(sourceDir, fileName), destination);
  await chmod(destination, 0o700);
}
await cp(
  join(repositoryRoot, "packages/agent-account-observability/dist"),
  join(runtimeDir, "packages/agent-account-observability/dist"),
  { recursive: true, force: true },
);

const monitorPath = join(runtimeScriptsDir, "codex-limit-alarm.mjs");
const alarmSoundPath = join(appDir, "codex-limit-alarm.wav");
await writeFile(alarmSoundPath, createAlarmWave(), { mode: 0o600 });
const stdoutPath = join(logsDir, "CodexLimitAlarm.log");
const stderrPath = join(logsDir, "CodexLimitAlarm.error.log");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(monitorPath)}</string>
    <string>--sound</string>
    <string>${xml(alarmSoundPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(homedir())}</string>
    <key>PATH</key><string>${xml(`${join(homedir(), ".local/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
const temporaryPath = `${plistPath}.new`;
await writeFile(temporaryPath, plist, { mode: 0o600 });
await rename(temporaryPath, plistPath);

await launchctl(["bootout", serviceTarget], true);
await sleep(1_000);
await bootstrapWithRetry();
await launchctl(["kickstart", "-k", serviceTarget]);
console.log("Codex limit alarm installed: http://127.0.0.1:47831");

function launchctl(args, ignoreFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/launchctl", args, {
      stdio: ignoreFailure ? "ignore" : ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || ignoreFailure) resolve();
      else reject(new Error(`launchctl ${args[0]} failed with exit ${code}`));
    });
  });
}

async function bootstrapWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await launchctl(["bootstrap", domainTarget, plistPath]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function createAlarmWave(options = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const durationSeconds = options.durationSeconds ?? 30;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const output = Buffer.allocUnsafe(44 + dataSize);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const frequency = Math.floor(time * 3) % 2 === 0 ? 880 : 1_320;
    const carrier = Math.sin(2 * Math.PI * frequency * time);
    const harmonic = Math.sin(2 * Math.PI * frequency * 1.5 * time) * 0.2;
    const sample = Math.max(-1, Math.min(1, (carrier + harmonic) * 0.98));
    output.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return output;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
