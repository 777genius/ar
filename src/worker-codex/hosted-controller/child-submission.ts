import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, rmdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";
import { KeyedChildState as State, type ChildCorrelation, type ChildScope, type KeyedChildLedger } from "../../worker-core/project-control/domain/keyed-child-launch";
import { type KeyedChildApplicationPort, type KeyedDispatchAcknowledgment, type KeyedScopedStopPort } from "../../worker-core/project-control/application/keyed-child-launch";
import { KeyedLaunchLedgerStore } from "./keyed-launch-ledger-store";
import { assertRetainedKeyedAuthority, RetainedKeyedAuthority } from "./retained-authority";
import { SlotMaterialization } from "./slot-materialization";

const permissions = new WeakSet<object>();
type PinnedDirectory = { readonly path: string; readonly dev: number; readonly ino: number };
/** Only a fresh successful intent publication creates this ephemeral object.
 * It is consumed before reservation, including on exceptions. Never serialized. */
export interface FreshKeyedSubmission { readonly binding: ChildCorrelation; readonly retained: RetainedKeyedAuthority }
export function consumeFreshKeyedSubmission(fence: HostedActivationFence, permission: FreshKeyedSubmission): void {
  assertHostedActivationFence(fence);
  if (!permissions.delete(permission)) throw new Error("keyed_submission_permission_required");
  permission.retained.assertCurrent();
}
export interface KeyedHostSubmissionPort {
  submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission): { readonly completion: Promise<void> };
}
/** Fixed PR3 command is executed by the existing ordinary bootstrap/parser.
 * No exposed environment, source/account override, detached process or restart. */
export class OrdinaryKeyedChildHost implements KeyedHostSubmissionPort {
  submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission): { completion: Promise<void> } {
    consumeFreshKeyedSubmission(fence, permission);
    // PR1–5 retain the admission gate, including direct constructor callers.
    assertKeyedActivationQualified();
    return submitOrdinary(fence, permission);
  }
}
/** Dormant same-fence ordinary composition. Admission remains closed above;
 * this seam persists the ledger's predetermined reservation/start before spawn.
 * It owns a foreground promise, never promotes process exit into proof. */
function submitOrdinary(fence: HostedActivationFence, permission: FreshKeyedSubmission): { completion: Promise<void> } {
  assertHostedActivationFence(fence);
  const slot = permission.retained.slot(permission.binding.slotId), store = new HostedInstallationActivationStore();
  const launch = store.reserveOrdinaryRuntime(fence, slot.launch.command, slot.launch.args, slot.launch.cwd,
    { startId: permission.binding.startId, unit: permission.binding.unitCorrelation });
  const invocation = new HostedReadonlyHostKernel().ordinaryRuntimeInvocation(launch.reservation, slot.launch.cwd);
  permission.retained.budget(slot.slotId).remainingMs();
  const child = spawn(invocation.command, [...invocation.args], { cwd: slot.launch.cwd,
    env: {}, stdio: ["pipe", "ignore", "ignore"] });
  // No credentials are read/serialized here. Private provider custody resolves
  // its own credentials; the ordinary bootstrap gets only fixed empty env.
  const completion = new Promise<void>((resolve, reject) => {
    child.stdin.once("error", () => reject(new Error("keyed_submission_uncertain")));
    child.once("error", () => reject(new Error("keyed_submission_uncertain")));
    child.once("exit", () => resolve());
  });
  child.stdin.end(Buffer.from(JSON.stringify({ schemaVersion: 1, env: {} })));
  return { completion };
}
function assertKeyedActivationQualified(): void { throw new Error("hosted_mimo_activation_closed"); }

/** Short controller/workspace coordination precedes the common sync host fence.
 * Preparation has separate per-slot ownership, never holds the control queue.
 * On a crash, lock directories persist: no PID takeover or recovery. */
export class KeyedChildDispatchAdapter implements KeyedChildApplicationPort {
  readonly scope: ChildScope;
  readonly authorityDigest: string;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly #parents: readonly PinnedDirectory[];
  #tail: Promise<void> = Promise.resolve();
  readonly #coordination = new AsyncLocalStorage<object>();
  readonly #leases = new WeakSet<object>();
  readonly #foreground = new Map<string, Promise<void>>();
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly ledger: KeyedLaunchLedgerStore,
    private readonly materialization: SlotMaterialization, private readonly host: KeyedHostSubmissionPort,
    readonly stopPort?: KeyedScopedStopPort) {
    assertRetainedKeyedAuthority(retained);
    this.scope = Object.freeze({ projectId: retained.authority.projectId, workstreamId: retained.authority.workstreamId,
      controllerId: retained.authority.controllerId });
    this.authorityDigest = retained.seed.authorityDigest;
    this.deadlineEpochMs = retained.authority.absoluteDeadline; this.maxGoalTurns = retained.authority.maxGoalTurns;
    this.#parents = ["/var/lib/subscription-runtime-host-policy/keyed-child-ledgers",
      ...retained.slots.map(s => s.jobRootDir)].map(path => ({ path, ...lstatSync(path) }));
  }
  authenticate(): void { this.retained.assertCurrent(); }
  beforeFreshClaim(slotId: string): void { this.retained.budget(slotId).remainingMs(); }
  async coordinate<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#tail; let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const held: { path: string; dev: number; ino: number }[] = [];
    const lease = Object.freeze({});
    try {
      this.authenticate();
      for (const [i, parent] of this.#parents.entries()) {
        const current = lstatSync(parent.path);
        if (!current.isDirectory() || current.uid !== 0 || (current.mode & 0o022) ||
            current.dev !== parent.dev || current.ino !== parent.ino) throw new Error("keyed_coordination_parent_changed");
        const path = join(parent.path, i === 0 ? `.controller-${this.authorityDigest}.lock` : ".keyed-workspace.lock");
        await mkdir(path, { mode: 0o700 });
        const lock = lstatSync(path); held.push({ path, dev: lock.dev, ino: lock.ino });
      }
      this.#leases.add(lease);
      return await this.#coordination.run(lease, action);
    } finally {
      this.#leases.delete(lease);
      try {
        for (const lock of held.reverse()) {
          const current = lstatSync(lock.path);
          if (!current.isDirectory() || current.dev !== lock.dev || current.ino !== lock.ino) throw new Error("keyed_coordination_changed");
          await rmdir(lock.path);
        }
      } finally { release(); }
    }
  }
  read(): KeyedChildLedger {
    this.#assertCoordination(); this.authenticate();
    return withHostedActivationFence(f => this.ledger.readHeld(f, this.scope, this.authorityDigest));
  }
  transact(scope: ChildScope, authorityDigest: string, generation: number, successor: (l: KeyedChildLedger) => KeyedChildLedger): Promise<KeyedChildLedger> {
    this.#assertCoordination(); this.authenticate(); return this.ledger.transact(scope, authorityDigest, generation, successor);
  }
  async materialize(binding: ChildCorrelation, task: string): Promise<void> {
    let ownership: PinnedDirectory & { readonly parent: PinnedDirectory } | undefined;
    try {
      await this.coordinate(async () => {
        const latest = this.read().observe(this.scope, binding.childHandle);
        if (latest.state !== State.Materializing || latest.generation !== binding.generation ||
            (["authorityDigest", "keyDigest", "requestDigest", "promptDigest", "slotId", "requestId",
              "operationId", "childHandle", "startId", "unitCorrelation", "profile"] as const)
              .some(field => latest[field] !== binding[field])) throw new Error("keyed_materialization_ineligible");
        // Coordination validates every pinned parent before acquiring ownership.
        // This distinct lock excludes other preparation owners without excluding control.
        const parent = this.#parents.find(p => p.path === this.retained.slot(binding.slotId).jobRootDir)!;
        const path = join(parent.path, ".keyed-materialization.lock");
        await mkdir(path, { mode: 0o700 });
        const lock = lstatSync(path); ownership = { path, dev: lock.dev, ino: lock.ino, parent };
      });
      this.authenticate();
      await this.materialization.materialize(binding, task);
    } finally {
      if (ownership) {
        const parent = lstatSync(ownership.parent.path), lock = lstatSync(ownership.path);
        if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) ||
            parent.dev !== ownership.parent.dev || parent.ino !== ownership.parent.ino ||
            !lock.isDirectory() || lock.dev !== ownership.dev || lock.ino !== ownership.ino) {
          throw new Error("keyed_materialization_ownership_changed");
        }
        await rmdir(ownership.path);
      }
    }
  }
  dispatchPrepared(binding: ChildCorrelation): KeyedDispatchAcknowledgment {
    this.#assertCoordination(); this.authenticate();
    return withHostedActivationFence(fence => {
      this.authenticate(); this.materialization.verify(binding);
      const current = this.ledger.readHeld(fence, this.scope, this.authorityDigest);
      const latest = current.observe(this.scope, binding.childHandle);
      // Stored intent/absence NEVER mints fresh permission; changed generation fails.
      if (latest.generation !== binding.generation || latest.dispatchIntent || latest.state !== State.Prepared) throw new Error("keyed_dispatch_ineligible");
      const intent = this.ledger.transactHeld(fence, this.scope, this.authorityDigest,
        current.generation, l => l.advance(binding, State.DispatchIntent, Date.now()));
      const permission = Object.freeze({ binding: intent.observe(this.scope, binding.childHandle), retained: this.retained });
      permissions.add(permission);
      try {
        const submitted = this.host.submitFresh(fence, permission);
        // Retain ownership even if acknowledgment publication fails afterwards.
        const observed = submitted.completion.catch(() => {});
        this.#foreground.set(binding.startId, observed);
        void observed.finally(() => this.#foreground.delete(binding.startId));
        const accepted = this.ledger.transactHeld(fence, this.scope, this.authorityDigest,
          intent.generation, l => l.advance(permission.binding, State.Submitted, Date.now()));
        return { observation: accepted.observe(this.scope, binding.childHandle), completion: submitted.completion };
      } finally { permissions.delete(permission); }
    });
  }
  #assertCoordination(): void {
    const lease = this.#coordination.getStore();
    if (!lease || !this.#leases.has(lease)) throw new Error("keyed_coordination_required");
  }
}
