import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

import type { ChildCorrelation } from "../../worker-core/project-control/domain/keyed-child-launch";
import { assertRetainedKeyedAuthority, RetainedKeyedAuthority } from "./retained-authority";
import { PreparationEffect as Effect } from "../../worker-core/hosted-custody/domain/preintent-preparation";
import type { PreparationAdmissionPort } from "../../worker-core/hosted-custody/ports/preintent-preparation";

/** Fixed Git effects use the original consumer-owned supervision operation.
 * The adapter records creation prefixes before invoking its native start. */
export interface PreparationMaterializationPort extends PreparationAdmissionPort {
  git(binding: ChildCorrelation, effect: Effect, args: readonly string[], remainingMs: number): Promise<{ readonly stdout: string }>;
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** No provisioning: all authority parents are already private PR3 inventory.
 * Inodes and canonical ancestry are pinned BEFORE staging and rebound after it. */
export class SlotMaterialization {
  readonly #parents = new Map<string, Stats>();
  readonly #workspaces = new Map<string, Stats>();
  readonly #plans = new Map<string, Buffer>();
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly sourceRoot: string) {
    assertRetainedKeyedAuthority(retained);
    for (const path of [sourceRoot, ...retained.slots.flatMap(s => [s.jobRootDir, dirname(s.promptPath)])]) {
      for (let parent = path;; parent = dirname(parent)) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(parent) !== parent) fail();
        this.#parents.set(parent, stat);
        if (parent === "/") break;
      }
    }
  }
  preparationPlanDigest(binding: ChildCorrelation): string {
    this.#check();
    const slot = this.retained.slot(binding.slotId);
    return createHash("sha256").update(JSON.stringify(["original-keyed-preparation", 1,
      this.sourceRoot, slot.promptPath, slot.workspacePath, slot.jobRootDir, slot.sourceSha,
      "/usr/bin/git", "core.hooksPath=/dev/null", "clone --no-local --no-checkout",
      "checkout --detach", "rev-parse HEAD", "core.fsmonitor=false status --porcelain --untracked-files=all"])).digest("hex");
  }
  #check(cleanup = false): void {
    if (cleanup) this.retained.assertCleanup(); else this.retained.assertCurrent();
    for (const [path, stat] of this.#parents) {
      const actual = lstatSync(path);
      if (!actual.isDirectory() || actual.uid !== 0 || (actual.mode & 0o022) ||
          !same(stat, actual) || realpathSync(path) !== path) fail();
    }
  }
  #read(path: string, cleanup = false): Buffer | null {
    this.#check(cleanup);
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let fd: number | undefined;
    try {
      if (!same(fstatSync(parent), this.#parents.get(dirname(path))!)) fail();
      const anchored = `/proc/self/fd/${parent}/${path.slice(dirname(path).length + 1)}`;
      try { fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { this.#check(cleanup); return null; } throw e; }
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size > 32768) fail();
      const bytes = readFileSync(fd), after = fstatSync(fd);
      if (!same(before, lstatSync(anchored)) || after.size !== before.size || bytes.length !== before.size ||
          after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) fail();
      this.#check(cleanup); return bytes;
    } finally { if (fd !== undefined) closeSync(fd); closeSync(parent); }
  }
  #publish(path: string, bytes: Buffer): void {
    this.#check();
    const prior = this.#read(path);
    if (prior && !prior.equals(bytes)) fail();
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let fd: number | undefined;
    try {
      if (!same(fstatSync(parent), this.#parents.get(dirname(path))!)) fail();
      fd = openSync(`/proc/self/fd/${parent}/${path.slice(dirname(path).length + 1)}`,
        prior ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.uid !== 0 || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600) fail();
      if (!prior) writeFileSync(fd, bytes);
      fsyncSync(fd);
      const synced = fstatSync(fd);
      fsyncSync(parent);
      const final = lstatSync(path);
      if (!same(synced, final) || synced.size !== final.size || synced.ctimeMs !== final.ctimeMs ||
          synced.mtimeMs !== final.mtimeMs || !this.#read(path)?.equals(bytes)) fail();
      this.#check();
    } finally { if (fd !== undefined) closeSync(fd); closeSync(parent); }
    // Failures retain partial files, never overwrite, unlink or retry them.
  }
  async materialize(binding: ChildCorrelation, task: string, effects: PreparationMaterializationPort): Promise<void> {
    this.#check();
    const slot = this.retained.slot(binding.slotId), budget = this.retained.budget(binding.slotId);
    budget.remainingMs();
    if (createHash("sha256").update(task, "utf8").digest("hex") !== binding.promptDigest) fail();
    const manifestPath = join(slot.jobRootDir, "keyed-child-manifest.json"), planPath = join(slot.jobRootDir, "keyed-publication.json");
    // Retain resolved defaults/timestamps once. A partial plan itself conflicts.
    let plan = this.#read(planPath);
    if (!plan) {
      const timestamp = new Date().toISOString();
      // A private keyed manifest is not a generic runnable job/operation file.
      // Effective defaults are PR3's immutable argv/lifetime, not renewed here.
      const manifest = { schemaVersion: 1, createdAt: timestamp, updatedAt: timestamp,
        slot, requestDigest: binding.requestDigest };
      plan = Buffer.from(JSON.stringify({ bindingDigest: this.retained.seed.authorityDigest,
        requestDigest: binding.requestDigest, artifactSha: slot.artifactSha, sourceSha: slot.sourceSha,
        manifest: JSON.stringify(manifest) + "\n" }) + "\n");
      const publication = plan;
      await effects.effect(binding, Effect.PublicationPlan, () => this.#publish(planPath, publication));
    }
    if (this.#plans.has(slot.slotId) && !plan.equals(this.#plans.get(slot.slotId)!)) fail();
    this.#plans.set(slot.slotId, Buffer.from(plan));
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plan));
    if (Object.keys(decoded).sort().join(",") !== "artifactSha,bindingDigest,manifest,requestDigest,sourceSha" ||
        decoded.bindingDigest !== this.retained.seed.authorityDigest || decoded.requestDigest !== binding.requestDigest ||
        decoded.artifactSha !== slot.artifactSha || decoded.sourceSha !== slot.sourceSha || typeof decoded.manifest !== "string") fail();
    if (!plan.equals(Buffer.from(JSON.stringify({ bindingDigest: this.retained.seed.authorityDigest,
      requestDigest: binding.requestDigest, artifactSha: slot.artifactSha, sourceSha: slot.sourceSha,
      manifest: decoded.manifest }) + "\n"))) fail();
    const manifest = JSON.parse(decoded.manifest);
    if (Object.keys(manifest).sort().join(",") !== "createdAt,requestDigest,schemaVersion,slot,updatedAt" ||
        manifest.schemaVersion !== 1 || JSON.stringify(manifest.slot) !== JSON.stringify(slot) ||
        manifest.requestDigest !== binding.requestDigest || typeof manifest.createdAt !== "string" ||
        !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.updatedAt !== manifest.createdAt ||
        decoded.manifest !== JSON.stringify(manifest) + "\n") fail();
    await effects.effect(binding, Effect.Prompt, () => this.#publish(slot.promptPath, Buffer.from(task)));
    budget.remainingMs(); this.#check();
    // No fallback clone/checkout after partial effects. Opaque fixed slot owns it.
    try { lstatSync(slot.workspacePath); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await effects.git(binding, Effect.SourceClone, ["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-checkout", "--", this.sourceRoot, slot.workspacePath], Math.min(30000, budget.remainingMs()));
      this.#check(); budget.remainingMs();
      const stagedWorkspace = lstatSync(slot.workspacePath);
      if (!stagedWorkspace.isDirectory() || realpathSync(slot.workspacePath) !== slot.workspacePath ||
          !lstatSync(join(slot.workspacePath, ".git")).isDirectory() ||
          realpathSync(join(slot.workspacePath, ".git")) !== join(slot.workspacePath, ".git")) fail();
      this.#workspaces.set(slot.slotId, stagedWorkspace);
      await effects.git(binding, Effect.SourceCheckout, ["-C", slot.workspacePath, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", slot.sourceSha], Math.min(30000, budget.remainingMs()));
    }
    this.#check(); budget.remainingMs();
    const workspace = lstatSync(slot.workspacePath);
    if (!workspace.isDirectory() || realpathSync(slot.workspacePath) !== slot.workspacePath ||
        (this.#workspaces.has(slot.slotId) && !same(this.#workspaces.get(slot.slotId)!, workspace))) fail();
    const head = await effects.git(binding, Effect.SourceHead, ["-C", slot.workspacePath, "rev-parse", "HEAD"], Math.min(5000, budget.remainingMs()));
    this.#check(); budget.remainingMs();
    if (head.stdout.trim() !== slot.sourceSha || !same(workspace, lstatSync(slot.workspacePath))) fail();
    const clean = await effects.git(binding, Effect.SourceStatus, ["-C", slot.workspacePath, "-c", "core.fsmonitor=false",
      "status", "--porcelain", "--untracked-files=all"], Math.min(5000, budget.remainingMs()));
    this.#check(); budget.remainingMs();
    if (clean.stdout.length || !same(workspace, lstatSync(slot.workspacePath))) fail();
    await effects.effect(binding, Effect.Manifest, () => this.#publish(manifestPath, Buffer.from(decoded.manifest)));
    this.#workspaces.set(slot.slotId, workspace);
  }
  /** Final partial files are descriptive facts, never quiescence authority.
   * Called only after joining the original writer and native subtree. */
  rereadPartial(binding: ChildCorrelation): void {
    this.#check(true);
    const slot = this.retained.cleanupSlot(binding.slotId);
    for (const path of [slot.promptPath, join(slot.jobRootDir, "keyed-publication.json"),
      join(slot.jobRootDir, "keyed-child-manifest.json")]) this.#read(path, true);
    this.#check(true);
  }
  verify(binding: ChildCorrelation): void {
    this.#check();
    const slot = this.retained.slot(binding.slotId);
    this.retained.budget(binding.slotId).remainingMs();
    const workspace = this.#workspaces.get(slot.slotId);
    if (!workspace || !same(workspace, lstatSync(slot.workspacePath)) || realpathSync(slot.workspacePath) !== slot.workspacePath) fail();
    const gitDir = lstatSync(join(slot.workspacePath, ".git"));
    if (!gitDir.isDirectory() || realpathSync(join(slot.workspacePath, ".git")) !== join(slot.workspacePath, ".git")) fail();
    const headFd = openSync(join(slot.workspacePath, ".git", "HEAD"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (readFileSync(headFd, "utf8") !== slot.sourceSha + "\n") fail(); } finally { closeSync(headFd); }
    const planBytes = this.#read(join(slot.jobRootDir, "keyed-publication.json"));
    if (!planBytes || !this.#plans.get(slot.slotId)?.equals(planBytes)) fail();
    const plan = JSON.parse(planBytes.toString("utf8"));
    const prompt = this.#read(slot.promptPath);
    if (plan.requestDigest !== binding.requestDigest || plan.bindingDigest !== this.retained.seed.authorityDigest ||
        plan.sourceSha !== slot.sourceSha || plan.artifactSha !== slot.artifactSha || !prompt ||
        createHash("sha256").update(prompt).digest("hex") !== binding.promptDigest ||
        !this.#read(join(slot.jobRootDir, "keyed-child-manifest.json"))?.equals(Buffer.from(plan.manifest))) fail();
  }
}
function fail(): never { throw new Error("keyed_publication_conflict"); }
