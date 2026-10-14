import { mimoProjectClientMaxRoutes, mimoProjectClientMaxRouteBytes } from "./mimo-project-client-route-limits";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CodexModelBackend, type CodexReasoningEffort } from "@vioxen/subscription-runtime/provider-codex";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
export type MimoProjectClientRoute = Readonly<{ projectId: string; workstreamId: string; host: string; machineId: string; socketDir: string }>;
export interface MimoProjectClientTransport { request(request: MimoProjectBridgeRequest): Promise<unknown> }
export type MimoProjectRemoteArgs = Readonly<{ mimoProjectId?: string; mimoWorkstreamId?: string; jobId?: string;
  promptBody?: string; sourceCommit?: string; expectedSourceCommit?: string; modelBackend?: CodexModelBackend | undefined; reasoningEffort?: CodexReasoningEffort | undefined; thinking?: boolean | undefined; ownedPaths?: readonly string[] | undefined;
  confirmCreate?: boolean; confirmRefill?: boolean; confirmStart?: boolean; confirmStop?: boolean }>;
const identifier = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const remoteKeys = new Set(["mimoProjectId", "mimoWorkstreamId", "jobId", "promptBody", "sourceCommit", "expectedSourceCommit", "modelBackend", "reasoningEffort", "thinking", "ownedPaths", "confirmCreate", "confirmRefill", "confirmStart", "confirmStop", "startWorker"]);
export function parseMimoProjectClientRoutes(value: unknown): readonly MimoProjectClientRoute[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mimo_project_client_config_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "routes,schemaVersion" || record.schemaVersion !== 1 || !Array.isArray(record.routes) || record.routes.length > mimoProjectClientMaxRoutes) throw new Error("mimo_project_client_config_invalid");
  const seen = new Set<string>();
  return Object.freeze(record.routes.map((input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("mimo_project_client_config_invalid");
    const r = input as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "host,machineId,projectId,socketDir,workstreamId" ||
        typeof r.projectId !== "string" || !identifier.test(r.projectId) || typeof r.workstreamId !== "string" || !identifier.test(r.workstreamId) ||
        typeof r.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(r.host) || typeof r.machineId !== "string" || !/^[a-f0-9]{32}$/.test(r.machineId) ||
        typeof r.socketDir !== "string" || resolve(r.socketDir) !== r.socketDir || !r.socketDir.startsWith("/") || /[\u0000-\u001f]/.test(r.socketDir)) throw new Error("mimo_project_client_config_invalid");
    const key = r.projectId + "/" + r.workstreamId;
    if (seen.has(key)) throw new Error("mimo_project_client_route_duplicate"); seen.add(key);
    return Object.freeze(r as MimoProjectClientRoute);
  }));
}
/** Client configuration selects transport only. Native root authenticates its
 * enrolled scope independently and derives every host path. */
export function readMimoProjectClientRoutes(path = join(homedir(), ".config", "subscription-runtime", "mimo-project-routes.json")): readonly MimoProjectClientRoute[] {
  if (resolve(path) !== path) throw new Error("mimo_project_client_config_invalid");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("mimo_project_client_config_owner_unavailable");
  for (let directory = dirname(path);; directory = dirname(directory)) {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || ![0, uid].includes(entry.uid) || (entry.mode & 0o022)) throw new Error("mimo_project_client_config_untrusted");
    if (directory === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || ![0, uid].includes(before.uid) || before.nlink !== 1 || (before.mode & 0o077) || before.size > mimoProjectClientMaxRouteBytes) throw new Error("mimo_project_client_config_untrusted");
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== bytes.length || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error("mimo_project_client_config_changed");
    return parseMimoProjectClientRoutes(JSON.parse(bytes.toString("utf8")));
  } finally { closeSync(fd); }
}
async function defaultTransport(route: MimoProjectClientRoute): Promise<MimoProjectClientTransport> {
  const moduleUrl = new URL("../../scripts/ops/host-job-transport.mjs", import.meta.url).href;
  const adapter = await import(moduleUrl) as { hostTransport: (route: MimoProjectClientRoute) => MimoProjectClientTransport };
  return adapter.hostTransport(route);
}
export async function delegateMimoProjectOperation(operation: MimoProjectBridgeOperation, args: MimoProjectRemoteArgs,
  deps: { routes?: readonly MimoProjectClientRoute[]; transport?: (route: MimoProjectClientRoute) => Promise<MimoProjectClientTransport> } = {}): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (args.mimoProjectId === undefined && args.mimoWorkstreamId === undefined) {
    if (args.thinking !== undefined || args.ownedPaths !== undefined) throw new Error("mimo_project_remote_backend_conflict");
    return undefined;
  }
  if (!args.mimoProjectId || !args.mimoWorkstreamId || !args.jobId) throw new Error("mimo_project_remote_identity_required");
  for (const [key, value] of Object.entries(args)) if (value !== undefined && !remoteKeys.has(key)) throw new Error("mimo_project_remote_override_denied");
  if ((args.reasoningEffort !== undefined || args.thinking !== undefined || args.ownedPaths !== undefined) && operation !== MimoProjectBridgeOperation.Create) throw new Error("mimo_project_remote_override_denied");
  if (args.modelBackend !== undefined && args.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) throw new Error("mimo_project_remote_backend_conflict");
  if ((operation === MimoProjectBridgeOperation.Create && args.confirmCreate !== true && args.confirmRefill !== true) ||
      (operation === MimoProjectBridgeOperation.Start && args.confirmStart !== true) ||
      (operation === MimoProjectBridgeOperation.Stop && args.confirmStop !== true)) throw new Error("mimo_project_remote_confirmation_required");
  const route = (deps.routes ?? readMimoProjectClientRoutes()).find(r => r.projectId === args.mimoProjectId && r.workstreamId === args.mimoWorkstreamId);
  if (!route) throw new Error("mimo_project_remote_route_not_configured");
  if (args.sourceCommit !== undefined && args.expectedSourceCommit !== undefined && args.sourceCommit !== args.expectedSourceCommit) throw new Error("mimo_project_remote_source_conflict");
  const request = parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1, machineId: route.machineId,
    projectId: route.projectId, workstreamId: route.workstreamId, operation, jobId: args.jobId,
    ...(operation === MimoProjectBridgeOperation.Create ? { prompt: args.promptBody, sourceCommit: args.sourceCommit ?? args.expectedSourceCommit,
      ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
      ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
      ...(args.ownedPaths === undefined ? {} : { ownedPaths: args.ownedPaths }) } : {}) });
  const response = await (await (deps.transport ?? defaultTransport)(route)).request(request);
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("mimo_project_remote_response_invalid");
  const record = response as Readonly<Record<string, unknown>>;
  if (operation === MimoProjectBridgeOperation.Status && record.worker && typeof record.worker === "object") {
    const worker = record.worker as { ok?: unknown; result?: unknown };
    if (worker.ok === true && worker.result && typeof worker.result === "object") {
      const result = worker.result as Record<string, unknown>;
      if (result.status && typeof result.status === "object") return { ...record, status: result.status };
    }
  }
  return record;
}

/** A route selector must never be ignored by an unsupported local operation. */
export function assertNoUnsupportedMimoRemoteRoute(args: { readonly mimoProjectId?: string; readonly mimoWorkstreamId?: string }): void {
  if (args.mimoProjectId !== undefined || args.mimoWorkstreamId !== undefined) throw new Error("mimo_project_remote_operation_unsupported");
}
