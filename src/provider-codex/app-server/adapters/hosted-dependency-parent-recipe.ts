import type { DependencyParentRecipeReader } from "../../../core/dependency-environment/dependency-parent-recipe-reader";
import type { HostedInventoryLaunch } from "../../../core/host-infrastructure/host-inventory";

/** Configuration facts from the original protected stored SDK plan. The actual
 * installed creator tuple and producer digest remain unchanged. This function
 * issues no origin, reservation, descriptor or execution permission. */
export function readHostedDependencyParentRecipe(launch: HostedInventoryLaunch, job: string, workspace: string, reader?: DependencyParentRecipeReader): HostedInventoryLaunch {
  if (launch.args[1] !== "tool") {
    assertHostedDependencyParentRecipe(launch.args, job, workspace, reader); return launch;
  }
  const args = launch.args;
  if (args.length !== 6 || args[2] !== "codex_goal_project_start" || args[3] !== "--args-json" ||
      args[5] !== "--json" || launch.cwd !== workspace) fail();
  if (!reader) fail();
  const resolved = reader.readStoredLaunch(launch, job, workspace);
  if (resolved.command !== launch.command || resolved.cwd !== launch.cwd || resolved.args[0] !== args[0]) fail();
  assertHostedDependencyParentRecipe(resolved.args, job, workspace, reader); return resolved;
}

import { isHostedDependencySignedTaskId } from "./hosted-dependency-root-purpose-record";
/** Closed N3 initial-host CLI writer recipe. It validates configuration only;
 * the caller must independently resolve the installed start/fence/binding. */
export function assertHostedDependencyParentRecipe(args: readonly string[], job: string, workspace: string, reader?: DependencyParentRecipeReader): void {
  const values = new Map<string, string>(), seen = new Set<string>();
  const scalar = new Set(["--task-id", "--job-id", "--job-root", "--workspace", "--prompt", "--output", "--progress", "--log",
    "--state-root", "--durable-handoff-root", "--registry-root", "--cwd", "--accounts", "--auth-root", "--codex-binary",
    "--format", "--model", "--effort", "--service-tier", "--execution-engine", "--model-backend", "--edit-mode", "--permission-mode",
    "--provider-sandbox-mode", "--project-access-scope-json", "--worker-report-mode", "--app-server-startup-timeout-ms", "--access-boundary", "--network-access",
    "--max-goal-turns", "--max-attempts", "--continuation-mode", "--codex-goal-objective", "--timeout-ms", "--timeout",
    "--progress-heartbeat-ms", "--max-account-cycles", "--stale-lock-ms", "--description", "--registry-description", "--tags", "--registry-tags"]);
  const flags = new Set(["--no-tmux", "--allow-duplicate-accounts", "--no-require-git-workspace", "--prewarm"]);
  if (!args[0]?.endsWith("/codex-goal-cli.js") || args[1] !== "run" || workspace !== `${job}/workspace`) fail();
  for (let i = 2; i < args.length; i++) {
    const name = args[i]!;
    if (seen.has(name) || !scalar.has(name) && !flags.has(name)) fail();
    seen.add(name);
    if (scalar.has(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || value.includes("\0")) fail();
      values.set(name, value);
    }
  }
  const task = values.get("--task-id");
  if (!isHostedDependencySignedTaskId(task) || values.get("--job-root") !== job || values.get("--workspace") !== workspace) fail();
  // Explicit finite scope removes both environment and HOME/~ default
  // resolution before the privileged account-capacity migration writer.
  if (values.get("--auth-root") !== `${job}/auth`) fail();
  const exactOptional = (key: string, expected: string) => { const v = values.get(key); if (v !== undefined && v !== expected) fail(); };
  exactOptional("--state-root", `${job}/state`); exactOptional("--durable-handoff-root", `${job}/durable-handoffs`);
  exactOptional("--registry-root", `${job}/state/registry`); exactOptional("--cwd", workspace);
  exactOptional("--progress", `${job}/${task}.progress.json`); exactOptional("--log", `${job}/${task}.log`);
  exactOptional("--execution-engine", "app-server-goal");
  exactOptional("--model-backend", "openai-chatgpt");
  const scopeJson = values.get("--project-access-scope-json");
  if (scopeJson !== undefined) {
    if (!reader) fail();
    const scope = reader.readProjectAccessScope(scopeJson);
    if (!scope || scope.registryRoot !== `${job}/state/registry` || !scope.workspaceRoots?.includes(workspace) ||
        scope.workspaceRoots.some(path => path !== workspace)) fail();
  }
  const sandbox = values.get("--provider-sandbox-mode");
  if (sandbox !== undefined && sandbox !== "read-only" && sandbox !== "workspace-write") fail();
  const output = values.get("--output");
  if (output !== undefined && output !== `${job}/${task}.latest-result.json` &&
      !(output.startsWith(`${job}/state/`) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}-result\.json$/.test(output.slice(`${job}/state/`.length)))) fail();
  // Prompt is read, but cannot collide with any root writer/custody leaf.
  const prompt = values.get("--prompt");
  if (!prompt || !prompt.startsWith(job + "/") || prompt.startsWith(workspace + "/") ||
      !(prompt === `${job}/prompt` || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.(?:md|txt)$/.test(prompt.slice(job.length + 1))) ||
      [output, `${job}/${task}.progress.json`, `${job}/${task}.log`, `${job}/encryption-key.hex`].includes(prompt)) fail();
}
export function assertHostedDependencyParentEnvironment(env: Readonly<Record<string, string | undefined>>, job: string): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.includes("\0") || /^(?:NODE_|LD_|DYLD_|GIT_)/.test(key) ||
        ["OPENSSL_CONF", "OPENSSL_MODULES", "GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES", "SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET",
          "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"].includes(key)) fail();
    if (key === "SUBSCRIPTION_RUNTIME_TMPDIR" && value !== `${job}/tmp` ||
        key === "SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT" && value !== `${job}/durable-handoffs` ||
        key === "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT" && value !== `${job}/auth`) fail();
    if (key === "CODEX_EXECUTION_ENGINE" && value !== "app-server-goal" ||
        key === "CODEX_MODEL_BACKEND" && value !== "openai-chatgpt" ||
        key === "SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON") fail();
    // Fixed host scratch helpers use findmnt/mount by name. A payload-selected
    // PATH must not redirect those initial-host effects to project executables.
    if (key === "PATH" && value !== "/usr/bin:/bin" && value !== "/usr/local/bin:/usr/bin:/bin") fail();
  }
}
function fail(): never { throw new Error("hosted_dependency_parent_recipe_unsupported"); }
