import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { hostedFdTable } from "../provider-codex/app-server/adapters/hosted-fd-table";
import { hostedInventoryMaximumBytes } from "../core/host-infrastructure/host-inventory";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { collectProcessBirth } from "./hosted-readonly-linux-collector";
import { readHostedInstallationActivation } from "./hosted-installation-activation";
import { parseStoredProjectStartBinding, readStoredProjectStartPlan, resolveStoredProjectStartPlan, type StoredProjectStartPlan } from "./stored-start-planning";

export type HostedForegroundRequest = Readonly<{ path: string; jobRoot: string; args: readonly string[] }>;
type Prior = { fd: number; dev: number; ino: number; byteLength: number; flags: number; sha256: string };
const requests = new WeakMap<HostedForegroundRequest, { command: string; cwd: string; birth: string; installationId: string; inventorySha256: string; prior?: Prior }>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function denied(): never { throw new Error("hosted_foreground_result_unresolved"); }
function ancestry(path: string): void {
  for (let directory = dirname(path);; directory = dirname(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) denied();
    if (directory === "/") break;
  }
}
function positionedBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const count = readSync(fd, bytes, offset, size - offset, offset); if (count < 1) denied(); offset += count; }
  if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) denied(); return bytes;
}
function flags(fd: number): number {
  const value = /^flags:\s+([0-7]{1,12})$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
  if (!value) denied(); const parsed = Number.parseInt(value[1]!, 8);
  if ((parsed & 3) !== 0 || !(parsed & 0o2000000) || parsed & 0o10000000) denied(); return parsed;
}
function checkPrior(prior: Prior, path?: string): void {
  const before = fstatSync(prior.fd);
  if (!before.isFile() || before.uid !== 0 || (before.mode & 0o077) || before.nlink > 1 || before.size !== prior.byteLength ||
      before.dev !== prior.dev || before.ino !== prior.ino || flags(prior.fd) !== prior.flags) denied();
  if (path) { const named = lstatSync(path); if (named.dev !== prior.dev || named.ino !== prior.ino || before.nlink !== 1) denied(); }
  if (hash(positionedBytes(prior.fd, prior.byteLength)) !== prior.sha256) denied();
  const after = fstatSync(prior.fd);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs || flags(prior.fd) !== prior.flags) denied();
}
export function selectedRequest(args: readonly string[], cwd: string): HostedForegroundRequest {
  if (args[1] === "tool") {
    const plan = storedRequestPlan(args, cwd);
    return Object.freeze({ path: plan.output, jobRoot: plan.jobRoot, args: Object.freeze([...args]) });
  }
  const indices = args.flatMap((arg, i) => arg === "--output" ? [i] : []);
  const jobRoot = dirname(cwd), path = indices.length === 1 ? args[indices[0]! + 1] : undefined;
  const option = (name: string) => {
    const at = args.flatMap((arg, i) => arg === name ? [i] : []);
    if (at.length !== 1) denied(); return args[at[0]! + 1];
  };
  const task = option("--task-id");
  const defaultPath = task && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(task) ? `${jobRoot}/${task}.latest-result.json` : undefined;
  const stateResult = path?.startsWith(`${jobRoot}/state/`) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}-result\.json$/.test(path.slice(`${jobRoot}/state/`.length));
  if (!args[0]?.endsWith("/codex-goal-cli.js") || args[1] !== "run" || cwd !== `${jobRoot}/workspace` ||
      args.some(arg => ["--dry-run", "--print-command", "--tmux", "--tmux-session", "--hosted-lifecycle"].includes(arg) ||
        /^(?:--dry-run|--print-command|--tmux|--tmux-session|--hosted-lifecycle)=/.test(arg)) ||
      option("--job-root") !== jobRoot || option("--workspace") !== cwd ||
      args.some(arg => arg.startsWith("--output=")) || !path || path !== defaultPath && !stateResult ||
      !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) denied();
  for (const [i, arg] of args.entries()) {
    const value = args[i + 1];
    if (value && (["--prompt", "--progress", "--log", "--checkpoint-publisher-socket"].includes(arg) && value === path ||
        ["--auth-root", "--workspace", "--registry-root", "--durable-handoff-root"].includes(arg) &&
        (value === path || path.startsWith(value + "/")))) denied();
  }
  return Object.freeze({ path, jobRoot, args: Object.freeze([...args]) });
}
export function storedRequestPlan(args: readonly string[], cwd: string): StoredProjectStartPlan {
  if (args.length !== 6 || args[1] !== "tool" || args[2] !== "codex_goal_project_start" ||
      args[3] !== "--args-json" || typeof args[4] !== "string" || args[5] !== "--json") denied();
  const plan = readStoredProjectStartPlan(args[4], cwd);
  if (args[0] !== plan.launch.cliCommand?.[1]) denied();
  // preStart receipt/state may change during the real broker admission. Result
  // selection still binds the original manifests, scope, prompt and recipe.
  const expected = parseStoredProjectStartBinding(plan.args.storedStartBinding);
  const { preStart: _expectedPreStart, ...fixedExpected } = expected;
  const { preStart: _currentPreStart, ...fixedCurrent } = plan.binding;
  if (JSON.stringify(fixedExpected) !== JSON.stringify(fixedCurrent)) denied();
  return plan;
}

export function installedInventory() {
  assertReadonlyHostOperator();
  const origin = readHostedInstallationActivation(), inventory = readHostedReadonlyHostInventory();
  const bytes = readHostedPrivateBytes(`${readonlySupervisorRoot}/readonly-inventory.json`, hostedInventoryMaximumBytes);
  if ((inventory.schemaVersion !== 4 && inventory.schemaVersion !== 5) || !bytes || hash(bytes) !== origin.installation.inventorySha256) denied();
  return { ...origin, inventory };
}
export function requireHostedForegroundRequest(args: readonly string[], cwd: string): HostedForegroundRequest {
  return withHostedActivationFence(() => {
    const { inventory, installation } = installedInventory();
    const launches = [inventory.runtimeLaunch, ...inventory.ordinaryCreators.map(row => row.launch)];
    const selected = launches.filter(launch => launch.cwd === cwd && JSON.stringify(launch.args) === JSON.stringify(args));
    if (!selected.length || new Set(selected.map(row => row.command)).size !== 1) denied();
    const request = selectedRequest(args, cwd);
    if (args[1] === "tool") resolveStoredProjectStartPlan(args[4]!, cwd);
    ancestry(request.path);
    const birth = collectProcessBirth(String(process.pid));
    let prior: Prior | undefined, opened = false;
    try {
      const fd = openSync(request.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); opened = true;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 64 * 1024 * 1024) denied();
        const bytes = positionedBytes(fd, stat.size), current = lstatSync(request.path);
        if (stat.dev !== current.dev || stat.ino !== current.ino) denied();
        prior = { fd, dev: stat.dev, ino: stat.ino, byteLength: stat.size, flags: flags(fd), sha256: hash(bytes) };
        checkPrior(prior, request.path);
      } catch (error) { closeSync(fd); throw error; }
    } catch (error) { if (opened || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    requests.set(request, { command: selected[0]!.command, cwd, birth,
      installationId: installation.installationId, inventorySha256: installation.inventorySha256, ...(prior ? { prior } : {}) }); return request;
  });
}
export function closeHostedForegroundRequest(request: HostedForegroundRequest): void {
  const baseline = requests.get(request); requests.delete(request);
  if (baseline?.prior) closeSync(baseline.prior.fd);
}
/** Called synchronously from the original Store submission/release callback.
 * The retained request is data; the surrounding existing fence owns effects. */
export function recheckHostedForegroundRequest(request: HostedForegroundRequest, fence: HostedActivationFence): void {
  assertHostedActivationFence(fence);
  const baseline = requests.get(request);
  if (!baseline || baseline.birth !== collectProcessBirth(String(process.pid))) denied();
  if (baseline.prior) checkPrior(baseline.prior, request.path);
  if (request.args[1] !== "tool") return;
  const plan = storedRequestPlan(request.args, `${request.jobRoot}/workspace`);
  if (plan.jobRoot !== request.jobRoot || plan.output !== request.path) denied();
  resolveStoredProjectStartPlan(request.args[4]!, plan.workspace);
}

/** Original parent observer-file custody only; provider and child policies stay strict. */
export function assertHostedForegroundRequestDescriptors(request: HostedForegroundRequest, fence: HostedActivationFence,
  launch: Readonly<{ command: string; args: readonly string[]; cwd: string }>): void {
  assertHostedActivationFence(fence); assertReadonlyHostOperator();
  const baseline = requests.get(request), { installation } = installedInventory();
  if (!baseline || baseline.birth !== collectProcessBirth(String(process.pid)) || baseline.command !== launch.command || baseline.cwd !== launch.cwd ||
      JSON.stringify(request.args) !== JSON.stringify(launch.args) || baseline.installationId !== installation.installationId ||
      baseline.inventorySha256 !== installation.inventorySha256) denied();
  if (baseline.prior) checkPrior(baseline.prior, request.path);
  const facts = hostedFdTable(process.pid);
  for (const fd of [0, 1, 2]) if (!facts.some(row => row.fd === fd && (row.pipe || row.socket))) denied();
  for (const row of facts) if (row.fd > 2 && (row.file || row.directory) && (!baseline.prior || row.fd !== baseline.prior.fd ||
      !row.file || row.directory || row.dev !== String(baseline.prior.dev) || row.ino !== String(baseline.prior.ino) || row.flags !== baseline.prior.flags)) denied();
  if (baseline.prior) checkPrior(baseline.prior, request.path);
}
export function assertHostedForegroundPriorOutput(request: HostedForegroundRequest, current: Readonly<{ dev: number; ino: number }>): void {
  const baseline = requests.get(request);
  if (!baseline || baseline.birth !== collectProcessBirth(String(process.pid))) denied();
  if (baseline.prior) {
    checkPrior(baseline.prior);
    if (current.dev === baseline.prior.dev && current.ino === baseline.prior.ino) denied();
  }
}
