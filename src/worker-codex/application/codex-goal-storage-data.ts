import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { join } from "node:path";
import { optionalCodexGoalModelBackend } from "../codex-goal-model-backend";
import {
  assertJobStorageIntent,
  JobStorageHomeStateRequirement,
  JobStorageIntentKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertCodexSessionHomeProfile,
  CodexSessionHomeProfileKind,
  type CodexSessionHomeProfile,
} from "../codex-session-home-profile";
import type { CodexGoalRunConfig } from "../codex-goal-runner";

export type CodexGoalStorageData = Pick<CodexGoalRunConfig, "sessionHomeProfile" | "storage">;

/** Untrusted persisted/transport data. No receipt, lease or callback is authority. */
export function parseCodexGoalStorageData(input: unknown): CodexGoalStorageData {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const profileValue = ownValue(input, "sessionHomeProfile");
  const storageValue = ownValue(input, "storage");
  if (profileValue === undefined && storageValue === undefined) return {};
  if (profileValue === undefined || storageValue === undefined) {
    throw new Error("codex_goal_storage_data_profile_required");
  }
  const profile = dataObject(profileValue);
  const storage = dataObject(storageValue);
  const intent = dataObject(ownValue(storage, "intent"));
  const generationId = ownValue(storage, "generationId");
  exactKeys(storage, "generationId,intent");
  if (typeof generationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(generationId)) invalid();
  let sessionHomeProfile: CodexSessionHomeProfile;
  let parsedIntent: NonNullable<CodexGoalRunConfig["storage"]>["intent"];
  if (profile.kind === CodexSessionHomeProfileKind.Continuation && intent.kind === JobStorageIntentKind.Continuation) {
    exactKeys(profile, "kind,sessionId");
    exactKeys(intent, "kind,sessionId");
    const sessionId = profile.sessionId;
    if (typeof sessionId !== "string" || sessionId.length > 128 || sessionId !== intent.sessionId) invalid();
    sessionHomeProfile = { kind: CodexSessionHomeProfileKind.Continuation, sessionId };
    parsedIntent = { kind: JobStorageIntentKind.Continuation, sessionId };
  } else if (profile.kind === CodexSessionHomeProfileKind.OneShot && intent.kind === JobStorageIntentKind.NoResume &&
      intent.homeStateRequirement === JobStorageHomeStateRequirement.NoneRequired) {
    exactKeys(profile, "kind");
    exactKeys(intent, "homeStateRequirement,kind");
    sessionHomeProfile = { kind: CodexSessionHomeProfileKind.OneShot };
    parsedIntent = { kind: JobStorageIntentKind.NoResume, homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired };
  } else return invalid();
  assertCodexSessionHomeProfile(sessionHomeProfile);
  assertJobStorageIntent(parsedIntent);
  return Object.freeze({ sessionHomeProfile: Object.freeze(sessionHomeProfile),
    storage: Object.freeze({ generationId, intent: Object.freeze(parsedIntent) }) });
}

/** Existing CLI transport has backend/engine/named slots, not custom credential bindings. */
export function assertCodexGoalStorageTransportSupported(input: unknown): void {
  if (!parseCodexGoalStorageData(input).storage) return;
  const record = input as object;
  optionalCodexGoalModelBackend(ownValue(record, "modelBackend"));
  const engine = ownValue(record, "executionEngine") ?? "app-server-goal";
  if (typeof engine !== "string" || !["app-server", "app-server-goal", "packaged-exec", "plain-exec"].includes(engine) ||
      ownValue(record, "mimoAccounts") !== undefined) unsupportedProvider();
  const accounts = ownValue(record, "accounts");
  if (accounts !== undefined) {
    const slots = typeof accounts === "string" ? accounts.split(",").map(name => name.trim()) : accounts;
    if (!Array.isArray(slots) || !slots.length) unsupportedProvider();
    for (const account of slots) {
      const slot = typeof account === "string" ? undefined : dataObject(account);
      if (slot && Reflect.ownKeys(slot).join(",") !== "name") unsupportedProvider();
      const name = slot ? slot.name : account;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) unsupportedProvider();
    }
  }
}

/** Ordinary edits cannot migrate legacy state or rebind the real provider/session tuple. */
export function assertCodexGoalStorageBindingUnchanged(previous: unknown, next: unknown): void {
  const before = parseCodexGoalStorageData(previous), after = parseCodexGoalStorageData(next);
  if (JSON.stringify(before) !== JSON.stringify(after) ||
      (before.storage && JSON.stringify(providerBinding(previous as object)) !== JSON.stringify(providerBinding(next as object)))) {
    throw new Error("codex_goal_storage_manifest_binding_changed");
  }
}

function providerBinding(record: object): unknown {
  assertCodexGoalStorageTransportSupported(record);
  const accounts = ownValue(record, "accounts");
  const jobRootDir = ownValue(record, "jobRootDir"), taskId = ownValue(record, "taskId");
  if (typeof jobRootDir !== "string" || typeof taskId !== "string") invalid();
  return { backend: optionalCodexGoalModelBackend(ownValue(record, "modelBackend")).modelBackend ?? CodexModelBackend.OpenAiChatGpt,
    engine: ownValue(record, "executionEngine") ?? "app-server-goal",
    accounts: Array.isArray(accounts) ? accounts.map(account => typeof account === "string" ? account : ownValue(account, "name")) : accounts,
    jobId: ownValue(record, "jobId"), taskId, jobRootDir, workspacePath: ownValue(record, "workspacePath"),
    stateRootDir: ownValue(record, "stateRootDir") ?? join(jobRootDir, "state"),
    outputPath: ownValue(record, "outputPath") ?? join(jobRootDir, "output", `${taskId}.latest-result.json`),
    progressPath: ownValue(record, "progressPath") ?? join(jobRootDir, "output", `${taskId}.progress.json`),
    durableHandoffRootDir: ownValue(record, "durableHandoffRootDir") ?? join(jobRootDir, "durable-handoffs") };
}

function unsupportedProvider(): never { throw new Error("codex_goal_storage_provider_transport_unsupported"); }

function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) {
    if (key in object) invalid();
    return undefined;
  }
  if (!("value" in descriptor)) invalid();
  return descriptor.value;
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    ownValue(value, key);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, keys: string): void {
  if (Reflect.ownKeys(value).sort().join(",") !== keys) invalid();
}

function invalid(): never { throw new Error("codex_goal_storage_data_invalid"); }
