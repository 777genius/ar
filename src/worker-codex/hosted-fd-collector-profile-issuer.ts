import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fdCollectorProfileLimitMaxima, FdCollectorRenderer, knownFdCollectorPeer, parseFdCollectorProfile,
  type FdCollectorPeer, type FdCollectorProfile, type FdExecutablePin, type FdFilePin, type HostedInventoryFile } from "@vioxen/subscription-runtime/core";
import { elfClosureMaxFiles, measureElfClosure, type ElfPin } from "../provider-codex/app-server/adapters/elf-closure";
import { collectHostedFdPeers } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOrdinaryCollectorProfileUpgrade, type OrdinaryPriorCollectorProfile } from "./hosted-ordinary-installation-launcher";
import { qualificationRead } from "./hosted-ordinary-installation-qualification";
import { currentBootId, encodeIssuerReceipt, IssuerReceiptKind, issuerReceiptPathFor, nodePrivateRecordPorts, ownModuleSha256, publishIdempotent, type PrivateRecordPorts } from "./hosted-runtime-stage-curator";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";

/**
 * Runtime Host collector-profile issuer: measures the six executables' ELF closures and the bootstrap pins, qualifies the pinned `ss` renderer
 * BEHAVIOURALLY against a real kernel socket pair through the collector's own API (`collectHostedFdPeers`, which runs the fixed
 * `ss -H -n -A unix_stream state established src unix:` and parses it with `parseFdCollectorRows`, including the signed-int32 rendering),
 * publishes the prepared profile create-once at its fixed path and runs the product upgrade validator on exactly those bytes.
 * Limits are the contract maxima (`fdCollectorProfileLimitMaxima`): the parser's own ceilings, not measurements (a measured zero is invalid
 * by contract and no hosted launcher exists before the profile does).
 */
const wrapperPaths = ["/usr/bin/setpriv", "/usr/bin/systemd-run", "/usr/bin/tini", "/usr/bin/unshare"] as const;
const installedLauncherRoot = "/opt/subscription-runtime";
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_runtime_issuer_invalid"); }

export type ProfileRequest = Readonly<{ operationId: string; runtimeDirectory: string; runtimeSha: string }>;
export type SocketPairFacts = Readonly<{ localInode: string; peerInode: string; close(): void }>;
export type RendererPorts = Readonly<{ openPair(): SocketPairFacts; collect(profile: FdCollectorProfile): ReadonlyMap<string, FdCollectorPeer> }>;
export type ProfilePorts = PrivateRecordPorts & Readonly<{
  nodePath: string;
  measure(executable: string): readonly ElfPin[];
  pin(path: string): FdFilePin;
  renderer: RendererPorts;
  ssVersion(): string;
  upgrade(prepared: HostedInventoryFile, launcherSha256: string, codecSha256: string): void;
  bootId(): string; moduleSha256(): string; sourceScopeSha256(): string;
}>;
export type ProfileOutcome = Readonly<{ preparedPath: string; profileSha256: string; receiptPath: string; receiptSha256: string }>;

/** Canonical bytes of a profile: fixed key order, so the bytes that are hashed, validated and published are the same everywhere. */
export function encodeFdCollectorProfile(profile: FdCollectorProfile): Buffer {
  const executable = (pin: FdExecutablePin) => ({ path: pin.path, sha256: pin.sha256, elfFiles: pin.elfFiles.map(file => ({ path: file.path, sha256: file.sha256 })) });
  const l = profile.limits;
  return Buffer.from(JSON.stringify({ schemaVersion: 1, renderer: profile.renderer, ss: executable(profile.ss), node: executable(profile.node), wrappers: profile.wrappers.map(executable),
    bootstraps: profile.bootstraps.map(pin => ({ path: pin.path, sha256: pin.sha256 })),
    limits: { setupTimeoutMs: l.setupTimeoutMs, collectorTimeoutMs: l.collectorTimeoutMs, maxOutputBytes: l.maxOutputBytes, maxRows: l.maxRows, maxBufferedInputBytes: l.maxBufferedInputBytes,
      maxEventPoll: l.maxEventPoll, maxEventFd: l.maxEventFd, maxPipeEndpoints: l.maxPipeEndpoints, maxDevNullReserves: l.maxDevNullReserves } }) + "\n");
}

/**
 * The renderer label `ss-v6.1-int32` is a CLAIM about the pinned `ss`; the round trip below can pass on small inodes with ANY ss, so the version the executable reports is checked first
 * (iproute2 6.1.x is the release that prints uint32 inodes through a signed int). Anything else, including empty output, refuses the issuance before any record is written.
 */
export const ssRendererVersionPattern = /^ss utility, iproute2-6\.1\.\d+(?:[ ,].*)?$/;
export function assertSsRendererVersion(output: string): void {
  const first = output.split("\n").map(line => line.trim()).find(line => line !== "");
  if (first === undefined || !ssRendererVersionPattern.test(first)) invalid();
}

/** Reciprocal round trip of a real socket pair through the pinned renderer. A positive rendered inode is a fact; both directions must agree with the kernel's own inode numbers. */
export function assertRendererRoundTrip(renderer: RendererPorts, profile: FdCollectorProfile): void {
  const pair = renderer.openPair();
  try {
    const rows = renderer.collect(profile);
    if (knownFdCollectorPeer(rows, pair.localInode) !== pair.peerInode || knownFdCollectorPeer(rows, pair.peerInode) !== pair.localInode) invalid();
  } finally { pair.close(); }
}

export function issueFdCollectorProfile(request: ProfileRequest, ports: ProfilePorts): ProfileOutcome {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.operationId) || !/^[a-f0-9]{40}$/.test(request.runtimeSha) || !request.runtimeDirectory.startsWith("/")) invalid();
  const executable = (path: string): FdExecutablePin => {
    const elfFiles = ports.measure(path), self = elfFiles.find(file => file.path === path);
    if (!self || elfFiles.length > elfClosureMaxFiles) invalid();
    return { path, sha256: self.sha256, elfFiles };
  };
  const runtime = ["dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js", "dist/worker-codex/hosted-dependency-installer-bootstrap.js",
    "dist/worker-codex/hosted-readonly-host-launch-cli.js", "dist/worker-codex/hosted-readonly-runtime-bootstrap.js"].map(relative => ports.pin(join(request.runtimeDirectory, relative)));
  const copied = ["managed-launcher/launch.mjs", "managed-launcher/host-inventory-codec.cjs", "managed-launcher/payload-guard.mjs", "managed-launcher/hosted-host-policy.mjs"]
    .map(relative => ports.pin(join(installedLauncherRoot, relative)));
  assertSsRendererVersion(ports.ssVersion());
  // the product parser is the authority on the shape; the draft only exists in memory until the renderer qualified it
  const profile = parseFdCollectorProfile({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed, ss: executable("/usr/bin/ss"), node: executable(ports.nodePath),
    wrappers: wrapperPaths.map(executable), bootstraps: [...runtime, ...copied], limits: { ...fdCollectorProfileLimitMaxima } });
  assertRendererRoundTrip(ports.renderer, profile);
  const bytes = encodeFdCollectorProfile(profile), profileSha256 = sha(bytes);
  const preparedPath = join(readonlySupervisorRoot, "ordinary-installations", `${request.operationId}.profile.json`);
  publishIdempotent(preparedPath, bytes, ports);
  ports.upgrade({ path: preparedPath, sha256: profileSha256 }, copied[0]?.sha256 ?? invalid(), copied[1]?.sha256 ?? invalid());
  const bootId = ports.bootId();
  const receipt = encodeIssuerReceipt({ schemaVersion: 1, kind: IssuerReceiptKind.FdCollectorProfile, issuerModuleSha256: ports.moduleSha256(), bootId,
    runtimeDirectory: request.runtimeDirectory, runtimeSha: request.runtimeSha, sourceScopeSha256: ports.sourceScopeSha256(), operationId: request.operationId, outputPath: preparedPath, outputSha256: profileSha256 });
  const receiptPath = issuerReceiptPathFor(IssuerReceiptKind.FdCollectorProfile, bootId, profileSha256);
  publishIdempotent(receiptPath, receipt, ports);
  return Object.freeze({ preparedPath, profileSha256, receiptPath, receiptSha256: sha(receipt) });
}

// ---- composition ----
const socketInodes = (pid: string): Set<string> => {
  const inodes = new Set<string>();
  for (const name of readdirSync(`/proc/${pid}/fd`)) {
    try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${name}`)); if (match?.[1]) inodes.add(match[1]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return inodes;
};
/** A child spawned with a piped stdin is connected through a kernel socket pair (libuv): the parent's new socket fd and the child's fd 0 are its two ends. */
export const nodeRendererPorts: RendererPorts = Object.freeze({
  openPair(): SocketPairFacts {
    const before = socketInodes("self");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], { stdio: ["pipe", "ignore", "ignore"] });
    const close = (): void => { child.stdin?.destroy(); child.kill("SIGKILL"); };        // the child is this function's own direct child
    try {
      if (!child.pid) invalid();
      const peer = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(`/proc/${child.pid}/fd/0`))?.[1];
      const added = [...socketInodes("self")].filter(inode => !before.has(inode));
      if (!peer || added.length !== 1 || added[0] === peer) invalid();
      return { localInode: added[0] ?? invalid(), peerInode: peer, close };
    } catch (error) { close(); throw error; }
  },
  collect: (profile: FdCollectorProfile): ReadonlyMap<string, FdCollectorPeer> => collectHostedFdPeers(profile),
});

export function runProfileIssuerOperation(request: ProfileRequest, prior: OrdinaryPriorCollectorProfile): ProfileOutcome {
  assertHostedActivationOperator();
  const scopeBytes = qualificationRead(join(request.runtimeDirectory, "ordinary-qualification-source.json"), 32 * 1024 * 1024);
  const ports: ProfilePorts = Object.freeze({
    ...nodePrivateRecordPorts(),
    nodePath: process.execPath,
    measure: (executable: string): readonly ElfPin[] => measureElfClosure(executable),
    pin(path: string): FdFilePin { return { path, sha256: sha(qualificationRead(path, 256 * 1024 * 1024)) }; },
    renderer: nodeRendererPorts,
    ssVersion(): string {
      const result = spawnSync("/usr/bin/ss", ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
      if (result.error || result.signal) invalid();
      return `${result.stdout}\n${result.stderr}`;           // older iproute2 prints the version on either stream
    },
    upgrade: (prepared: HostedInventoryFile, launcherSha256: string, codecSha256: string): void =>
      assertOrdinaryCollectorProfileUpgrade(request.operationId, prepared, prior, request.runtimeDirectory, launcherSha256, codecSha256),
    bootId: currentBootId,
    moduleSha256: (): string => ownModuleSha256(import.meta.url, IssuerReceiptKind.FdCollectorProfile, request.runtimeDirectory),
    sourceScopeSha256: (): string => sha(scopeBytes),
  });
  return issueFdCollectorProfile(request, ports);
}
