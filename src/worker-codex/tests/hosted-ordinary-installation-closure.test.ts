import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qualificationCandidate, qualificationCopiedCohort, qualificationProfile,
  type OrdinaryLauncherCandidate } from "../hosted-ordinary-installation-qualification";

const custody = vi.hoisted(() => ({ active: false }));
// Cold byte/cohort checks only. Substitute root metadata for disposable files;
// real bytes, hashes, missing files and replacements remain observable.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const protectedStat = <T extends { uid: number | bigint; mode: number | bigint } | undefined>(stat: T): T =>
    custody.active && stat !== undefined ? Object.assign(Object.create(Object.getPrototypeOf(stat)) as NonNullable<T>, stat,
      { uid: typeof stat.uid === "bigint" ? 0n : 0,
        mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022 }) : stat;
  return { ...real,
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => protectedStat(real.lstatSync(...args)),
    fstatSync: (...args: Parameters<typeof real.fstatSync>) => protectedStat(real.fstatSync(...args)),
  };
});
afterEach(() => { custody.active = false; });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const helper = "managed-launcher/storage-pressure-guard.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ordinary-closure-TEST-")));
  const artifact = "/artifact", installed = "/opt/subscription-runtime/";
  const put = (path: string, bytes: string | Buffer) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  };
  const copied = ["managed-launcher/launch.mjs", "managed-launcher/host-inventory-codec.cjs",
    "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs",
    "managed-launcher/hosted-host-policy.mjs", helper];
  const required = ["dist/worker-codex/hosted-ordinary-installation-qualification.js",
    "dist/worker-codex/hosted-ordinary-installation-qualification-guest.js", "dist/worker-codex/hosted-installation-activation.js",
    "dist/worker-codex/hosted-ordinary-installation-census.js", "dist/worker-codex/hosted-ordinary-installation-history.js",
    "dist/core-compatibility.js", "dist/core/host-infrastructure/host-inventory.js", "dist/core/host-infrastructure/host-installation-successor.js",
    "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js",
    ...["hosted-fd-launch", "hosted-fd-child", "hosted-fd-observation", "hosted-fd-unit-lifecycle", "hosted-fd-unit-policy", "hosted-fd-prelude", "hosted-process-activation",
      "hosted-process-descriptors", "hosted-dependency-tool-plan", "hosted-blocking-output", "managed-provider-scratch-environment",
      "system-bus-infrastructure", "system-bus-configuration", "systemd-service-arrays", "elf-closure"]
      .map(name => `dist/provider-codex/app-server/adapters/${name}.js`),
    ...["hosted-ordinary-installation-source-scope", "hosted-runtime-stage-curator", "hosted-fd-collector-profile-issuer", "hosted-runtime-issuer-cli"]
      .map(name => `dist/worker-codex/${name}.js`),
    ...copied.map(path => "host-integration/" + path)];
  const bytes = (path: string) => Buffer.from("owned candidate " + path + "\n");
  for (const path of required) put(artifact + "/" + path, bytes(path));
  for (const path of copied) put(installed + path, bytes("host-integration/" + path));
  const pin = (path: string) => ({ path, sha256: "b".repeat(64) });
  const executable = (path: string) => ({ ...pin(path), elfFiles: [pin(path), pin(path + "-library")] });
  put(qualificationProfile, JSON.stringify({ schemaVersion: 1, renderer: "ss-v6.1-int32",
    ss: executable("/usr/bin/ss"), node: executable("/node"),
    wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable("/usr/bin/" + name)),
    bootstraps: ["hosted-app-server-launcher.js", "hosted-dependency-installer-bootstrap.js",
      "hosted-readonly-host-launch-cli.js", "hosted-readonly-runtime-bootstrap.js"].map(name => pin(artifact + "/" + name))
      .concat([{ path: installed + "managed-launcher/hosted-host-policy.mjs",
        sha256: sha(bytes("host-integration/managed-launcher/hosted-host-policy.mjs")) }]),
    limits: { setupTimeoutMs: 10000, collectorTimeoutMs: 1000, maxOutputBytes: 1024, maxRows: 100,
      maxBufferedInputBytes: 1024, maxEventPoll: 1, maxEventFd: 1, maxPipeEndpoints: 1, maxDevNullReserves: 1 } }));
  const candidate: OrdinaryLauncherCandidate = { candidateArtifactPath: artifact, runtimeSha: "a".repeat(40),
    runtimeManifestSha256: "a".repeat(64), launcherSha256: sha(bytes("host-integration/managed-launcher/launch.mjs")),
    codecSha256: sha(bytes("host-integration/managed-launcher/host-inventory-codec.cjs")), profileSha256: "c".repeat(64),
    sourceScopeSha256: "" };
  const manifest = (paths = required) => {
    const source = JSON.stringify({ schemaVersion: 1, files: paths.map(path => ({ path, sha256: sha(bytes(path)) })) });
    put(artifact + "/ordinary-qualification-source.json", source);
    return { ...candidate, sourceScopeSha256: sha(source) };
  };
  custody.active = true;
  return { root, put, required, manifest, installed,
    close: () => { custody.active = false; rmSync(root, { recursive: true }); } };
}

describe("ordinary installed helper closure", () => {
  // Omitting the imported helper from the measured manifest previously passed.
  it.each(["host-integration/" + helper,
    "dist/provider-codex/app-server/adapters/hosted-fd-unit-lifecycle.js",
    "dist/provider-codex/app-server/adapters/hosted-fd-unit-policy.js",
    "dist/provider-codex/app-server/adapters/hosted-blocking-output.js",
    "dist/provider-codex/app-server/adapters/managed-provider-scratch-environment.js"])
    ("requires %s in the measured candidate source", required => {
    const f = fixture();
    try {
      expect(() => qualificationCandidate(f.manifest(), f.root)).not.toThrow();
      const omitted = f.manifest(f.required.filter(path => path !== required));
      expect(() => qualificationCandidate(omitted, f.root)).toThrow("ordinary_launcher_qualification_held");
    } finally { f.close(); }
  });
  // A valid launcher/guard pair must not qualify with a missing or different import.
  it.each(["missing", "changed"])("refuses an installed helper that is %s", fault => {
    const f = fixture();
    try {
      const candidate = f.manifest();
      expect(() => qualificationCopiedCohort(candidate, f.root)).not.toThrow();
      if (fault === "missing") rmSync(join(f.root, f.installed, helper));
      else f.put(f.installed + helper, "foreign pressure implementation\n");
      expect(() => qualificationCopiedCohort(candidate, f.root)).toThrow();
    } finally { f.close(); }
  });
});
