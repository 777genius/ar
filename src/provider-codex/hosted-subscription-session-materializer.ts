import type { RedactorPort, SessionArtifact } from "@vioxen/subscription-runtime/core";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { types } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexAuthJsonFromArtifact } from "./codex-auth-json-codec";
import { codexAuthJsonMaxBytes, validateCodexAuthJsonBytes } from "./codex-cli-domain";
import { createTrustedCodexRuntimeTempRoot } from "./codex-runtime-temp";
import { writeCodexJsonHomeSnapshot } from "./codex-session-materializer";
import type { CodexMaterializedSession } from "./codex-json-execution-engine";
import { AppServerExecutionLifetime, bindAppServerSessionLifetime } from "./app-server/application/app-server-child-lifetime";
import {
  CodexSubscriptionConsumerRole, codexSubscriptionAppServerArgv, codexSubscriptionBoundsEqual,
  codexSubscriptionPreparedProfile, validateCodexSubscriptionPreparationBinding,
  type CodexSubscriptionPreparationRecord, type CodexSubscriptionPreparedProfile,
} from "./codex-subscription-preparation";

export enum CodexSubscriptionPreparationState {
  Created = "created", Preparing = "preparing", Prepared = "prepared", RejectedPending = "rejected_pending",
  RejectedSettled = "rejected_settled", HandedOffHeld = "handed_off_held", ReleasedUnused = "released_unused",
}
export enum CodexSubscriptionPreparationStatus { Created = "created", Preparing = "preparing", Prepared = "prepared", Rejected = "rejected", Held = "held", Released = "released" }
export enum CodexSubscriptionPreparationFailure { Invalid = "invalid", Consumed = "consumed", Unavailable = "unavailable" }
export enum CodexSubscriptionUnusedReleaseStatus { Released = "released_unused", RefusedPending = "refused_pending", Held = "held" }
export type CodexSubscriptionPreparationView =
  | { readonly status: CodexSubscriptionPreparationStatus.Rejected; readonly code: CodexSubscriptionPreparationFailure }
  | { readonly status: Exclude<CodexSubscriptionPreparationStatus, CodexSubscriptionPreparationStatus.Rejected> };
export type CodexSubscriptionPreparationInput = {
  readonly record: unknown;
  readonly expected: unknown;
  readonly selectedSession: { readonly binding: unknown; readonly artifact: SessionArtifact };
  readonly executionLifetime: AppServerExecutionLifetime;
  readonly childBudget?: ChildExecutionBudget;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly codexBinaryPath: string;
  /** Explicit minimal essentials only, never ambient process.env. */
  readonly processEssentials?: Readonly<{ readonly PATH?: string; readonly CI?: string; readonly LANG?: string; readonly LC_ALL?: string }>;
  readonly redactor: RedactorPort;
  readonly abortSignal: AbortSignal;
};
export type CodexSubscriptionPreparedConsumer = {
  readonly session: CodexMaterializedSession;
  readonly profile: CodexSubscriptionPreparedProfile;
  readonly executionLifetime: AppServerExecutionLifetime;
  readonly childBudget?: ChildExecutionBudget;
  readonly abortSignal: AbortSignal;
  readonly launch: { readonly command: string; readonly args: typeof codexSubscriptionAppServerArgv;
    readonly cwd: string; readonly env: Readonly<Record<string, string>> };
  toJSON(): CodexSubscriptionPreparationView;
};
type Identity = Pick<Stats, "dev" | "ino" | "uid">;
type Snapshot = {
  readonly record: CodexSubscriptionPreparationRecord;
  readonly authJson: string;
  readonly profile: CodexSubscriptionPreparedProfile;
  readonly executionLifetime: AppServerExecutionLifetime;
  readonly childBudget: ChildExecutionBudget | undefined;
  readonly jobRootDir: string;
  readonly tmpRoot: string;
  readonly workspacePath: string;
  readonly codexBinaryPath: string;
  readonly essentials: Readonly<Record<string, string>>;
  readonly redactor: RedactorPort;
  readonly abortSignal: AbortSignal;
};
function denied(): never { throw new Error("codex_subscription_preparation_invalid"); }
function privatePath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) denied();
  return value;
}
function contained(parent: string, path: string): boolean {
  const r = relative(parent, path);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
}
function snapshot(input: CodexSubscriptionPreparationInput): Snapshot {
  const { record } = validateCodexSubscriptionPreparationBinding({ record: input.record, expected: input.expected,
    selectedBinding: input.selectedSession.binding });
  const artifact = input.selectedSession.artifact;
  if (!artifact || types.isProxy(artifact) || Object.getPrototypeOf(artifact) !== Object.prototype ||
      Object.values(Object.getOwnPropertyDescriptors(artifact)).some(d => !Object.hasOwn(d, "value"))) denied();
  const selectedBytes = artifact.bytes;
  if (!types.isUint8Array(selectedBytes) || types.isProxy(selectedBytes)) denied();
  // Use the native typed-array bound before allocating the private copy; own
  // properties/subclasses must not underreport the actual selected byte length.
  const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!.call(selectedBytes) as number;
  if (!byteLength || byteLength > codexAuthJsonMaxBytes) denied();
  const bytes = new Uint8Array(selectedBytes);
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { denied(); }
  // Copy both the bytes and metadata before any asynchronous work can observe caller mutation.
  const authJson = codexAuthJsonFromArtifact({ kind: artifact.kind, providerId: artifact.providerId,
    formatVersion: artifact.formatVersion, bytes, contentType: artifact.contentType });
  if (!Buffer.from(authJson, "utf8").equals(bytes)) denied();
  const auth = validateCodexAuthJsonBytes({ authJsonBytes: authJson }).parsed;
  if (auth.OPENAI_API_KEY !== undefined && auth.OPENAI_API_KEY !== null && auth.OPENAI_API_KEY !== "") denied();
  const fence = input.executionLifetime;
  if (!(fence instanceof AppServerExecutionLifetime) || fence.deadlineEpochMs !== record.bounds.deadlineEpochMs ||
      fence.maxGoalTurns !== record.bounds.maxGoalTurns) denied();
  if (record.role === CodexSubscriptionConsumerRole.Child) {
    if (!(input.childBudget instanceof ChildExecutionBudget) || fence.childBudget !== input.childBudget ||
        !codexSubscriptionBoundsEqual(record.bounds, input.childBudget.lifetime)) denied();
  } else if (input.childBudget !== undefined || fence.childBudget !== undefined) denied();
  const jobRootDir = privatePath(input.jobRootDir), workspacePath = privatePath(input.workspacePath);
  if (contained(workspacePath, jobRootDir) || contained(jobRootDir, workspacePath)) denied();
  const essentials: Record<string, string> = {};
  if (input.processEssentials !== undefined) {
    const env = input.processEssentials;
    if (types.isProxy(env) || Object.getPrototypeOf(env) !== Object.prototype ||
        Object.values(Object.getOwnPropertyDescriptors(env)).some(d => !Object.hasOwn(d, "value"))) denied();
    for (const [key, value] of Object.entries(env)) {
      if (!["PATH", "CI", "LANG", "LC_ALL"].includes(key) || typeof value !== "string" || value.includes("\0")) denied();
      essentials[key] = value;
    }
  }
  return Object.freeze({ record, authJson, profile: codexSubscriptionPreparedProfile(record), executionLifetime: fence,
    childBudget: input.childBudget, jobRootDir, tmpRoot: join(jobRootDir, "tmp"), workspacePath,
    codexBinaryPath: privatePath(input.codexBinaryPath), essentials: Object.freeze(essentials),
    redactor: input.redactor, abortSignal: input.abortSignal });
}
function privateDirectory(stat: Stats): boolean {
  const uid = process.getuid?.();
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && uid !== undefined && stat.uid === uid;
}
async function privateAncestry(path: string): Promise<void> {
  let ancestor = path;
  while (true) {
    const stat = await fs.lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) denied();
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}
async function directory(path: string): Promise<Stats> {
  const stat = await fs.lstat(path);
  if (!privateDirectory(stat) || await fs.realpath(path) !== path) denied();
  await privateAncestry(path);
  return stat;
}
function same(stat: Stats, identity: Identity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === identity.uid;
}
const ownerToken = Object.freeze({});

/** The caller retains this opaque owner BEFORE starting any materialization.
 * Its original pending promise, late results and partial roots never leave custody. */
export class CodexSubscriptionPreparationOwner {
  #snapshot: Snapshot;
  #state = CodexSubscriptionPreparationState.Created;
  #failure = CodexSubscriptionPreparationFailure.Unavailable;
  #proposedPrefix: string | undefined;
  #prefixIdentity: Identity | undefined;
  #allocationAttempted = false;
  #prefixAcquired = false;
  #collision = false;
  #jobIdentity: Identity | undefined;
  #tmpIdentity: Identity | undefined;
  #originalPending: Promise<CodexMaterializedSession> | undefined;
  #closed = true;
  #session: CodexMaterializedSession | undefined;
  #cleanup: Promise<CodexSubscriptionUnusedReleaseStatus> | undefined;
  #cleanupFailed = false;

  constructor(token: typeof ownerToken, preparedSnapshot: Snapshot) {
    if (token !== ownerToken) denied();
    this.#snapshot = preparedSnapshot;
    Object.freeze(this);
  }
  static isOriginal(value: unknown): value is CodexSubscriptionPreparationOwner {
    return typeof value === "object" && value !== null && #snapshot in value;
  }
  toJSON(): CodexSubscriptionPreparationView {
    switch (this.#state) {
      case CodexSubscriptionPreparationState.Created: return { status: CodexSubscriptionPreparationStatus.Created };
      case CodexSubscriptionPreparationState.Preparing: return { status: CodexSubscriptionPreparationStatus.Preparing };
      case CodexSubscriptionPreparationState.Prepared: return { status: CodexSubscriptionPreparationStatus.Prepared };
      case CodexSubscriptionPreparationState.RejectedPending:
      case CodexSubscriptionPreparationState.RejectedSettled: return { status: CodexSubscriptionPreparationStatus.Rejected, code: this.#failure };
      case CodexSubscriptionPreparationState.HandedOffHeld: return { status: CodexSubscriptionPreparationStatus.Held };
      case CodexSubscriptionPreparationState.ReleasedUnused: return { status: CodexSubscriptionPreparationStatus.Released };
    }
  }
  async prepare(): Promise<CodexSubscriptionPreparationView> {
    if (this.#state !== CodexSubscriptionPreparationState.Created) {
      return { status: CodexSubscriptionPreparationStatus.Rejected, code: CodexSubscriptionPreparationFailure.Consumed };
    }
    this.#state = CodexSubscriptionPreparationState.Preparing;
    try {
      this.#active();
      this.#snapshot.executionLifetime.enterMaterialization(this.#snapshot.abortSignal);
      this.#proposedPrefix = join(this.#snapshot.tmpRoot, `codex-subscription-${randomUUID()}`);
      this.#closed = false;
      // Record intent before scheduling; track BOTH settlements before the bounded wait.
      const original = Promise.resolve().then(() => this.#materialize());
      this.#originalPending = original.then(session => {
        this.#session = session;
        this.#closed = true;
        if (this.#state === CodexSubscriptionPreparationState.RejectedPending) this.#state = CodexSubscriptionPreparationState.RejectedSettled;
        return session;
      }, error => {
        this.#closed = true;
        this.#reject();
        throw error;
      });
      await this.#snapshot.executionLifetime.wait(this.#originalPending, this.#snapshot.abortSignal);
      this.#active();
      if (this.#state !== CodexSubscriptionPreparationState.Preparing) throw new Error("codex_subscription_preparation_lost");
      this.#state = CodexSubscriptionPreparationState.Prepared;
    } catch { this.#reject(); }
    return this.toJSON();
  }
  #active(): void { this.#snapshot.executionLifetime.assertActive(this.#snapshot.abortSignal); }
  #reject(): void {
    this.#state = this.#closed ? CodexSubscriptionPreparationState.RejectedSettled : CodexSubscriptionPreparationState.RejectedPending;
  }
  async #materialize(): Promise<CodexMaterializedSession> {
    const s = this.#snapshot, prefix = this.#proposedPrefix!;
    this.#active();
    this.#jobIdentity = await directory(s.jobRootDir);
    this.#active();
    this.#tmpIdentity = await directory(s.tmpRoot);
    this.#active();
    this.#allocationAttempted = true;
    try { await fs.mkdir(prefix, { mode: 0o700 }); } // exclusive: EEXIST is never adoption
    catch (error) {
      this.#collision = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
      throw error;
    }
    // Journal the exclusive acquisition before dependent validation/creation awaits.
    this.#prefixAcquired = true;
    const acquiredStat = await fs.lstat(prefix);
    this.#prefixIdentity = { dev: acquiredStat.dev, ino: acquiredStat.ino, uid: acquiredStat.uid };
    if (!same(await directory(prefix), this.#prefixIdentity)) denied();
    this.#active();
    const root = await createTrustedCodexRuntimeTempRoot({ prefix: "session-", sourceEnv: {
      SUBSCRIPTION_RUNTIME_JOB_ROOT: prefix, SUBSCRIPTION_RUNTIME_TMPDIR: join(prefix, "tmp"),
    } });
    this.#active();
    await directory(root);
    this.#active();
    const home = join(root, "home"), codexHome = join(root, "codex-home"), tmp = join(root, "consumer-tmp");
    for (const path of [home, codexHome, tmp]) {
      await fs.mkdir(path, { mode: 0o700 });
      this.#active();
      await directory(path);
      this.#active();
    }
    s.redactor.registerSecret(s.authJson, "codex-subscription-auth");
    this.#active();
    await writeCodexJsonHomeSnapshot({ codexHome, authJson: s.authJson, configToml: s.profile.configToml });
    this.#active();
    for (const [name, contents] of [["auth.json", s.authJson], ["config.toml", s.profile.configToml]] as const) {
      const path = join(codexHome, name), stat = await fs.lstat(path);
      this.#active();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) denied();
      const bytes = await fs.readFile(path);
      this.#active();
      if (!bytes.equals(Buffer.from(contents, "utf8"))) denied();
    }
    const env = Object.freeze({ ...s.essentials, HOME: home, CODEX_HOME: codexHome, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    const session: CodexMaterializedSession & { toJSON(): CodexSubscriptionPreparationView } = {
      home, codexHome, env,
      // Used resources deliberately remain held. No disposal receipt or release-used capability.
      release: async () => { throw new Error("codex_subscription_used_session_held"); },
      toJSON: () => this.toJSON(),
    };
    const bound = bindAppServerSessionLifetime(session, s.executionLifetime);
    this.#active();
    return Object.freeze(bound);
  }
  takeSessionForConsumer(): CodexSubscriptionPreparedConsumer {
    if (this.#state !== CodexSubscriptionPreparationState.Prepared || !this.#session) throw new Error("codex_subscription_handoff_denied");
    try {
      this.#active();
      const s = this.#snapshot;
      const consumer = Object.freeze({ session: this.#session, profile: s.profile, executionLifetime: s.executionLifetime,
        ...(s.childBudget === undefined ? {} : { childBudget: s.childBudget }), abortSignal: s.abortSignal,
        launch: Object.freeze({ command: s.codexBinaryPath, args: codexSubscriptionAppServerArgv,
          cwd: s.workspacePath, env: this.#session.env }), toJSON: () => this.toJSON() });
      this.#active();
      this.#state = CodexSubscriptionPreparationState.HandedOffHeld;
      return consumer;
    } catch { this.#reject(); throw new Error("codex_subscription_handoff_denied"); }
  }
  async releaseUnused(): Promise<CodexSubscriptionUnusedReleaseStatus> {
    if (this.#state === CodexSubscriptionPreparationState.HandedOffHeld || this.#cleanupFailed) return CodexSubscriptionUnusedReleaseStatus.Held;
    if (!this.#closed || this.#state === CodexSubscriptionPreparationState.Preparing) return CodexSubscriptionUnusedReleaseStatus.RefusedPending;
    if (this.#state === CodexSubscriptionPreparationState.ReleasedUnused) return CodexSubscriptionUnusedReleaseStatus.Released;
    if (this.#cleanup) return this.#cleanup;
    // Invalidate handoff synchronously before cleanup's first await.
    this.#reject();
    this.#cleanup = this.#release();
    return this.#cleanup;
  }
  async #release(): Promise<CodexSubscriptionUnusedReleaseStatus> {
    try {
      if (this.#prefixIdentity) {
        if (!this.#proposedPrefix || !this.#jobIdentity || !this.#tmpIdentity) denied();
        const s = this.#snapshot;
        if (!same(await directory(s.jobRootDir), this.#jobIdentity) || !same(await directory(s.tmpRoot), this.#tmpIdentity) ||
            !same(await directory(this.#proposedPrefix), this.#prefixIdentity)) denied();
        await fs.rm(this.#proposedPrefix, { recursive: true, force: false });
      } else if (this.#prefixAcquired || (this.#allocationAttempted && !this.#collision)) {
        // Uncertain acquisition/identity stays held; a proposed path is never deletion authority.
        denied();
      }
      this.#state = CodexSubscriptionPreparationState.ReleasedUnused;
      return CodexSubscriptionUnusedReleaseStatus.Released;
    } catch {
      this.#cleanupFailed = true;
      return CodexSubscriptionUnusedReleaseStatus.Held;
    }
  }
}
export function createHostedSubscriptionPreparationOwner(input: CodexSubscriptionPreparationInput): CodexSubscriptionPreparationOwner {
  try { return new CodexSubscriptionPreparationOwner(ownerToken, snapshot(input)); }
  catch { throw new Error("codex_subscription_preparation_invalid"); }
}
export function prepareHostedSubscriptionConsumer(owner: CodexSubscriptionPreparationOwner): Promise<CodexSubscriptionPreparationView> {
  if (!CodexSubscriptionPreparationOwner.isOriginal(owner)) return Promise.resolve({ status: CodexSubscriptionPreparationStatus.Rejected, code: CodexSubscriptionPreparationFailure.Invalid });
  try { return owner.prepare(); }
  catch { return Promise.resolve({ status: CodexSubscriptionPreparationStatus.Rejected, code: CodexSubscriptionPreparationFailure.Invalid }); }
}
