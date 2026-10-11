import { buildCodexGoalForegroundArgv } from "../../worker-codex/application/codex-goal-foreground-command";
import { describe, expect, it, vi } from "vitest";
import { sdkRecipe } from "./hosted-dependency-sdk-recipe.fixture";
import { planStoredProjectStart } from "../../worker-codex/stored-start-planning";
const snapshots=vi.hoisted(()=>new Map<string,Buffer>());
vi.mock("../../worker-codex/hosted-readonly-inputs",async original=>({...await original<typeof import("../../worker-codex/hosted-readonly-inputs")>(),
 readHostedPrivateBytes:(path:string)=>snapshots.get(path)}));
import { assertHostedDependencyParentEnvironment, assertHostedDependencyParentRecipe, readHostedDependencyParentRecipe } from "../app-server/adapters/hosted-dependency-parent-recipe";
const job = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-parent", workspace = `${job}/workspace`;
const args = ["/opt/test-runtime/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", "TEST-parent", "--job-root", job,
  "--workspace", workspace, "--prompt", `${job}/prompt`, "--auth-root", `${job}/auth`, "--output", `${job}/TEST-parent.latest-result.json`];
describe("N3 fixed initial-host writer configuration", () => {
  it.each(["read-only", "workspace-write"])("accepts safe default roots for named mode %s", mode => {
    expect(() => assertHostedDependencyParentRecipe([...args, "--provider-sandbox-mode", mode], job, workspace)).not.toThrow();
  });
  // Regression: a signed task containing @ must keep its exact fixed writer
  // leaves; expanding identity through rewriting or a partial match is unsafe.
  it("uses the exact signed task grammar for fixed writer names", () => {
    const selected = (task: string) => { const current = [...args]; current[3] = task;
      current[current.length-1] = `${job}/${task}.latest-result.json`; return current; };
    for (const task of ["task@1", "a".repeat(128)]) {
      expect(() => assertHostedDependencyParentRecipe(selected(task),job,workspace)).not.toThrow();
    }
    for (const task of ["a".repeat(129),"task@1\n","task@1\r","../task","task/leaf","task\0leaf"]) {
      expect(() => assertHostedDependencyParentRecipe(selected(task),job,workspace)).toThrow();
    }
  });
  it("rejects root writes into the qualified tree or private cache before the payload", () => {
    for (const flag of ["--state-root", "--durable-handoff-root", "--progress", "--output", "--registry-root", "--log"]) {
      const base = flag === "--output" ? args.slice(0, -2) : args;
      for (const target of [`${workspace}/node_modules/marker`, `${job}/tool-cache/vite-vitest-config-free-v1/marker`]) {
        expect(() => assertHostedDependencyParentRecipe([...base, flag, target], job, workspace)).toThrow();
      }
    }
  });
  it("rejects duplicate, equals, alias and unknown writer options", () => {
    for (const tail of [["--task-id", "other"], ["--state-root=/tmp"], ["--state-root", `${job}/state/../workspace`],
      ["--new-writer-root", `${workspace}/node_modules`], ["--dry-run"],
      ["--execution-engine", "codex-cli"], ["--model-backend", "xiaomi-mimo-token-plan"]]) {
      expect(() => assertHostedDependencyParentRecipe([...args, ...tail], job, workspace)).toThrow();
    }
  });
  it("rejects inherited root temp/handoff/loader/PATH redirects while retaining fixed defaults", () => {
    expect(() => assertHostedDependencyParentEnvironment({ PATH: "/usr/bin:/bin", SUBSCRIPTION_RUNTIME_TMPDIR: `${job}/tmp` }, job)).not.toThrow();
    for (const env of [{ SUBSCRIPTION_RUNTIME_TMPDIR: `${workspace}/node_modules` },
      { SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT: `${workspace}/node_modules` }, { PATH: `${workspace}/bin:/usr/bin:/bin` },
      { NODE_OPTIONS: "--import=./payload.js" }, { GIT_CONFIG_GLOBAL: `${workspace}/payload` },
      { CODEX_EXECUTION_ENGINE: "codex-cli" }, { CODEX_MODEL_BACKEND: "xiaomi-mimo-token-plan" },
      { SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON: "{}" },
      { SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: `${workspace}/node_modules/auth` }]) {
      expect(() => assertHostedDependencyParentEnvironment(env, job)).toThrow();
    }
  });
  it("requires the explicit enrolled auth leaf before capacity migration, independent of HOME defaults", () => {
    const withoutAuth = args.filter((_, i) => i !== 10 && i !== 11);
    expect(() => assertHostedDependencyParentRecipe(withoutAuth, job, workspace)).toThrow();
    for (const auth of [`${workspace}/node_modules/auth`, `${job}/tool-cache/auth`, "~/.cache/subscription-runtime/live-codex-auth",
      `${job}/auth/../auth`, "/tmp/auth"]) {
      const redirected = [...args]; redirected[11] = auth;
      expect(() => assertHostedDependencyParentRecipe(redirected, job, workspace)).toThrow();
    }
    expect(() => assertHostedDependencyParentEnvironment({ HOME: `${workspace}/node_modules`, SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: `${job}/auth` }, job)).not.toThrow();
  });
});

describe("original protected SDK dependency recipe facts",()=>{
 it("accepts the supported original foreground builder fields for the exact closed TEST scope",()=>{
  const original=sdkRecipe(snapshots, job),request=JSON.parse(original.args[4]!);
  const captured={controller:snapshots.get(job+"/state/registry/TEST-control/job.json")!,worker:snapshots.get(job+"/state/registry/TEST-parent/job.json")!,
    prompt:snapshots.get(job+"/prompt")!,preStart:null};
  const plan=planStoredProjectStart(JSON.stringify(request),workspace,captured);
  expect(()=>assertHostedDependencyParentRecipe(buildCodexGoalForegroundArgv(plan.launch).slice(1),job,workspace)).not.toThrow();
 });
 it("resolves the exact original stored tuple to signed task/root facts without replacing that tuple",()=>{
  const original=sdkRecipe(snapshots, job),before=JSON.stringify(original),resolved=readHostedDependencyParentRecipe(original,job,workspace);
  expect(resolved.args.slice(1,3)).toEqual(["run","--no-tmux"]);expect(resolved.args).toContain("--task-id");
  expect(()=>assertHostedDependencyParentRecipe(resolved.args,job,workspace)).not.toThrow();expect(JSON.stringify(original)).toBe(before);
 });
 it("refuses stale manifest bytes and bypass/foreign SDK requests before exposing task facts",()=>{
  const original=sdkRecipe(snapshots, job);const manifest=job+"/state/registry/TEST-parent/job.json",actual=snapshots.get(manifest)!;
  snapshots.set(manifest,Buffer.concat([actual,Buffer.from("\n")]));expect(()=>readHostedDependencyParentRecipe(original,job,workspace)).toThrow();
  for(const patch of [{skipDoctor:true},{forceStart:true},{dependencyBootstrap:"install"},{registryRootDir:"/foreign/registry"}]){
    const current=sdkRecipe(snapshots, job),request=JSON.parse(current.args[4]!);current.args[4]=JSON.stringify({...request,...patch});
    expect(()=>readHostedDependencyParentRecipe(current,job,workspace)).toThrow();
  }
 });
});
