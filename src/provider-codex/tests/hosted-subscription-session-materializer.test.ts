import { assertCodexSubscriptionTestBoundary } from "./codex-subscription-preparation-test-support";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChildContinuationMode, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime } from "../app-server/application/app-server-child-lifetime";
import { sessionArtifactFromCodexAuthJson } from "../codex-auth-json-codec";
import { CodexModelBackend } from "../codex-model-backend";
import { CodexSubscriptionConsumerRole, CodexSubscriptionReasoningEffort } from "../codex-subscription-preparation";
import { createHostedSubscriptionPreparationOwner, prepareHostedSubscriptionConsumer,
  CodexSubscriptionPreparationStatus as Status, CodexSubscriptionUnusedReleaseStatus as Release,
  type CodexSubscriptionPreparationInput } from "../hosted-subscription-session-materializer";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(homedir(), "subscription-preparation-TEST-")));
  const job = join(root, "job"), workspace = join(root, "workspace");
  await fs.mkdir(job, { mode: 0o700 }); await fs.mkdir(join(job, "tmp"), { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
  try { await assertCodexSubscriptionTestBoundary(job); }
  catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  const binding = { role: CodexSubscriptionConsumerRole.Controller, controllerId: "TEST-controller", allocationId: "TEST-allocation",
    incarnationId: "TEST-incarnation", jobId: "TEST-job", accountId: "TEST-selected-account",
    grantSha256: "a".repeat(64), sourceSha: "b".repeat(40), artifactSha: "c".repeat(40) };
  const bounds = { deadlineEpochMs: Date.now() + 10000, maxGoalTurns: 2, maxAttempts: 1, maxAccountCycles: 1,
    continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true } as const;
  const record = { ...binding, schemaVersion: 1, modelBackend: CodexModelBackend.OpenAiChatGpt,
    model: "gpt-6.1-sol", reasoningEffort: CodexSubscriptionReasoningEffort.High, serviceTier: null, bounds };
  const authJson = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, compatible: "TEST-compatible",
    tokens: { refresh_token: "TEST-unique-secret-refresh", access_token: "TEST-unique-secret-access" } });
  const artifact = sessionArtifactFromCodexAuthJson(authJson), abort = new AbortController();
  const fence = new AppServerExecutionLifetime({ deadlineEpochMs: bounds.deadlineEpochMs, maxGoalTurns: 2, binding });
  const input: CodexSubscriptionPreparationInput = { record, expected: record, selectedSession: { binding, artifact },
    executionLifetime: fence, jobRootDir: job, workspacePath: workspace, codexBinaryPath: "/TEST/codex",
    processEssentials: { PATH: "/TEST/bin", CI: "true" }, redactor: new DefaultRedactor(), abortSignal: abort.signal };
  return { input, job, root, authJson, abort, fence, artifact,
    close: async () => { vi.restoreAllMocks(); fence.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
function gate() {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  return { pending, resolve };
}

describe("selected subscription preparation custody", () => {
  // Red if caller mutation after owner construction changes actual credential bytes or if public serialization leaks custody.
  it("snapshots before effects and materializes actual private files without exposed credentials", async () => {
    const f = await fixture();
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input);
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
      f.artifact.bytes.fill(120);
      expect(await owner.prepare()).toEqual({ status: Status.Prepared });
      const consumer = owner.takeSessionForConsumer();
      expect(await fs.readFile(join(consumer.session.codexHome, "auth.json"), "utf8")).toBe(f.authJson);
      const config = await fs.readFile(join(consumer.session.codexHome, "config.toml"), "utf8");
      expect(config).toBe(consumer.profile.configToml);
      expect(config).toContain('inherit = "none"');
      expect(config).toContain('web_search = "disabled"');
      expect(config).toMatch(/^project_doc_max_bytes = 0$/m);
      expect(config).not.toMatch(/mcp_servers|model_providers|fast_mode|service_tier/);
      for (const path of [consumer.session.home, consumer.session.codexHome, consumer.session.env.TMPDIR!]) {
        expect((await fs.lstat(path)).mode & 0o777).toBe(0o700);
      }
      for (const name of ["auth.json", "config.toml"]) {
        const stat = await fs.lstat(join(consumer.session.codexHome, name));
        expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1); expect(stat.isFile()).toBe(true);
      }
      expect(consumer.executionLifetime).toBe(f.fence);
      expect(consumer.launch.args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(Object.keys(consumer.launch.env).sort()).toEqual(["CI", "CODEX_HOME", "HOME", "PATH", "TEMP", "TMP", "TMPDIR"]);
      for (const value of [owner, consumer, consumer.session]) expect(JSON.stringify(value)).toBe('{"status":"held"}');
      expect(await owner.releaseUnused()).toBe(Release.Held);
      await expect(consumer.session.release()).rejects.toThrow("used_session_held");
      expect(await fs.readFile(join(consumer.session.codexHome, "auth.json"), "utf8")).toBe(f.authJson);
      expect(() => owner.takeSessionForConsumer()).toThrow("handoff_denied");
    } finally { await f.close(); }
  });
  // Red if metadata-only codec validation accepts API credentials, bad UTF8 or oversized selected DATA.
  it.each(["invalid_utf8", "oversized", "api_key", "api_route", "provider", "format"])("refuses %s before filesystem effects", async kind => {
    const f = await fixture();
    try {
      const artifact = kind === "api_key" || kind === "api_route"
        ? { ...f.artifact, bytes: new TextEncoder().encode(JSON.stringify({ auth_mode: kind === "api_route" ? "apikey" : "chatgpt",
            OPENAI_API_KEY: "TEST-forbidden-key", tokens: { refresh_token: "TEST-secret" } })) }
        : { ...f.artifact, ...(kind === "invalid_utf8" ? { bytes: new Uint8Array([0xff]) } : {}),
            ...(kind === "oversized" ? { bytes: new Uint8Array(32769) } : {}),
            ...(kind === "provider" ? { providerId: "TEST-foreign-provider" } : {}),
            ...(kind === "format" ? { formatVersion: "TEST-foreign-format" } : {}) };
      expect(() => createHostedSubscriptionPreparationOwner({ ...f.input, selectedSession: { ...f.input.selectedSession, artifact } })).toThrow("preparation_invalid");
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { await f.close(); }
  });
  // Red on A1: oversized input is copied before its 32KiB cap is checked.
  // Observe actual native construction while still delegating valid allocations.
  it("rejects an oversized native byte array before allocating its private copy", async () => {
    const f = await fixture(), oversized = new Uint8Array(32769);
    Object.defineProperty(oversized, "byteLength", { value: 1 });
    const constructor = globalThis.Uint8Array;
    let selectedCopies = 0;
    vi.stubGlobal("Uint8Array", new Proxy(constructor, {
      construct(target, args, newTarget) {
        if (args[0] === oversized) selectedCopies++;
        return Reflect.construct(target, args, newTarget);
      },
    }));
    try {
      expect(() => createHostedSubscriptionPreparationOwner({ ...f.input,
        selectedSession: { ...f.input.selectedSession, artifact: { ...f.artifact, bytes: oversized } } })).toThrow("preparation_invalid");
      expect(selectedCopies).toBe(0);
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { vi.unstubAllGlobals(); await f.close(); }
  });
  // Red if deadline race drops a late real mkdir, cleans it prematurely, or promotes rejection back to success.
  it("retains the original owner through actual late exclusive mkdir settlement", async () => {
    const f = await fixture(), entered = gate(), resume = gate();
    const mkdir = fs.mkdir;
    vi.spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
      const result = await mkdir(path, options);
      if (String(path).includes("codex-subscription-")) { entered.resolve(); await resume.pending; }
      return result;
    });
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input), prepared = owner.prepare();
      await Promise.race([entered.pending, prepared.then(() => {
        throw new Error("TEST_delayed_filesystem_operation_not_reached");
      })]);
      const prefix = (await fs.readdir(join(f.job, "tmp")))[0]!;
      const foreign = join(f.job, "tmp", "foreign-TEST"); await mkdir(foreign, { mode: 0o700 });
      await fs.writeFile(join(foreign, "marker"), "preserved");
      f.abort.abort(new Error("TEST-private-path-secret"));
      expect(await prepared).toEqual({ status: Status.Rejected, code: "unavailable" });
      expect(await owner.releaseUnused()).toBe(Release.RefusedPending);
      expect(await fs.lstat(join(f.job, "tmp", prefix))).toBeDefined();
      expect(() => owner.takeSessionForConsumer()).toThrow("handoff_denied");
      expect(await owner.prepare()).toEqual({ status: Status.Rejected, code: "consumed" });
      resume.resolve();
      await vi.waitFor(async () => expect(await owner.releaseUnused()).toBe(Release.Released));
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual(["foreign-TEST"]);
      expect(await fs.readFile(join(foreign, "marker"), "utf8")).toBe("preserved");
      expect(JSON.stringify(owner)).toBe('{"status":"released"}');
    } finally { resume.resolve(); await f.close(); }
  });
  // Red if the snapshot helper's real partial config/auth failure loses its enclosing original prefix.
  it("keeps a real partial snapshot in custody until settled unused cleanup", async () => {
    const f = await fixture(), entered = gate(), resume = gate(), rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("/auth.json")) { entered.resolve(); await resume.pending; throw new Error("TEST-secret-partial-write"); }
      await rename(from, to);
    });
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input), prepared = owner.prepare();
      await Promise.race([entered.pending, prepared.then(() => {
        throw new Error("TEST_delayed_filesystem_operation_not_reached");
      })]);
      const prefix = join(f.job, "tmp", (await fs.readdir(join(f.job, "tmp")))[0]!);
      const sessions = await fs.readdir(join(prefix, "tmp")), home = join(prefix, "tmp", sessions[0]!, "codex-home");
      expect(await fs.readFile(join(home, "config.toml"), "utf8")).toContain('model = "gpt-6.1-sol"');
      f.abort.abort(); expect((await prepared).status).toBe(Status.Rejected);
      expect(await owner.releaseUnused()).toBe(Release.RefusedPending);
      resume.resolve();
      await vi.waitFor(async () => expect(await owner.releaseUnused()).toBe(Release.Released));
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
      expect(() => owner.takeSessionForConsumer()).toThrow("handoff_denied");
    } finally { resume.resolve(); await f.close(); }
  });
  // Red if a proposed/collided path is mistaken for a successful acquisition.
  it("preserves a collided foreign prefix", async () => {
    const f = await fixture(), mkdir = fs.mkdir;
    vi.spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
      if (String(path).includes("codex-subscription-")) {
        await mkdir(path, options); await fs.writeFile(join(String(path), "foreign-marker"), "keep");
        throw Object.assign(new Error("TEST-collision"), { code: "EEXIST" });
      }
      return mkdir(path, options);
    });
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input);
      expect((await owner.prepare()).status).toBe(Status.Rejected);
      expect(await owner.releaseUnused()).toBe(Release.Released);
      const prefixes = await fs.readdir(join(f.job, "tmp")); expect(prefixes).toHaveLength(1);
      expect(await fs.readFile(join(f.job, "tmp", prefixes[0]!, "foreign-marker"), "utf8")).toBe("keep");
    } finally { await f.close(); }
  });
  // Red if cleanup adopts a substituted inode or retries uncertain destructive work.
  it("holds a substituted root and never retries failed cleanup", async () => {
    const f = await fixture();
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input); expect((await owner.prepare()).status).toBe(Status.Prepared);
      const prefix = join(f.job, "tmp", (await fs.readdir(join(f.job, "tmp")))[0]!);
      await fs.rename(prefix, `${prefix}-original`); await fs.mkdir(prefix, { mode: 0o700 });
      await fs.writeFile(join(prefix, "foreign-marker"), "keep");
      expect(await owner.releaseUnused()).toBe(Release.Held);
      expect(await owner.releaseUnused()).toBe(Release.Held);
      expect(await fs.readFile(join(prefix, "foreign-marker"), "utf8")).toBe("keep");
      expect(() => owner.takeSessionForConsumer()).toThrow("handoff_denied");
    } finally { await f.close(); }
  });
  // Red if a shared or symlink job boundary is adopted/chmodded before allocation.
  it.each(["shared", "symlink", "shared_ancestor"])("refuses %s parent without adopting it", async kind => {
    const f = await fixture();
    try {
      const job = kind === "symlink" ? join(f.root, "symlink-job") : f.job;
      if (kind === "shared") await fs.chmod(f.job, 0o777);
      else if (kind === "shared_ancestor") await fs.chmod(f.root, 0o777);
      else await fs.symlink(f.job, job);
      const owner = createHostedSubscriptionPreparationOwner({ ...f.input, jobRootDir: job });
      expect((await owner.prepare()).status).toBe(Status.Rejected);
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
      if (kind === "shared") expect((await fs.lstat(f.job)).mode & 0o777).toBe(0o777);
    } finally { await f.close(); }
  });
  it("refuses a forged owner with finite DATA", async () => {
    const f = await fixture();
    try {
      const owner = createHostedSubscriptionPreparationOwner(f.input);
      expect(await prepareHostedSubscriptionConsumer(Object.create(Object.getPrototypeOf(owner)) as typeof owner)).toEqual({ status: Status.Rejected, code: "invalid" });
      expect(await fs.readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { await f.close(); }
  });
});
