import { types } from "node:util";

export enum CodexGoalOriginReason {
  Current = "hosted_dependency_current_origin_unresolved",
  Execution = "hosted_current_dependency_origin_unresolved",
}
export enum CodexGoalOriginModule {
  Current = "hosted-current-dependency-origin",
  EntryEffects = "hosted-dependency-entry-effects",
  CurrentFacts = "hosted-dependency-current-facts",
  Snapshot = "hosted-dependency-original-snapshot",
  RecordReader = "hosted-dependency-original-record-reader",
  RootOwner = "hosted-dependency-root-owner-reader",
  RootResource = "hosted-dependency-root-resource-view",
  RootPurpose = "hosted-dependency-root-purpose-view",
  RootPhysical = "hosted-dependency-root-physical-facts",
  RootSelection = "hosted-dependency-root-physical-selection",
  RootScope = "hosted-dependency-root-scope-facts",
  RootRecord = "hosted-dependency-root-record-facts",
  RootDescriptors = "hosted-dependency-root-descriptor-census",
  RootProvenance = "hosted-dependency-root-provenance-facts",
  RetiredReady = "hosted-dependency-retired-ready-reader",
  Retirement = "hosted-dependency-retirement-facts",
  WarmRetirement = "hosted-dependency-warm-retirement-selection",
  GenerationRetirement = "hosted-dependency-generation-retirement",
  NativeScope = "hosted-dependency-generation-native-scope",
  OrdinaryProvider = "hosted-ordinary-dependency-provider",
  OrdinaryProviderFacts = "hosted-ordinary-dependency-provider-facts",
  OrdinaryCompletion = "hosted-ordinary-provider-completion-record",
  OrdinaryTerminal = "hosted-ordinary-provider-terminal-view",
  SessionArtifacts = "hosted-managed-dependency-session-artifact-facts",
  SessionAuth = "hosted-managed-dependency-session-auth",
  Home = "hosted-managed-dependency-home-view",
  HomeRecipe = "hosted-managed-dependency-home-recipe-facts",
  HomePreparation = "hosted-managed-dependency-home-preparation",
  Runtime = "hosted-managed-dependency-runtime-composition",
  RuntimeRecipe = "hosted-managed-dependency-runtime-recipe-facts",
  ReadonlyCollector = "hosted-managed-readonly-origin-collector",
  ReadonlyEqualities = "hosted-managed-readonly-origin-fact-equalities",
  ProviderDescriptors = "hosted-managed-provider-descriptor-validation",
  ProviderDescriptorReader = "hosted-managed-provider-descriptor-reader",
  ProviderStart = "hosted-managed-provider-start-facts",
  ProviderStartRecord = "hosted-managed-provider-start-record",
  ProviderWait = "hosted-managed-provider-wait-facts",
  ProviderCompletion = "hosted-managed-provider-completion-record",
}
export enum CodexGoalOriginFormat { Source = "ts", Emitted = "js" }
export interface CodexGoalOriginLocation {
  readonly module: CodexGoalOriginModule; readonly format: CodexGoalOriginFormat;
  readonly line: number; readonly column: number;
}
export interface CodexGoalOriginDiagnostic {
  readonly reason: CodexGoalOriginReason; readonly locations: readonly CodexGoalOriginLocation[];
}
const reasons = new Set<string>(Object.values(CodexGoalOriginReason));
const modules = new Set<string>(Object.values(CodexGoalOriginModule));
const formats = new Set<string>(Object.values(CodexGoalOriginFormat));
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 999999;

/** Failure observations only. Never return stack text, paths or caller labels. */
export function codexGoalOriginDiagnostic(error: unknown): CodexGoalOriginDiagnostic | undefined {
  if (!types.isNativeError(error) || types.isProxy(error)) return undefined;
  const message = Object.getOwnPropertyDescriptor(error, "message");
  if (!message || !("value" in message) || typeof message.value !== "string" || !reasons.has(message.value)) return undefined;
  const reason = message.value as CodexGoalOriginReason, locations: CodexGoalOriginLocation[] = [];
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
    const stack: unknown = descriptor && "value" in descriptor ? descriptor.value :
      descriptor?.get && descriptor.get === nativeStackGetter ? Reflect.apply(descriptor.get, error, []) : undefined;
    // Encode a bounded character prefix only, then enforce the actual byte cap.
    const prefix = typeof stack === "string" ? stack.slice(0, 8192) : "";
    const bytes = Buffer.from(prefix, "utf8"), rows = bytes.subarray(0, 8192).toString("utf8").split("\n");
    if (typeof stack === "string" && (stack.length > prefix.length || bytes.length > 8192)) rows.pop();
    for (const row of rows.slice(1, 17)) {
      const match = /\/([a-z][a-z0-9-]*)\.(ts|js):([1-9][0-9]{0,5}):([1-9][0-9]{0,5})\)?$/.exec(row.trim());
      if (!match || !modules.has(match[1]!)) continue;
      locations.push({ module: match[1] as CodexGoalOriginModule, format: match[2] as CodexGoalOriginFormat,
        line: Number(match[3]), column: Number(match[4]) });
      if (locations.length === 8) break;
    }
  } catch { /* Diagnostics cannot replace the original failure. */ }
  return { reason, locations };
}

/** Exact closed wire decoder shared with the owned synthetic fixture. */
export function decodeCodexGoalOriginDiagnostic(text: string): CodexGoalOriginDiagnostic | undefined {
  try {
    if (text.length > 4096) return undefined;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).join(",") !== "reason,locations" || typeof v.reason !== "string" || !reasons.has(v.reason) ||
        !Array.isArray(v.locations) || v.locations.length > 8 || JSON.stringify(v) !== text) return undefined;
    for (const location of v.locations) {
      if (!location || typeof location !== "object" || Array.isArray(location) || Object.keys(location).join(",") !== "module,format,line,column" ||
          typeof location.module !== "string" || !modules.has(location.module) || typeof location.format !== "string" || !formats.has(location.format) ||
          !coordinate(location.line) || !coordinate(location.column)) return undefined;
    }
    return v as unknown as CodexGoalOriginDiagnostic;
  } catch { return undefined; }
}
