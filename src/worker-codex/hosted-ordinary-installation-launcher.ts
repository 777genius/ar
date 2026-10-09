import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseFdCollectorProfile, type HostedInventoryFile } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationOperator, withHostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { assertQualifiedPairForPublication, type QualifiedOrdinaryLauncherPair } from "./hosted-ordinary-installation-qualification";
import { assertOriginalOrdinaryInstallationClosed, assertOriginalOrdinaryInstallationOperation,
  type OriginalOrdinaryInstallationClosed, type OrdinaryInstallationOperation } from "./hosted-ordinary-installation-owned";
export type { OrdinaryInstallationOperation } from "./hosted-ordinary-installation-owned";

const destination = "/opt/subscription-runtime";
const names = ["managed-launcher/launch.mjs", "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs", "managed-launcher/hosted-host-policy.mjs"] as const;
const codecName = "managed-launcher/host-inventory-codec.cjs";
const profilePath = "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("ordinary_launcher_publication_held"); }
export type OrdinaryCopiedFile = Readonly<{ sha256: string; dev: number; ino: number; ctimeMs: number; mtimeMs: number }>;
export type OrdinaryCopiedCohort = Readonly<Record<typeof names[number], OrdinaryCopiedFile>>;
export type OrdinaryPriorCollectorProfile = Readonly<{ kind: "absent" }> | (OrdinaryCopiedFile & Readonly<{ kind: "present" }>);

function protectedFile(path: string, privateFile = false): { bytes: Buffer; identity: OrdinaryCopiedFile } {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const entry = lstatSync(parent);
    if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) ||
        privateFile && parent === dirname(path) && (entry.mode & 0o077)) invalid();
    if (parent === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & (privateFile ? 0o077 : 0o022)) ||
        before.size < 1 || before.size > (privateFile ? 65536 : 4 * 1024 * 1024)) invalid();
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== bytes.length ||
        before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
        after.ctimeMs !== current.ctimeMs || after.mtimeMs !== current.mtimeMs) invalid();
    return { bytes, identity: Object.freeze({ sha256: hash(bytes), dev: before.dev, ino: before.ino, ctimeMs: before.ctimeMs, mtimeMs: before.mtimeMs }) };
  } finally { closeSync(fd); }
}
function priorProfile(prior: OrdinaryPriorCollectorProfile): Buffer | undefined {
  if (prior.kind !== "absent" && prior.kind !== "present") invalid();
  let current: ReturnType<typeof protectedFile> | undefined;
  try { current = protectedFile(profilePath, true); }
  catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== "ENOENT" || e.path !== profilePath || e.syscall !== "open") throw error;
  }
  if (prior.kind === "absent") { if (current) invalid(); return undefined; }
  if (!current || (Object.keys(current.identity) as (keyof OrdinaryCopiedFile)[]).some(key => current!.identity[key] !== prior[key])) invalid();
  return current.bytes;
}

/** Cold read-only compatibility check; no funding or qualifier is constructed. */
export function assertOrdinaryCollectorProfileUpgrade(operationId: string, prepared: HostedInventoryFile,
  prior: OrdinaryPriorCollectorProfile, artifact: string, launcherSha256: string, codecSha256: string): void {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) invalid();
  if (prepared.path !== `/var/lib/subscription-runtime-host-policy/ordinary-installations/${operationId}.profile.json`) invalid();
  const bytes = protectedFile(prepared.path, true).bytes;
  if (hash(bytes) !== prepared.sha256) invalid();
  const next = parseFdCollectorProfile(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const oldBytes = priorProfile(prior), old = oldBytes ? parseFdCollectorProfile(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(oldBytes))) : undefined;
  const runtimePins = [
    ["hosted-app-server-launcher.js", "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js"],
    ...["hosted-dependency-installer-bootstrap.js", "hosted-readonly-host-launch-cli.js", "hosted-readonly-runtime-bootstrap.js"].map(name => [name, `dist/worker-codex/${name}`]),
  ];
  const copiedPins = [["launch.mjs", names[0], launcherSha256], ["host-inventory-codec.cjs", codecName, codecSha256], ["payload-guard.mjs", names[1], hash(protectedFile(join(destination, names[1])).bytes)],
    ["hosted-host-policy.mjs", names[4], hash(protectedFile(join(destination, names[4])).bytes)]];
  const expected = new Map<string, HostedInventoryFile>();
  for (const [name, relative] of runtimePins) {
    const path = join(artifact, relative!); expected.set(name!, { path, sha256: hash(protectedFile(path).bytes) });
  }
  for (const [name, relative, sha256] of copiedPins) {
    if (hash(protectedFile(join(artifact, "host-integration", relative!)).bytes) !== sha256) invalid();
    expected.set(name!, { path: join(destination, relative!), sha256: sha256! });
  }
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const related = (pin: HostedInventoryFile) => runtimePins.some(([name]) => name === base(pin.path)) ||
    copiedPins.some(([, relative]) => pin.path === join(destination, relative!));
  if (new Set(next.bootstraps.map(pin => base(pin.path))).size !== next.bootstraps.length ||
      [...expected].some(([name, pin]) => !next.bootstraps.some(row => base(row.path) === name && row.path === pin.path && row.sha256 === pin.sha256))) invalid();
  if (old) {
    if (new Set(old.bootstraps.map(pin => base(pin.path))).size !== old.bootstraps.length) invalid();
    const fixed = (profile: typeof next) => ({ ...profile, bootstraps: undefined });
    if (!isDeepStrictEqual(fixed(old), fixed(next))) invalid();
    for (const pin of old.bootstraps) if (!related(pin) &&
        !next.bootstraps.some(row => row.path === pin.path && row.sha256 === pin.sha256)) invalid();
    for (const pin of next.bootstraps) if (!related(pin) &&
        !old.bootstraps.some(row => row.path === pin.path && row.sha256 === pin.sha256)) invalid();
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function stage(path: string, bytes: Buffer, privateFile = false): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, privateFile ? 0o600 : 0o644);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
  if (!protectedFile(path, privateFile).bytes.equals(bytes)) invalid();
}

/** One original issuer owns this transaction. Qualified handles are supplied
 * only by the real retained NEWTEST producer; JSON cannot construct one. Every
 * mutation shares the existing activation fence, including original consume. */
export class OrdinaryLauncherPublication {
  private state: "prepared" | "published" | "consumed" | "restored" | "held" = "prepared";
  private consumed = false;
  private exposed = false;
  private readonly root: string;
  private readonly launcher: Buffer;
  private readonly codec: Buffer;
  private readonly oldLauncher: Buffer;
  private readonly profile: Buffer;
  private readonly oldProfile: Buffer | undefined;
  private readonly qualification: ReturnType<typeof assertQualifiedPairForPublication>;

  constructor(private readonly operation: OrdinaryInstallationOperation,
    private readonly pair: QualifiedOrdinaryLauncherPair,
    private readonly cohort: OrdinaryCopiedCohort,
    private readonly preparedProfile: HostedInventoryFile,
    private readonly priorCollectorProfile: OrdinaryPriorCollectorProfile) {
    this.root = join("/var/lib/subscription-runtime-host-policy/ordinary-installations", operation.operationId);
    this.assertOperation(false);
    this.qualification = assertQualifiedPairForPublication(pair, operation);
    const artifactDirectory = this.qualification.candidateArtifactPath;
    this.launcher = protectedFile(join(artifactDirectory, "host-integration", names[0])).bytes;
    this.codec = protectedFile(join(artifactDirectory, "host-integration", codecName)).bytes;
    if (hash(this.launcher) !== this.qualification.launcherSha256 || hash(this.codec) !== this.qualification.codecSha256) invalid();
    if (preparedProfile.sha256 !== this.qualification.profileSha256) invalid();
    this.assertProfileUpgrade();
    this.profile = protectedFile(preparedProfile.path, true).bytes;
    this.oldProfile = priorProfile(priorCollectorProfile);
    this.assertCohort(); this.assertCodec();
    this.oldLauncher = protectedFile(join(destination, names[0])).bytes;
    if (this.oldLauncher.length > 65536) invalid();
  }
  private assertProfileUpgrade(): void {
    assertOrdinaryCollectorProfileUpgrade(this.operation.operationId, this.preparedProfile, this.priorCollectorProfile,
      this.qualification.candidateArtifactPath, this.qualification.launcherSha256, this.qualification.codecSha256);
  }
  private assertPublishedProfile(): void {
    if (!protectedFile(profilePath, true).bytes.equals(this.profile)) invalid();
  }
  private expose(): void {
    this.assertOperation(false);
    if (this.exposed) return;
    this.exposed = true;
    createReadonlyPrivateRecord(join(this.root, "launcher-exposed.json"), Buffer.from(this.operation.operationSha256 + "\n"));
    this.assertOperation(false);
  }

  private assertOperation(cleanup: boolean): void {
    assertHostedActivationOperator();
    assertOriginalOrdinaryInstallationOperation(this.operation, !cleanup);
    const op = this.operation;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(op.operationId) ||
        !/^[a-f0-9]{64}$/.test(op.operationSha256) || !Number.isSafeInteger(op.workEndEpochMs) ||
        !Number.isSafeInteger(op.cleanupEndEpochMs) || op.cleanupEndEpochMs <= op.workEndEpochMs ||
        Date.now() >= (cleanup ? op.cleanupEndEpochMs : op.workEndEpochMs)) invalid();
    const bytes = readHostedPrivateBytes(join(this.root, "operation.json"), 65536);
    if (!bytes || hash(bytes) !== op.operationSha256) invalid();
    const retained = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (retained.schemaVersion !== 2 || retained.operationId !== op.operationId || retained.workEndEpochMs !== op.workEndEpochMs || retained.cleanupEndEpochMs !== op.cleanupEndEpochMs ||
        !isDeepStrictEqual(retained.copiedCohort, this.cohort) ||
        !isDeepStrictEqual(retained.preparedCollectorProfile, this.preparedProfile) ||
        !isDeepStrictEqual(retained.priorCollectorProfile, this.priorCollectorProfile)) invalid();
  }
  private assertCohort(launcherSha256?: string): void {
    for (const name of names) {
      const identity = protectedFile(join(destination, name)).identity;
      if (name === names[0] && launcherSha256) {
        if (identity.sha256 !== launcherSha256) invalid();
      } else if ((Object.keys(identity) as (keyof OrdinaryCopiedFile)[]).some(key => identity[key] !== this.cohort[name][key])) invalid();
    }
  }
  private assertCodec(required = false): void {
    try { if (!protectedFile(join(destination, codecName)).bytes.equals(this.codec)) invalid(); }
    catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (required || e.code !== "ENOENT" || e.path !== join(destination, codecName) || e.syscall !== "open") throw error;
    }
  }
  publish(): void {
    if (this.state !== "prepared") invalid();
    try {
      withHostedActivationFence(() => {
        this.assertOperation(false); assertQualifiedPairForPublication(this.pair, this.operation);
        this.assertCohort(); this.assertCodec(); this.assertProfileUpgrade();
        createReadonlyPrivateRecord(join(this.root, "launcher.before.mjs"), this.oldLauncher);
        if (this.oldProfile) createReadonlyPrivateRecord(join(this.root, "collector-profile.before.json"), this.oldProfile);
        createReadonlyPrivateRecord(join(this.root, "launcher-publication.json"), Buffer.from(JSON.stringify({
          operationSha256: this.operation.operationSha256, cohort: this.cohort, priorCollectorProfile: this.priorCollectorProfile, ...this.qualification }) + "\n"));
        const launcherStage = join(destination, `managed-launcher/launch.${this.operation.operationId}.next`);
        const codecStage = join(destination, `managed-launcher/codec.${this.operation.operationId}.next`);
        const profileStage = `/var/lib/subscription-runtime-host-policy/fd-collector-profile.${this.operation.operationId}.next`;
        stage(launcherStage, this.launcher);
        stage(codecStage, this.codec);
        stage(profileStage, this.profile, true);
        this.assertOperation(false); this.assertCohort(); this.assertCodec(); this.assertProfileUpgrade();
        // An existing identical codec is retained; conflicting/partial bytes
        // never enter an overwrite or retry path.
        try { protectedFile(join(destination, codecName)); }
        catch (error) {
          const e = error as NodeJS.ErrnoException;
          if (e.code !== "ENOENT" || e.path !== join(destination, codecName) || e.syscall !== "open") throw error;
          this.assertOperation(false);
          stage(join(destination, codecName), this.codec);
        }
        this.assertCodec(true); this.assertOperation(false); this.assertCohort(); this.assertProfileUpgrade();
        if (!this.oldProfile?.equals(this.profile)) {
          this.expose();
          if (this.priorCollectorProfile.kind === "absent") {
            stage(profilePath, this.profile, true);
          } else renameSync(profileStage, profilePath);
          syncDirectory(dirname(profilePath));
        }
        this.assertPublishedProfile(); this.assertOperation(false); this.assertCohort();
        // Global exposure may be consumed by routes outside this issuer. Record
        // uncertainty before rename, never infer nonconsumption from no child.
        this.expose();
        renameSync(launcherStage, join(destination, names[0])); syncDirectory(dirname(launcherStage));
        this.assertCohort(this.qualification.launcherSha256); this.assertCodec(true); this.assertPublishedProfile(); this.assertOperation(false);
        createReadonlyPrivateRecord(join(this.root, "launcher-published.json"), Buffer.from(JSON.stringify(this.qualification) + "\n"));
        this.assertOperation(false);
        this.state = "published";
      });
    } catch (error) { this.state = "held"; throw error; }
  }
  /** The sole fixed issuer must call before its original supervisor spawn. A
   * failed spawn stays consumed; missing PIDs never reopen preconsume rollback. */
  consumeBeforeOriginalSupervisorBirth(): void {
    if (this.state !== "published" || this.consumed) invalid();
    try {
      withHostedActivationFence(() => {
        this.assertOperation(false); this.assertCohort(this.qualification.launcherSha256); this.assertCodec(true); this.assertPublishedProfile();
        this.assertOperation(false);
        this.consumed = true;
        createReadonlyPrivateRecord(join(this.root, "launcher-consumed.json"), Buffer.from(this.operation.operationSha256 + "\n"));
        this.assertOperation(false);
        this.state = "consumed";
      });
    } catch (error) { this.state = "held"; throw error; }
  }
  rollbackBeforeConsumption(): void {
    if (this.state !== "held" || this.consumed || this.exposed) invalid();
    withHostedActivationFence(() => {
      if (readHostedPrivateBytes(join(this.root, "launcher-consumed.json"), 4096) ||
          readHostedPrivateBytes(join(this.root, "launcher-exposed.json"), 4096)) invalid();
      this.restore();
    });
  }
  retainExposedPairAfterOriginalClosure(closure: OriginalOrdinaryInstallationClosed): "HELD_FOREIGN_CONSUMPTION_UNRESOLVED" {
    if (this.state !== "consumed") invalid();
    return withHostedActivationFence(() => {
      assertOriginalOrdinaryInstallationClosed(closure, this.operation);
      // Original supervisor closure does not discharge foreign HostJobs routes
      // that could have read the exposed global pair. Retain partial evidence.
      createReadonlyPrivateRecord(join(this.root, "launcher-foreign-consumption-held.json"), Buffer.from(JSON.stringify({
        operationSha256: this.operation.operationSha256, launcherSha256: this.qualification.launcherSha256,
        codecSha256: this.qualification.codecSha256, profileSha256: this.qualification.profileSha256,
        reason: "HELD_FOREIGN_CONSUMPTION_UNRESOLVED" }) + "\n"));
      this.state = "held";
      return "HELD_FOREIGN_CONSUMPTION_UNRESOLVED" as const;
    });
  }
  private restore(): void {
    this.assertOperation(true); this.assertCohort(); this.assertCodec();
    const profile = priorProfile(this.priorCollectorProfile);
    if (this.oldProfile && !profile?.equals(this.oldProfile) || !this.oldProfile && profile) invalid();
    const retained = readHostedPrivateBytes(join(this.root, "launcher.before.mjs"), 65536);
    if (!retained?.equals(this.oldLauncher)) invalid();
    // The consumer was never replaced. Retain any inert staged/new helper and
    // exact old cohort; removing partial files would destroy recovery evidence.
    if (!protectedFile(join(destination, names[0])).bytes.equals(retained)) invalid();
    createReadonlyPrivateRecord(join(this.root, "launcher-restored.json"), Buffer.from(this.operation.operationSha256 + "\n"));
    this.assertOperation(true);
    this.state = "restored";
  }
}
