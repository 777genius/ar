import type { Stats } from "node:fs";
import type { TransientStartSample } from "./transient-start-diagnostic.ts";
const runtime = "/opt/subscription-runtime-dependency-os-TEST";
const policy = "/var/lib/subscription-runtime-host-policy";
export const syntheticProviderSha256 = "43baba6382bbeb22c3fd253563dbf0005f3bc7bfbf02049b98c5c9251bc8df02";
const syntheticPrompt = "Execute the fixed dependency-reading TEST probe. This is a synthetic provider protocol fixture.\n";
type SyntheticInputs = Readonly<{ scenario: string | undefined; phase: string; entry: string | undefined; command: string;
  jobId: string; root: string; workspace: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>>;
  providerSha256: string; prompt: Uint8Array; auth: Uint8Array }>;
/** Internal fixture proof only; no caller flag/config or real provider route. */
export function verifiedSyntheticCliInputs(input: SyntheticInputs): boolean {
  try {
    if (input.scenario !== "dependency" || input.phase !== "fresh_real_cli" || input.entry !== runtime + "/scripts/dependency-retention-os-test/guest.ts" ||
        input.command !== runtime + "/toolchain/bin/node" || !/^TEST-os-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.jobId) ||
        input.root !== policy + "/dependency-test-jobs/jobs/" + input.jobId || input.workspace !== input.root + "/workspace" ||
        input.providerSha256 !== syntheticProviderSha256 || !Buffer.from(input.prompt).equals(Buffer.from(syntheticPrompt))) return false;
    const root = input.root, expected = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", input.jobId, "--job-id", input.jobId,
      "--job-root", root, "--workspace", input.workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
      "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low", "--timeout", "5m",
      "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--registry-root", root + "/state/registry",
      "--output", root + "/state/TEST-result.json", "--worker-report-mode", "structured-output"];
    if (JSON.stringify(input.args) !== JSON.stringify(expected) || Object.keys(input.env).sort().join(",") !== "LANG,LC_ALL,PATH,SUBSCRIPTION_RUNTIME_SANDBOX_KIND,SYSTEMD_COLORS" ||
        input.env.PATH !== runtime + "/toolchain/bin:/usr/bin:/bin" || input.env.LANG !== "C" || input.env.LC_ALL !== "C" ||
        input.env.SYSTEMD_COLORS !== "0" || input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") return false;
    const auth = JSON.parse(Buffer.from(input.auth).toString("utf8"));
    return auth !== null && typeof auth === "object" && Object.keys(auth).sort().join(",") === "auth_mode,last_refresh,tokens" &&
      auth.auth_mode === "chatgpt" && auth.tokens !== null && typeof auth.tokens === "object" && Object.keys(auth.tokens).join(",") === "refresh_token" &&
      auth.tokens.refresh_token === "TEST-NOT-A-CREDENTIAL" && typeof auth.last_refresh === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(auth.last_refresh) &&
      Buffer.from(input.auth).equals(Buffer.from(JSON.stringify(auth) + "\n"));
  } catch { return false; }
}
type FileIdentity = Pick<Stats, "dev" | "ino" | "uid" | "gid" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs">;
export function sameSyntheticDiagnosticFile(before: FileIdentity, current: FileIdentity): boolean {
  return (["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const).every(key => before[key] === current[key]);
}
// Exact source-defined failures only: hosted-dependency-entry-effects.ts:10 and
// hosted-current-dependency-origin.ts:108. Their length is not cause evidence.
const closedOriginFailures = [
  "hosted_current_dependency_origin_unresolved",
  "hosted_dependency_current_origin_unresolved",
] as const;
/** Only an already-proved synthetic fresh fixture may export this bounded text.
 * Failure is preserved; this observation never alters a launch or authority. */
export function syntheticCliStderrDiagnostic(bytes: Uint8Array, sample: TransientStartSample, trustedSyntheticInputs: boolean, sourceSha: string) {
  const purpose = "TEST_synthetic_fresh_cli_redacted_text_only" as const;
  const refused = { purpose, state: "unavailable" as const };
  if (!trustedSyntheticInputs || !/^[a-f0-9]{40}$/.test(sourceSha) || bytes.length < 1 || bytes.length > 4096 || sample.offset !== 0 ||
      sample.fullBytes !== bytes.length || sample.initialBytes !== bytes.length || sample.currentBytes !== bytes.length ||
      bytes[bytes.length - 1] !== 10 || bytes.some((byte, index) => byte < 32 && !(byte === 10 && index === bytes.length - 1) || byte > 126)) return refused;
  let text = Buffer.from(bytes).toString("ascii").slice(0, -1);
  const closedReason = closedOriginFailures.find(reason => text === reason);
  if (closedReason) return { purpose, state: "captured" as const, closedReason };
  text = text.replace(/\/(?:[^\s'"<>]+)/g, "<path>")
    .replaceAll("TEST-NOT-A-CREDENTIAL", "<test-placeholder>").replaceAll(sourceSha, "<source-sha>")
    .replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, "<test-id>");
  if (/(?:bearer|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|\btokens?\s*[:=]|password|secret|credential|cookie|private[ _-]?key|-----BEGIN)/i.test(text) ||
      /(?:https?:|[a-f0-9]{24,}|\beyJ[A-Za-z0-9_-]+\.|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+)/i.test(text) ||
      /\b[A-Za-z0-9+_=-]{40,}\b/.test(text)) return refused;
  return { purpose, state: "captured" as const, redactedText: text };
}
