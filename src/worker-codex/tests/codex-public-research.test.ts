import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { createServer as createTcpServer, type Socket } from "node:net";
import { handlePublicResearchSourceTool, PublicResearchToolSession } from "../../provider-codex/app-server/application/public-research-source-tool";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeExecutionMode, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend } from "../../provider-codex/codex-model-backend";
import { CodexProviderEgressProfileId, codexProviderEgressPolicy, codexProviderEgressEnv } from "../../provider-codex/codex-provider-egress-policy";
import { createPublicResearchSourceReader } from "../../provider-codex/app-server/adapters/public-research-source-reader";
import { CodexAppServerExecutionEngine } from "../../provider-codex/codex-app-server-execution-engine";
import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import { CodexWorkerCacheSessionMaterializer, codexJsonHomeConfigToml } from "../../provider-codex/codex-session-materializer";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { RecordingManagedRunStore, StaticRunner, validAuthJson, refreshedAuthJson } from "../../provider-codex/tests/codex-provider-test-support";
import { egressBoundCodexProcessFactory } from "../../provider-codex/app-server/adapters/egress-bound-process";
import { appServerThreadStartParams } from "../../provider-codex/app-server/application/app-server-thread-start-params";
import { resolveCodexExecutionProfile } from "../../provider-codex/codex-execution-profile";
import { createFileBackendCodexWorkerRuntime } from "../../provider-codex/../worker-codex/file-backend-codex-runtime-factory";

// Only DNS and socket routing are replaced. Production URL checks, DNS address
// checks, HTTPS request/response handling, TLS verification, bytes and framing
// run against a real disposable TEST server. No production localhost grant or
// injected bypass exists. These fixture bytes are NOT current official sources.
const tls = vi.hoisted(() => ({ port: 0, ca: "", addresses: [{ address: "93.184.215.14", family: 4 }], calls: 0, dnsCalls: 0, dnsWait: false, dnsCanceled: 0, activeBodies: 0, closedBodies: 0, requests: [] as { host: string; url: string; method: string; auth?: string; cookie?: string }[] }));
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(),
  Resolver: class {
    private readonly pending: ((reason: Error) => void)[] = [];
    private resolve(family: number) {
      tls.dnsCalls++;
      if (tls.dnsWait) return new Promise<string[]>((_resolve, reject) => this.pending.push(reject));
      return Promise.resolve(tls.addresses.filter(row => row.family === family).map(row => row.address));
    }
    resolve4() { return this.resolve(4); }
    resolve6() { return this.resolve(6); }
    cancel() { tls.dnsCanceled++; for (const reject of this.pending) reject(Object.assign(new Error("TEST canceled DNS"), { code: "ECANCELLED" })); }
  } }));
vi.mock("node:https", async original => {
  const real = await original<typeof import("node:https")>();
  return { ...real, request: (url: URL, options: import("node:https").RequestOptions, callback: Parameters<typeof real.request>[2]) => {
    tls.calls++;
    const lookup = options.lookup!;
    return real.request(url, { ...options, port: tls.port, ca: tls.ca,
      lookup: (hostname, opts, cb) => lookup(hostname, opts, ((error: Error | null) => {
        if (error) { cb(error, "", 4); return; }
        if (opts.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
        else cb(null, "127.0.0.1", 4);
      }) as Parameters<typeof lookup>[2]),
    }, callback);
  } };
});

const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.PublicResearchV1);
const reader = createPublicResearchSourceReader(policy);
let root: string, server: Server;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "TEST-public-research-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(root, "server.key"), "-out", join(root, "server.crt"), "-subj", "/CN=docs.rs",
    "-addext", "subjectAltName=" + policy.publicSourceDomains!.map(host => "DNS:" + host).join(",")],
    { cwd: root, stdio: "ignore" });
  tls.ca = await readFile(join(root, "server.crt"), "utf8");
  server = createServer({ cert: tls.ca, key: await readFile(join(root, "server.key"), "utf8") }, (req, res) => {
    tls.requests.push({ host: req.headers.host!, url: req.url!, method: req.method!,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) });
    if (req.url === "/redirect") { res.writeHead(302, { Location: "https://nodejs.org/" }); res.end(); }
    else if (req.url === "/oversize") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("x".repeat(512 * 1024 + 1)); }
    else if (req.url === "/slow") {
      tls.activeBodies++;
      res.writeHead(200, { "Content-Type": "text/plain" }); res.write("TEST streamed prefix");
      const timer = setInterval(() => res.write("x"), 20);
      res.on("close", () => { clearInterval(timer); tls.activeBodies--; tls.closedBodies++; });
    }
    else if (req.url === "/nearcap") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("x".repeat(512 * 1024)); }
    else if (req.url === "/escaped") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("\0".repeat(200 * 1024)); }
    else if (req.url === "/binary") { res.writeHead(200, { "Content-Type": "application/gzip" }); res.end(Buffer.from([0, 1, 255])); }
    else { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("TEST public source fixture"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  tls.port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(() => { tls.dnsWait = false; tls.dnsCalls = 0; tls.dnsCanceled = 0; tls.closedBodies = 0; tls.calls = 0; tls.requests = []; tls.addresses = [{ address: "93.184.215.14", family: 4 }]; });

function sourceFactory(statuses: string[] = ["complete"], restoredThread?: string) {
  const call = { id: 9002, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "public_source_read", arguments: { url: "https://docs.rs/" } } };
  const factory = new FakeAppServerFactory({ goalStatusesAfterTurns: statuses, emitServerRequestOnTurn: call,
    suppressTurnCompletion: true,
    onResponse: response => { if (response.id === 9002) setTimeout(() => factory.processes.at(-1)!.stdout.emit("data",
      JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }) + "\n"), 10); },
    ...(restoredThread ? { initialGoals: { [restoredThread]: { objective: "Retrieve public sources", status: "blocked" } } } : {}),
    onRequest: request => { if (request.method === "turn/start") call.params.threadId = String(request.params!.threadId); } });
  return factory;
}
const task = () => ({ session: sessionArtifactFromCodexAuthJson(validAuthJson),
  task: { kind: "structured-prompt" as const, prompt: "Retrieve current public research sources", controls: { editMode: "allow-edits" as const },
    metadata: { codexManagedRunId: "TEST-research-run", purpose: "research", providerEgressProfileId: policy.profileId } },
  workspace: { path: root }, runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: new AbortController().signal });
const readResult = (fake: FakeAppServerFactory) => fake.responses.filter(r => r.id === 9002).at(-1)?.result as { success: boolean; contentItems: { text: string }[] } | undefined;
async function expectSource(fake: FakeAppServerFactory) {
  await vi.waitFor(() => expect(readResult(fake)?.success).toBe(true));
  expect(JSON.parse(readResult(fake)!.contentItems[0]!.text)).toMatchObject({ url: "https://docs.rs/", authentication: "anonymous", body: "TEST public source fixture" });
}

describe("admitted public research source capability", () => {
  it("pins separate production source authority while keeping native shell API-only", () => {
    expect(policy.domains).toEqual(["api.openai.com"]);
    expect(policy.publicSourceDomains).toEqual(["postgresql.org", "www.postgresql.org", "docs.rs", "crates.io", "static.crates.io", "pglite.dev", "orm.drizzle.team", "v2.tauri.app", "nodejs.org"]);
    expect(Object.isFrozen(policy.publicSourceDomains)).toBe(true);
    expect(() => createPublicResearchSourceReader(codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification))).toThrow("public_research_profile_required");
  });
  it.each(policy.publicSourceDomains!)("retrieves %s through verified TLS, GET and anonymous headers", async host => {
    const source = await reader.read(`https://${host}/`);
    expect(source).toMatchObject({ status: 200, body: "TEST public source fixture", authentication: "anonymous", bodyEncoding: "utf8" });
    expect(Date.parse(source.retrievedAt)).not.toBeNaN();
    expect(tls.requests).toEqual([{ host: host + ":" + tls.port, url: "/", method: "GET" }]);
  });
  it.each(["http://docs.rs/", "https://docs.rs:444/", "https://docs.rs.evil.example/", "https://evil.example/", "https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://user:password@docs.rs/", "https://docs.rs/?access_token=x", "https://docs.rs/#x", "https://*.docs.rs/", " https://docs.rs/", "https://api.github.com/repos/TEST/TEST", "https://raw.githubusercontent.com/TEST/TEST/main/README.md"])("denies %s before socket creation", async url => {
    await expect(reader.read(url)).rejects.toThrow("public_research_url_denied");
    expect(tls.dnsCalls).toBe(0); expect(tls.calls).toBe(0); expect(tls.requests).toHaveLength(0);
  });
  it.each(["0.0.0.0", "10.1.1.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002::1"])("refuses an allowed hostname resolving to %s before a TLS socket", async address => {
    tls.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
    await expect(reader.read("https://docs.rs/")).rejects.toThrow("public_research_address_denied");
    expect(tls.requests).toHaveLength(0);
  });
  it("rejects mixed public/private DNS and ignores tampered domain arrays", async () => {
    tls.addresses.push({ address: "fc00::1", family: 6 });
    await expect(reader.read("https://docs.rs/")).rejects.toThrow("public_research_address_denied");
    const forged = createPublicResearchSourceReader({ ...policy, publicSourceDomains: ["evil.example"] });
    await expect(forged.read("https://evil.example/")).rejects.toThrow("public_research_url_denied");
    expect(tls.requests).toHaveLength(0);
  });
  it("refuses a redirect even to an allowed host and bounds actual streamed response bytes", async () => {
    await expect(reader.read("https://docs.rs/redirect")).rejects.toThrow("public_research_redirect_denied");
    expect(tls.requests).toHaveLength(1);
    await expect(reader.read("https://docs.rs/oversize")).rejects.toThrow("public_research_source_too_large");
    const binary = await reader.read("https://static.crates.io/binary");
    expect(binary).toMatchObject({ bodyEncoding: "base64", body: "AAH/" });
  });
  it("rejects an untrusted TLS peer even when the ambient Node TLS default is disabled", async () => {
    // Nearest positive: the same real server succeeds with its TEST CA.
    await expect(reader.read("https://docs.rs/")).resolves.toMatchObject({ status: 200 });
    const ca = tls.ca, previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    tls.requests = []; tls.ca = ""; process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(reader.read("https://docs.rs/")).rejects.toThrow("public_research_transport_failed");
      expect(tls.requests).toHaveLength(0);
    } finally {
      tls.ca = ca;
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });
  it("passes the research surface and completes a real TLS read through a substitute provider", async () => {
    const fake = sourceFactory();
    const parts = createFileBackendCodexWorkerRuntime({ options: { providerInstanceId: "TEST-research", stateRootDir: join(root, "factory-state"),
      workspacePath: root, codexBinaryPath: "/TEST/codex", encryptionKey: new Uint8Array(32), executionEngine: "app-server-goal",
      sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "forged" },
      providerEgressPolicy: policy, appServerProcessFactory: fake.create, warmupPrompt: false, reasoningEffort: "xhigh", serviceTier: "default" },
      workerId: "TEST-research", observability: { emit: () => {}, count: () => {}, timing: () => {} }, clock: { now: () => new Date(), monotonicMs: () => performance.now() }, redactor: new DefaultRedactor() });
    const driver = parts.agentDriver as CodexJsonAgentDriver;
    try {
      expect((await driver.runTask(task())).status).toBe("completed");
      await expectSource(fake);
      const start = fake.requests.find(r => r.method === "thread/start" && (r.params?.dynamicTools as unknown[])?.length);
      expect(start?.params).toMatchObject({ permissions: "hosted-project-write", config: { web_search: "live", service_tier: "default" },
        dynamicTools: [{ name: "public_source_read", type: "function" }] });
      expect((start!.params!.config as { features: Record<string, unknown> }).features.fast_mode).toBeUndefined();
      expect(fake.envs[0]).toMatchObject(codexProviderEgressEnv(policy));
      const config = await readFile(join(fake.codexHomes[0]!, "config.toml"), "utf8");
      expect(config).toContain('web_search = "live"');
      expect(config.match(/":root" = "deny"/g)).toHaveLength(2);
      expect(config).toContain('".git" = "read"'); expect(config).toContain('".codex" = "read"');
      expect(config).not.toContain('"docs.rs" = "allow"');
    } finally { await driver.dispose(); }
  });
  it("forged task tags and a recognized research environment marker never enable source tools", async () => {
    const fake = sourceFactory();
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", goalMode: true,
      processFactory: fake.create, sourceEnv: codexProviderEgressEnv(policy), cleanThreadPrewarm: false }), model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default" });
    try {
      await driver.runTask(task());
      expect(fake.requests.find(r => r.method === "thread/start")!.params).toMatchObject({ config: { web_search: "disabled" } });
      expect(fake.requests.find(r => r.method === "thread/start")!.params!.dynamicTools).toBeUndefined();
      expect(tls.requests).toHaveLength(0); expect(readResult(fake)?.success).not.toBe(true);
    } finally { await driver.dispose(); }
  });
  it("retains captured adapter policy after prewarm, account bytes change and substitute process resume", async () => {
    const store = new RecordingManagedRunStore();
    const home = { cacheKey: "TEST-research-account-slot", rootDir: join(root, "resume-cache"), providerEgressPolicy: policy, preserveOnDispose: true, scrubAuthOnDispose: true };
    const makeDriver = (fake: FakeAppServerFactory) => new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", processFactory: egressBoundCodexProcessFactory(policy, fake.create),
        providerEgressPolicy: policy, publicSourceReader: reader, runStore: store, goalMode: true, cleanThreadPrewarm: false }),
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer(home), model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default" });
    const first = sourceFactory(["blocked"]); const driver = makeDriver(first);
    const cache = new CodexWorkerCacheSessionMaterializer(home);
    const warmed = await cache.prewarm({ session: task().session, redactor: new DefaultRedactor() });
    expect(await readFile(join(warmed.codexHome, "config.toml"), "utf8")).toContain('web_search = "live"');
    await cache.dispose();
    let waiting: Awaited<ReturnType<typeof driver.runTask>>;
    try { waiting = await driver.runTask(task()); await expectSource(first); } finally { await driver.dispose(); }
    if (waiting.status !== "waiting_for_input") throw new Error("expected blocked research goal");
    const second = sourceFactory(["complete"], waiting.resumeHandle.threadId); const resumed = makeDriver(second);
    try {
      const result = await resumed.resumeManagedRun({ ...task(), session: sessionArtifactFromCodexAuthJson(refreshedAuthJson),
        runId: waiting.runId, requestId: waiting.request.id, answer: "Continue public source research", resumeHandle: waiting.resumeHandle });
      if (result.status === "failed") throw new Error(JSON.stringify(result.failure));
      expect(result).toMatchObject({ status: "completed" }); await expectSource(second);
      expect(second.requests.find(r => r.method === "thread/resume")?.params).toMatchObject({
        threadId: waiting.resumeHandle.threadId, config: { web_search: "live", service_tier: "default" } });
      expect(second.requests.find(r => r.method === "thread/resume")?.params?.dynamicTools).toBeUndefined();
      expect(second.codexHomes[0]).toBe(first.codexHomes[0]);
      expect(second.envs[0]).toMatchObject(codexProviderEgressEnv(policy));
      expect(await readFile(join(second.codexHomes[0]!, "config.toml"), "utf8")).toBe(codexJsonHomeConfigToml({ providerEgressPolicy: policy }));
    } finally { await resumed.dispose(); }
  });
  it("pins the captured web policy and read-only broker on logical-thread forks", async () => {
    const fake = sourceFactory();
    const admitted = { ...policy, domains: ["ignored.invalid"] };
    const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", processFactory: fake.create,
      providerEgressPolicy: admitted, publicSourceReader: reader, goalMode: true, cleanThreadPrewarm: false });
    admitted.profileId = CodexProviderEgressProfileId.ProviderApi;
    const driver = new CodexJsonAgentDriver({ engine, model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default" });
    try {
      const result = await driver.runTask({ ...task(), task: { ...task().task,
        execution: { mode: AgentRuntimeExecutionMode.Goal, completionCondition: "Read a public source" } },
        logicalThread: { threadId: "TEST-logical-research", previousCheckpoint: "TEST-retained-research-thread", onCheckpoint: () => {} } });
      expect(result.status).toBe("completed"); await expectSource(fake);
      expect(fake.requests.find(r => r.method === "thread/fork")?.params).toMatchObject({ threadId: "TEST-retained-research-thread",
        deferGoalContinuation: true, config: { web_search: "live", service_tier: "default", features: { multi_agent: false } } });
      expect(fake.requests.find(r => r.method === "thread/fork")?.params?.dynamicTools).toBeUndefined();
    } finally { await driver.dispose(); }
  });
  it.each([
    { threadId: "OTHER-TEST-project", tool: "public_source_read", arguments: { url: "https://docs.rs/" } },
    { threadId: "thread-1", tool: "exec", arguments: { url: "https://docs.rs/" } },
    { threadId: "thread-1", tool: "public_source_read", arguments: { url: "https://docs.rs/", headers: { Authorization: "forbidden caller header" } } },
  ])("refuses an unadmitted tool call before any HTTPS effect: %j", async params => {
    const fake = new FakeAppServerFactory({ emitServerRequestOnTurn: { id: 9002, method: "item/tool/call", params } });
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", processFactory: fake.create,
      providerEgressPolicy: policy, publicSourceReader: reader, goalMode: true, cleanThreadPrewarm: false }), model: "gpt-6.1-sol", reasoningEffort: "xhigh" });
    try {
      await driver.runTask(task());
      expect(readResult(fake)).toMatchObject({ success: false }); expect(tls.requests).toHaveLength(0);
    } finally { await driver.dispose(); }
  });
  it.each(["native-disabled", "tools-disabled", "mimo"])("retains the controlled tool surface for %s", mode => {
    const params = appServerThreadStartParams({ workspacePath: root, model: "fixture", reasoningEffort: "low", ...(mode !== "tools-disabled" ? { goalMode: true } : {}) }, {
      sourceEnv: {}, executionProfile: resolveCodexExecutionProfile(undefined), providerEgressPolicy: policy, publicSourceReader: reader,
      ...(mode === "native-disabled" ? { nativeToolSurface: "disabled" as const } : {}),
      ...(mode === "mimo" ? { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan } : {}),
    });
    expect(params.researchToolsEnabled).toBe(false);
    expect(params.params.config.web_search).toBe("disabled");
    expect(params.params.dynamicTools ?? []).toHaveLength(0);
    expect(codexJsonHomeConfigToml({ providerEgressPolicy: policy, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan })).toContain('web_search = "disabled"');
  });
  // Old reader opened an unbounded number of sockets, including across accounts.
  it("refuses a shared-job burst before DNS/socket work across account slots", async () => {
    const opts = buildCodexGoalExecutorOptions({ config: { jobRootDir: root, taskId: "TEST-burst",
      authRootDir: join(root, "TEST-auth"), workspacePath: root, promptPath: join(root, "prompt"),
      accounts: [{ name: "TEST-a" }, { name: "TEST-b" }] }, providerEgressPolicy: policy,
      stateRootDir: join(root, "TEST-burst-state"), encryptionKey: new Uint8Array(32) });
    const a = opts.accounts[0]!.worker.publicSourceReader!, b = opts.accounts[1]!.worker.publicSourceReader!;
    expect(a).toBe(b);
    const abort = new AbortController();
    const first = a.read("https://docs.rs/slow", abort.signal), second = b.read("https://docs.rs/slow", abort.signal);
    const settled = Promise.allSettled([first, second]);
    try {
      await vi.waitFor(() => expect(tls.requests).toHaveLength(2));
      const before = { dns: tls.dnsCalls, sockets: tls.calls };
      await expect(b.read("https://docs.rs/", abort.signal)).rejects.toThrow("public_research_capacity");
      expect({ dns: tls.dnsCalls, sockets: tls.calls }).toEqual(before);
    } finally { abort.abort(); await settled; }
    await vi.waitFor(() => expect(tls.activeBodies).toBe(0));
    expect((await a.read("https://docs.rs/")).status).toBe(200);
  });
  // Old per-call body cap allowed unlimited cumulative results and JSON escaping.
  it("bounds aggregate delivered result bytes and serialized expansion", async () => {
    const bounded = createPublicResearchSourceReader(policy);
    for (let count = 0; count < 6; count++) await bounded.read("https://docs.rs/nearcap");
    const before = { dns: tls.dnsCalls, sockets: tls.calls };
    await expect(bounded.read("https://docs.rs/nearcap")).rejects.toThrow("public_research_result_budget");
    expect({ dns: tls.dnsCalls, sockets: tls.calls }).toEqual(before);
    await expect(createPublicResearchSourceReader(policy).read("https://docs.rs/escaped")).rejects.toThrow("public_research_result_too_large");
  });
  // Old call handling ignored turnId, callId, abort and terminal closure.
  it("refuses stale, missing, duplicate and closed calls with zero network effects", async () => {
    const session = new PublicResearchToolSession(); const controller = new AbortController();
    session.admit("TEST-thread"); session.beginTurn("TEST-thread", controller.signal); session.bindTurn("TEST-thread", "TEST-turn");
    const replies: Record<string, unknown>[] = [];
    const invoke = (fields: Record<string, unknown> = {}) => handlePublicResearchSourceTool({ reader: createPublicResearchSourceReader(policy), session,
      params: { threadId: "TEST-thread", turnId: "TEST-turn", callId: "TEST-call", tool: "public_source_read", arguments: { url: "https://docs.rs/" }, ...fields },
      respond: result => replies.push(result) });
    invoke({ turnId: "stale-turn" }); invoke({ callId: "" }); invoke({ threadId: "OTHER-TEST" });
    expect(tls.calls).toBe(0); expect(tls.dnsCalls).toBe(0);
    invoke(); await vi.waitFor(() => expect(replies.some(r => r.success)).toBe(true));
    const before = { dns: tls.dnsCalls, sockets: tls.calls };
    invoke(); session.endTurn("TEST-thread"); invoke({ callId: "late-call" });
    session.beginTurn("TEST-thread", controller.signal); session.bindTurn("TEST-thread", "next-turn");
    session.closeThread("TEST-thread"); invoke({ turnId: "next-turn", callId: "after-close" });
    expect({ dns: tls.dnsCalls, sockets: tls.calls }).toEqual(before);
    expect(replies.filter(r => r.success === false)).toHaveLength(6);
  });
  it("cancels resolver work without creating a late TLS request", async () => {
    tls.dnsWait = true;
    const controller = new AbortController();
    const result = createPublicResearchSourceReader(policy).read("https://docs.rs/", controller.signal);
    const assertion = expect(result).rejects.toThrow("public_research_aborted");
    await vi.waitFor(() => expect(tls.dnsCalls).toBe(2)); controller.abort(); await assertion;
    expect(tls.dnsCanceled).toBe(1); expect(tls.calls).toBe(0); expect(tls.requests).toHaveLength(0);
  });
  it("aborts TLS negotiation and destroys the owned socket", async () => {
    const sockets = new Set<Socket>();
    const stalled = createTcpServer(socket => { sockets.add(socket); socket.resume(); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => stalled.listen(0, "127.0.0.1", resolve));
    const previousPort = tls.port; tls.port = (stalled.address() as { port: number }).port;
    const controller = new AbortController();
    const result = createPublicResearchSourceReader(policy).read("https://docs.rs/", controller.signal);
    const assertion = expect(result).rejects.toThrow("public_research_aborted");
    try {
      await vi.waitFor(() => expect(sockets.size).toBe(1)); controller.abort(); await assertion;
      await vi.waitFor(() => expect(sockets.size).toBe(0)); expect(tls.requests).toHaveLength(0);
    } finally { controller.abort(); for (const socket of sockets) socket.destroy();
      tls.port = previousPort; await new Promise<void>(resolve => stalled.close(() => resolve())); }
  });
  it.each(["turn-close", "client-stop"])("aborts an actual streamed body on %s", async mode => {
    const session = new PublicResearchToolSession(); const controller = new AbortController();
    session.admit("TEST-thread"); session.beginTurn("TEST-thread", controller.signal); session.bindTurn("TEST-thread", "TEST-turn");
    const response = new Promise<Record<string, unknown>>(resolve => handlePublicResearchSourceTool({ reader: createPublicResearchSourceReader(policy), session,
      params: { threadId: "TEST-thread", turnId: "TEST-turn", callId: "stream", tool: "public_source_read", arguments: { url: "https://docs.rs/slow" } }, respond: resolve }));
    try {
      await vi.waitFor(() => expect(tls.activeBodies).toBe(1));
      if (mode === "client-stop") session.stop(); else session.endTurnId("TEST-turn");
      expect(await response).toMatchObject({ success: false, contentItems: [{ text: "public_research_aborted" }] });
      await vi.waitFor(() => expect(tls.activeBodies).toBe(0)); expect(tls.closedBodies).toBe(1);
    } finally { session.stop(); }
  });
  it("client disposal cancels source work even when its provider turn is still active", async () => {
    const fake = new FakeAppServerFactory({ suppressTurnCompletion: true, emitServerRequestOnTurn: { id: 9002, method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", callId: "stop-stream", tool: "public_source_read", arguments: { url: "https://docs.rs/slow" } } } });
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", processFactory: fake.create,
      providerEgressPolicy: policy, publicSourceReader: createPublicResearchSourceReader(policy), goalMode: true, cleanThreadPrewarm: false }), model: "gpt-6.1-sol" });
    const running = driver.runTask(task());
    try { await vi.waitFor(() => expect(tls.activeBodies).toBe(1)); await driver.dispose();
      await vi.waitFor(() => expect(tls.activeBodies).toBe(0)); expect(tls.closedBodies).toBe(1);
    } finally { await driver.dispose(); await running; }
  });

  it("overlays closed native tools on a research fork without admitting source calls", async () => {
    const fake = sourceFactory();
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex",
      processFactory: fake.create, providerEgressPolicy: policy, publicSourceReader: reader,
      nativeToolSurface: "disabled", goalMode: true, cleanThreadPrewarm: false }), model: "gpt-6.1-sol" });
    try {
      await driver.runTask({ ...task(), logicalThread: { threadId: "TEST-closed-fork", previousCheckpoint: "TEST-closed-parent", onCheckpoint: () => {} } });
      expect(fake.requests.find(r => r.method === "thread/fork")?.params).toMatchObject({ config: { web_search: "disabled",
        features: { shell_tool: false, unified_exec: false }, tools: { view_image: false } } });
      expect(readResult(fake)?.success).toBe(false); expect(tls.dnsCalls).toBe(0); expect(tls.calls).toBe(0);
    } finally { await driver.dispose(); }
  });
  it("keeps native tools closed on validated research process-restart resume", async () => {
    const store = new RecordingManagedRunStore();
    const make = (fake: FakeAppServerFactory) => new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex",
      processFactory: fake.create, providerEgressPolicy: policy, publicSourceReader: reader, runStore: store,
      nativeToolSurface: "disabled", goalMode: true, cleanThreadPrewarm: false }), model: "gpt-6.1-sol" });
    const first = sourceFactory(["blocked"]); const driver = make(first);
    let waiting: Awaited<ReturnType<typeof driver.runTask>>;
    try { waiting = await driver.runTask(task()); } finally { await driver.dispose(); }
    if (waiting.status !== "waiting_for_input") throw new Error("expected TEST waiting handle");
    const second = sourceFactory(["complete"], waiting.resumeHandle.threadId); const resumed = make(second);
    try {
      const result = await resumed.resumeManagedRun({ ...task(), runId: waiting.runId, requestId: waiting.request.id,
        answer: "Continue TEST", resumeHandle: waiting.resumeHandle });
      expect(result.status).toBe("completed");
      expect(second.requests.find(r => r.method === "thread/resume")?.params).toMatchObject({ config: { web_search: "disabled",
        features: { shell_tool: false, unified_exec: false }, tools: { view_image: false } } });
      expect(readResult(second)?.success).toBe(false); expect(tls.dnsCalls).toBe(0); expect(tls.calls).toBe(0);
    } finally { await resumed.dispose(); }
  });

  it("does not grant source authority to a replayed early turn notification", async () => {
    const fake = new FakeAppServerFactory({ onRequest: request => {
      if (request.method !== "turn/start") return;
      const threadId = String(request.params!.threadId);
      fake.processes.at(-1)!.stdout.emit("data", [
        { method: "turn/started", params: { threadId, turn: { id: "stale-replayed-turn" } } },
        { id: 9003, method: "item/tool/call", params: { threadId, turnId: "stale-replayed-turn", callId: "stale-call",
          tool: "public_source_read", arguments: { url: "https://docs.rs/" } } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
      expect(tls.dnsCalls).toBe(0); expect(tls.calls).toBe(0);
    } });
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex",
      processFactory: fake.create, providerEgressPolicy: policy, publicSourceReader: reader,
      goalMode: true, cleanThreadPrewarm: false }), model: "gpt-6.1-sol" });
    try {
      await driver.runTask(task());
      expect(fake.responses.find(r => r.id === 9003)?.result).toMatchObject({ success: false });
      expect(tls.dnsCalls).toBe(0); expect(tls.calls).toBe(0);
    } finally { await driver.dispose(); }
  });

  it("releases replaced prepared research threads before they exhaust client admission", async () => {
    const fake = sourceFactory();
    const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/codex", processFactory: fake.create,
      providerEgressPolicy: policy, publicSourceReader: reader, goalMode: true,
      executionProfile: { kind: "custom", disableTools: false }, cleanThreadPrewarm: true });
    const input = { session: { home: root, codexHome: root, sessionHash: "TEST-prepared-lifecycle",
      env: { HOME: root, CODEX_HOME: root }, release: async () => {} },
      workspacePath: root, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
      model: "gpt-6.1-sol", reasoningEffort: "low" as const, abortSignal: new AbortController().signal };
    try {
      for (let index = 0; index < 130; index++) {
        const warmed = await engine.prewarm({ ...input, reasoningEffort: index % 2 ? "high" : "low" });
        expect(warmed.warnings).toEqual([]);
      }
      const result = await engine.run({ ...input, prompt: "Read TEST official-source fixture", sandboxMode: "workspace-write" });
      expect(result.outputText).not.toBe("");
      await expectSource(fake); expect(tls.requests).toHaveLength(1);
    } finally { await engine.dispose(); }
  });

});
