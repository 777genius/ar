import {
  AgentRuntimeAccessBoundary, ChildContinuationMode, parseChildLifetime,
  type ChildLifetime,
} from "@vioxen/subscription-runtime/core";
import { types } from "node:util";
import { CodexModelBackend } from "./codex-model-backend";
import type { CodexExecutionProfile } from "./codex-execution-profile";
import type { CodexSandboxMode } from "./codex-json-execution-engine";
import { hostedControllerDynamicToolSpecs } from "./app-server/domain/hosted-controller-dynamic-tools";

/** Preparation DATA. This schema conveys no hosted admission or native authority. */
export enum CodexSubscriptionConsumerRole { Controller = "controller", Child = "child" }
export enum CodexSubscriptionReasoningEffort { Medium = "medium", High = "high", XHigh = "xhigh" }
export type CodexSubscriptionControllerBounds = {
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly maxAttempts: 1;
  readonly maxAccountCycles: 1;
  readonly continuationMode: ChildContinuationMode.Disabled;
  readonly denyProjectInstructions: true;
};
type CommonRecord = {
  readonly schemaVersion: 1;
  readonly controllerId: string;
  readonly allocationId: string;
  readonly incarnationId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly grantSha256: string;
  readonly sourceSha: string;
  readonly artifactSha: string;
  readonly modelBackend: CodexModelBackend.OpenAiChatGpt;
  readonly model: "gpt-6.1-sol";
  readonly reasoningEffort: CodexSubscriptionReasoningEffort;
  readonly serviceTier: null;
};
export type CodexSubscriptionPreparationRecord = CommonRecord & (
  | { readonly role: CodexSubscriptionConsumerRole.Controller; readonly bounds: CodexSubscriptionControllerBounds }
  | { readonly role: CodexSubscriptionConsumerRole.Child; readonly slotId: string; readonly bounds: ChildLifetime }
);
export type CodexSubscriptionSelectedBinding = Pick<CommonRecord,
  "controllerId" | "allocationId" | "incarnationId" | "jobId" | "accountId" | "grantSha256" | "sourceSha" | "artifactSha"> & (
  | { readonly role: CodexSubscriptionConsumerRole.Controller }
  | { readonly role: CodexSubscriptionConsumerRole.Child; readonly slotId: string }
);

const commonKeys = ["schemaVersion", "role", "controllerId", "allocationId", "incarnationId", "jobId", "accountId",
  "grantSha256", "sourceSha", "artifactSha", "modelBackend", "model", "reasoningEffort", "serviceTier", "bounds"];
const bindingKeys = ["role", "controllerId", "allocationId", "incarnationId", "jobId", "accountId", "grantSha256", "sourceSha", "artifactSha"];
const controllerBoundsKeys = ["deadlineEpochMs", "maxGoalTurns", "maxAttempts", "maxAccountCycles", "continuationMode", "denyProjectInstructions"];

function invalid(): never { throw new Error("codex_subscription_preparation_invalid"); }
/** Reject getters before reading any DATA, including nested bounds/arrays. */
export function snapshotCodexSubscriptionData(value: unknown, depth = 0): unknown {
  if (depth > 8) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object") return invalid();
  if (types.isProxy(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return invalid();
  } else if (proto !== Object.prototype && proto !== null) return invalid();
  if (Reflect.ownKeys(value).length > 32) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string")) return invalid();
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) return invalid();
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
        Object.keys(descriptors).length !== value.length + 1) return invalid();
    return Object.freeze(value.map(entry => snapshotCodexSubscriptionData(entry, depth + 1)));
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) return invalid();
    result[key] = snapshotCodexSubscriptionData(descriptor.value, depth + 1);
  }
  return Object.freeze(result);
}
function keys(record: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(record).sort().join(",") !== [...expected].sort().join(",")) invalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((v, i) => equal(v, right[i]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = object(left), b = object(right);
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function parseCodexSubscriptionPreparationRecord(value: unknown): CodexSubscriptionPreparationRecord {
  const r = object(snapshotCodexSubscriptionData(value));
  const child = r.role === CodexSubscriptionConsumerRole.Child;
  if (!child && r.role !== CodexSubscriptionConsumerRole.Controller) invalid();
  keys(r, [...commonKeys, ...(child ? ["slotId"] : [])]);
  for (const key of ["controllerId", "allocationId", "incarnationId", "jobId", ...(child ? ["slotId"] : [])]) {
    if (typeof r[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(r[key])) invalid();
  }
  if (typeof r.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(r.accountId) ||
      r.schemaVersion !== 1 || r.modelBackend !== CodexModelBackend.OpenAiChatGpt || r.model !== "gpt-6.1-sol" ||
      !Object.values(CodexSubscriptionReasoningEffort).includes(r.reasoningEffort as CodexSubscriptionReasoningEffort) || r.serviceTier !== null ||
      typeof r.grantSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.grantSha256) ||
      [r.sourceSha, r.artifactSha].some(v => typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v))) invalid();
  if (child) {
    const bounds = parseChildLifetime(r.bounds);
    if (bounds.accountId !== r.accountId) invalid();
    return Object.freeze({ ...r, bounds }) as CodexSubscriptionPreparationRecord;
  }
  const bounds = object(r.bounds);
  keys(bounds, controllerBoundsKeys);
  if (!Number.isSafeInteger(bounds.deadlineEpochMs) || (bounds.deadlineEpochMs as number) < 1 ||
      !Number.isSafeInteger(bounds.maxGoalTurns) || (bounds.maxGoalTurns as number) < 1 ||
      bounds.maxAttempts !== 1 || bounds.maxAccountCycles !== 1 || bounds.continuationMode !== ChildContinuationMode.Disabled ||
      bounds.denyProjectInstructions !== true) invalid();
  return r as CodexSubscriptionPreparationRecord;
}
export function validateCodexSubscriptionPreparationBinding(input: {
  readonly record: unknown; readonly expected: unknown; readonly selectedBinding: unknown;
}): { readonly record: CodexSubscriptionPreparationRecord; readonly binding: CodexSubscriptionSelectedBinding } {
  const record = parseCodexSubscriptionPreparationRecord(input.record);
  const expected = parseCodexSubscriptionPreparationRecord(input.expected);
  if (!equal(record, expected)) invalid();
  const binding = object(snapshotCodexSubscriptionData(input.selectedBinding));
  keys(binding, [...bindingKeys, ...(record.role === CodexSubscriptionConsumerRole.Child ? ["slotId"] : [])]);
  for (const key of Object.keys(binding)) if (!equal(binding[key], (record as unknown as Record<string, unknown>)[key])) invalid();
  return Object.freeze({ record, binding: binding as CodexSubscriptionSelectedBinding });
}
export function codexSubscriptionBoundsEqual(left: unknown, right: unknown): boolean { return equal(left, snapshotCodexSubscriptionData(right)); }

type PreparedProfileCommon = {
  readonly modelBackend: CodexModelBackend.OpenAiChatGpt;
  readonly model: "gpt-6.1-sol";
  readonly reasoningEffort: CodexSubscriptionReasoningEffort;
  readonly serviceTier: null;
  readonly sandboxMode: CodexSandboxMode;
  readonly executionProfile: CodexExecutionProfile;
  readonly nativeToolSurface: "disabled";
  readonly cleanThreadPrewarm: false;
  readonly goalMode: true;
  readonly maxGoalTurns: number;
  readonly configToml: string;
};
export type CodexSubscriptionPreparedProfile = PreparedProfileCommon & (
  | { readonly role: CodexSubscriptionConsumerRole.Controller; readonly dynamicTools: typeof hostedControllerDynamicToolSpecs }
  | { readonly role: CodexSubscriptionConsumerRole.Child; readonly dynamicTools: readonly [];
      readonly allowedTools: ChildLifetime["allowedTools"]; readonly accessBoundary: ChildLifetime["accessBoundary"] }
);
export function codexSubscriptionPreparedProfile(record: CodexSubscriptionPreparationRecord): CodexSubscriptionPreparedProfile {
  const childBounds = record.role === CodexSubscriptionConsumerRole.Child ? record.bounds : undefined;
  const sandboxMode = childBounds?.accessBoundary === AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite
    ? "workspace-write" : "read-only";
  // This closed preparation policy deliberately has no project MCP or live hosted profile.
  const configToml = [
    'cli_auth_credentials_store = "file"', 'approval_policy = "never"', `sandbox_mode = "${sandboxMode}"`,
    'model = "gpt-6.1-sol"', `model_reasoning_effort = "${record.reasoningEffort}"`, 'web_search = "disabled"',
    "project_doc_max_bytes = 0", "disable_response_storage = true", "", "[features]", "apps = false", "hooks = false", "memories = false",
    "multi_agent = false", "shell_snapshot = false", "skill_mcp_dependency_install = false",
    "shell_tool = false", "unified_exec = false", "goals = false", "default_mode_request_user_input = false", "", "[history]",
    'persistence = "none"', "", "[otel]", 'exporter = "none"', 'metrics_exporter = "none"',
    'trace_exporter = "none"', "log_user_prompt = false", "", "[shell_environment_policy]", 'inherit = "none"', "include_only = []", "",
  ].join("\n");
  const common: PreparedProfileCommon = Object.freeze({ modelBackend: record.modelBackend, model: record.model,
    reasoningEffort: record.reasoningEffort, serviceTier: null, sandboxMode,
    executionProfile: Object.freeze({ kind: "custom", disableTools: false, historyMode: "none",
      developerInstructions: !childBounds ? "Use only the launch, observe and stop dynamic tools. Project instructions are denied."
        : `Project instructions are denied. Allowed task tools: ${childBounds.allowedTools.join(", ")}.` }),
    nativeToolSurface: "disabled", cleanThreadPrewarm: false, goalMode: true, maxGoalTurns: record.bounds.maxGoalTurns,
    configToml });
  return record.role === CodexSubscriptionConsumerRole.Controller
    ? Object.freeze({ ...common, role: record.role, dynamicTools: hostedControllerDynamicToolSpecs })
    : Object.freeze({ ...common, role: record.role, dynamicTools: Object.freeze([]) as readonly [],
        allowedTools: record.bounds.allowedTools, accessBoundary: record.bounds.accessBoundary });
}
export const codexSubscriptionAppServerArgv = Object.freeze(["app-server", "--listen", "stdio://"] as const);
