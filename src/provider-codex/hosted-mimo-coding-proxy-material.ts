import { mkdtemp } from "node:fs/promises";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { hostedMimoCodingGitReadPaths } from "./hosted-mimo-coding-git";
import { dirname, join } from "node:path";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { AppServerExecutionLifetime } from "./app-server/application/app-server-child-lifetime";
import { readHostedMimoCodingWorkerOrigin, assertHostedMimoCodingWorkerOriginCurrent,
  type HostedMimoCodingWorkerOrigin } from "./hosted-mimo-worker-origin";
import { resolveHostedMimoCodingProxyCredential } from "./hosted-mimo-credential-source";
import { startMimoCredentialProxy, type MimoCredentialProxy } from "./hosted-mimo-credential-proxy";
import { codexMimoApiKeyEnvVarDefault, CodexModelBackend, codexModelBackendModelProvidersConfigToml } from "./codex-model-backend";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, codexProviderEgressConfigToml } from "./codex-provider-egress-policy";
import { hostedCodexPermissionProfilesToml } from "./hosted-codex-permissions";
import { hostedMimoCodingGuestHome, hostedMimoCodingGuestCodexHome } from "./hosted-mimo-coding-bootstrap";

export type HostedMimoCodingProxyMaterial = Readonly<{
  origin: HostedMimoCodingWorkerOrigin;
  capability: string;
  assertCurrent(): void;
  revoke(): void;
  close(): Promise<void>;
}>;
import { registerHostedMimoCodingBootstrap } from "./hosted-mimo-coding-bootstrap-registry";
const consumedStarts = new Set<string>();

/** Fixed public configuration, never supplied by a caller or read from project
 * files. Native activation/network qualification remain separately closed. */
function codingConfig(origin: HostedMimoCodingWorkerOrigin, baseUrl: string, gitReadPaths: readonly string[]): string {
  const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.ManagedPublicInternetV1);
  return [
    'cli_auth_credentials_store = "file"', 'approval_policy = "never"',
    'default_permissions = "hosted-project-write"', 'web_search = "disabled"',
    'disable_response_storage = true', 'project_doc_max_bytes = 0',
    '[features]', 'apps = false', 'hooks = false', 'memories = false', 'multi_agent = false',
    'shell_snapshot = false', 'skill_mcp_dependency_install = false', 'shell_tool = true', 'unified_exec = true',
    '[history]', 'persistence = "none"', '[otel]', 'exporter = "none"', 'metrics_exporter = "none"',
    'trace_exporter = "none"', 'log_user_prompt = false',
    '[shell_environment_policy]', 'inherit = "none"', 'include_only = ["PATH", "HOME", "CI", "TMPDIR", "CODEX_HOME"]',
    // include_only filters inherited values; inherit=none needs explicit public settings for native sandbox discovery.
    `set = { PATH = ${JSON.stringify(`${dirname(process.execPath)}:/usr/bin:/bin`)}, HOME = ${JSON.stringify(hostedMimoCodingGuestHome)}, CI = "1", TMPDIR = "/tmp", CODEX_HOME = ${JSON.stringify(hostedMimoCodingGuestCodexHome)} }`,
    codexModelBackendModelProvidersConfigToml({ backend: CodexModelBackend.XiaomiMimoTokenPlan, baseUrl,
      envKeyName: codexMimoApiKeyEnvVarDefault }),
    "request_max_retries = 0", "stream_max_retries = 0", "supports_websockets = false",
    codexProviderEgressConfigToml(policy, { namedPermissions: true }),
    hostedCodexPermissionProfilesToml(policy, [process.execPath, origin.codexBinaryPath, ...gitReadPaths]),
  ].join("\n") + "\n";
}

const codingGitHost = {
  exists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
  isFile(path: string): boolean { try { return lstatSync(path).isFile() && realpathSync(path) === path; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
  isDirectory(path: string): boolean { return lstatSync(path).isDirectory() && realpathSync(path) === path; },
  read(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 65536 || realpathSync(path) !== path) throw new Error("mimo_coding_git_binding_invalid");
      const bytes = Buffer.alloc(before.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
          readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error("mimo_coding_git_binding_invalid");
      const after = fstatSync(fd), current = lstatSync(path);
      if (bytes.length !== before.size || before.dev !== current.dev || before.ino !== current.ino ||
          before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs) throw new Error("mimo_coding_git_binding_invalid");
      return bytes.toString("utf8");
    } finally { closeSync(fd); }
  },
};

/** Full independent actual-runtime proof is captured before the shared key is
 * opened. The HTTP fast path uses its branded retained-current observation. */
export async function createHostedMimoCodingProxyMaterial(input: {
  readonly model: string;
  readonly envKeyName?: string;
  readonly origin?: HostedMimoCodingWorkerOrigin;
  readonly lifetime: AppServerExecutionLifetime;
  readonly redactor: RedactorPort;
}): Promise<HostedMimoCodingProxyMaterial | null> {
  const origin = input.origin ?? readHostedMimoCodingWorkerOrigin();
  if (!origin) return null;
  if (input.envKeyName !== undefined && input.envKeyName !== codexMimoApiKeyEnvVarDefault) throw new Error("hosted_mimo_coding_proxy_env_invalid");
  input.lifetime.assertActive();
  const remaining = input.lifetime.deadlineEpochMs - Date.now();
  if (origin.model !== input.model || origin.maxGoalTurns !== input.lifetime.maxGoalTurns ||
      remaining <= 0 || remaining > origin.taskTimeoutMs) throw new Error("hosted_mimo_coding_proxy_binding_invalid");
  assertHostedMimoCodingWorkerOriginCurrent(origin);
  const gitReadPaths = hostedMimoCodingGitReadPaths(origin.workspacePath, codingGitHost);
  if (consumedStarts.has(origin.digest)) throw new Error("hosted_mimo_coding_proxy_start_consumed");
  consumedStarts.add(origin.digest);
  const bytes = Buffer.from(resolveHostedMimoCodingProxyCredential(origin, input.redactor));
  let proxy: MimoCredentialProxy;
  try {
    proxy = await startMimoCredentialProxy({ apiKey: bytes, model: origin.model,
      assertCurrent: () => { input.lifetime.assertActive(); assertHostedMimoCodingWorkerOriginCurrent(origin); },
      limits: { deadlineMs: input.lifetime.deadlineEpochMs, maxRequests: origin.maxGoalTurns * 4, maxConcurrency: 2,
        maxBodyBytes: 4 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024, maxOutputTokens: 16384,
        requestTimeoutMs: Math.min(600000, Math.max(1, remaining)) } });
  } finally { bytes.fill(0); }
  let unregister: (() => void) | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  const abort = () => proxy.revoke();
  const material: HostedMimoCodingProxyMaterial = Object.freeze({ origin, capability: proxy.capability,
    assertCurrent() { if (closed) throw new Error("hosted_mimo_coding_proxy_closed"); input.lifetime.assertActive(); assertHostedMimoCodingWorkerOriginCurrent(origin); },
    revoke() { proxy.revoke(); },
    close() {
      if (closing) return closing;
      closed = true;
      proxy.revoke(); unregister?.();
      if (ownerTimer) clearInterval(ownerTimer);
      input.lifetime.signal.removeEventListener("abort", abort);
      closing = Promise.resolve().then(() => proxy.close());
      return closing;
    },
  });
  input.lifetime.signal.addEventListener("abort", abort, { once: true });
  try {
    material.assertCurrent();
    const configToml = codingConfig(origin, proxy.baseUrl, gitReadPaths);
    input.redactor.registerSecret(proxy.capability, "hosted-mimo-start-proxy");
    unregister = registerHostedMimoCodingBootstrap(proxy.capability, frame => {
      material.assertCurrent();
      if (frame.command !== origin.codexBinaryPath || !frame.env.CODEX_HOME?.startsWith(origin.homeRoot + "/") ||
          !(frame.cwd === origin.workspacePath || frame.cwd.startsWith(origin.homeRoot + "/"))) throw new Error("hosted_mimo_coding_proxy_frame_invalid");
      return Object.freeze({ schemaVersion: 1, startId: origin.startId, specSha256: origin.digest, workspacePath: origin.workspacePath, configToml });
    });
    ownerTimer = setInterval(() => { try { material.assertCurrent(); } catch { proxy.revoke(); void material.close().catch(() => undefined); } }, 1000);
    ownerTimer.unref();
    return material;
  } catch (error) { await material.close(); throw error; }
}


/** One driver owns one start-scoped materialization flight. Disposal fences a
 * flight even if binding/listen completes after the caller has cancelled. */
export class HostedMimoCodingProxyOwner {
  private flight: Promise<HostedMimoCodingProxyMaterial | null> | undefined;
  private material: HostedMimoCodingProxyMaterial | undefined;
  private disposed = false;
  get retained(): boolean { return this.material !== undefined; }
  async acquire(input: Parameters<typeof createHostedMimoCodingProxyMaterial>[0]): Promise<HostedMimoCodingProxyMaterial | null> {
    if (this.disposed) throw new Error("codex_driver_disposed");
    this.flight ??= createHostedMimoCodingProxyMaterial(input);
    const material = await this.flight;
    if (material) {
      this.material = material;
      if (this.disposed) { material.revoke(); await material.close(); throw new Error("codex_driver_disposed"); }
      material.assertCurrent();
    }
    return material;
  }
  revoke(): void { this.disposed = true; this.material?.revoke(); }
  async close(): Promise<void> { this.revoke(); await this.material?.close(); }
}

/** Host-only admission home; Coding never persists provider configuration here. */
export async function allocateHostedMimoAdmissionHome(origin: { homeRoot: string } | null, material: HostedMimoCodingProxyMaterial | null, sourceEnv?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return origin ? await mkdtemp(join(origin.homeRoot, "mimo-")) : await createCodexRuntimeTempRoot({
      prefix: "subscription-runtime-codex-mimo-", ...(sourceEnv === undefined ? {} : { sourceEnv }),
    });
  } catch (error) { await material?.close(); throw error; }
}
