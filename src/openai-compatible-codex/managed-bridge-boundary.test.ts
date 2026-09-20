import { lstatSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireManagedBridgeBoundary } from "./managed-bridge-boundary.js";
import { loadOpenAiCompatibleCodexBridgeConfigFromEnv } from "./config.js";

vi.mock("node:fs", () => ({ lstatSync: vi.fn() }));
vi.mock("./config.js", () => ({ loadOpenAiCompatibleCodexBridgeConfigFromEnv: vi.fn() }));
vi.mock("./chat-completions/index.js", () => ({
  CodexOpenAiBridgeBackend: vi.fn(), OpenAiBridgeChatCompletionUseCase: vi.fn(),
  startOpenAiBridgeHttpServer: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.mocked(lstatSync).mockReturnValue({} as ReturnType<typeof lstatSync>);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("allows startup only when both managed policy and launcher are absent", () => {
  vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  expect(requireManagedBridgeBoundary).not.toThrow();
  expect(vi.mocked(lstatSync).mock.calls).toEqual([
    ["/etc/subscription-runtime/storage-root"],
    ["/opt/subscription-runtime/managed-launcher/launch.mjs"],
  ]);
});
it.each(["regular file", "symlink", "directory", "character device"])("denies missing policy with installed launcher %s", type => {
  vi.mocked(lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  vi.mocked(lstatSync).mockReturnValue({
    isFile: () => type === "regular file",
    isSymbolicLink: () => type === "symlink",
    isDirectory: () => type === "directory",
    isCharacterDevice: () => type === "character device",
  } as ReturnType<typeof lstatSync>);
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_disabled_on_managed_host");
  expect(lstatSync).toHaveBeenNthCalledWith(2, "/opt/subscription-runtime/managed-launcher/launch.mjs");
});
it.each(["EACCES", "EIO", "ENOTDIR", "ELOOP"])("denies launcher inspection error %s when policy is absent", code => {
  vi.mocked(lstatSync)
    .mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })
    .mockImplementationOnce(() => { throw Object.assign(new Error("inspection"), { code }); });
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_managed_host_inspection_failed");
});
it.each(["regular file", "symlink", "dangling symlink", "directory", "null character device"])("denies %s without following it", type => {
  vi.mocked(lstatSync).mockReturnValue({
    isFile: () => type === "regular file",
    isSymbolicLink: () => type.includes("symlink"),
    isDirectory: () => type === "directory",
    isCharacterDevice: () => type === "null character device",
    rdev: type === "null character device" ? 259 : 0,
  } as ReturnType<typeof lstatSync>);
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_disabled_on_managed_host");
  expect(lstatSync).toHaveBeenCalledExactlyOnceWith("/etc/subscription-runtime/storage-root");
});
it.each(["EACCES", "EIO", "ENOTDIR", "ELOOP"])("denies inspection error %s", code => {
  vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error("inspection"), { code }); });
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_managed_host_inspection_failed");
});
it.each([undefined, null, "ENOENT"])("denies unclassified inspection errors: %s", error => {
  vi.mocked(lstatSync).mockImplementation(() => { throw error; });
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_managed_host_inspection_failed");
});
it("forged environment cannot bypass the interlock", () => {
  vi.stubEnv("SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH", "1");
  vi.stubEnv("SUBSCRIPTION_RUNTIME_MANAGED_HOST", "0");
  vi.stubEnv("SUBSCRIPTION_RUNTIME_JOB_ROOT", "/synthetic/job");
  expect(requireManagedBridgeBoundary).toThrow("openai_bridge_disabled_on_managed_host");
});
it.each(["existing", "launcher only", "inspection error"])("CLI denies %s before config, backend state, or HTTP startup", async condition => {
  if (condition === "launcher only") {
    vi.mocked(lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  }
  if (condition === "inspection error") {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error("inspection"), { code: "EACCES" }); });
  }
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.argv = [process.execPath, "synthetic-bridge", "serve"];
  try {
    await import("./cli.js");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(condition !== "inspection error"
      ? "openai_bridge_disabled_on_managed_host"
      : "openai_bridge_managed_host_inspection_failed"));
    expect(process.exitCode).toBe(1);
    expect(loadOpenAiCompatibleCodexBridgeConfigFromEnv).not.toHaveBeenCalled();
    const { CodexOpenAiBridgeBackend, OpenAiBridgeChatCompletionUseCase, startOpenAiBridgeHttpServer } = await import("./chat-completions/index.js");
    expect(CodexOpenAiBridgeBackend).not.toHaveBeenCalled();
    expect(OpenAiBridgeChatCompletionUseCase).not.toHaveBeenCalled();
    expect(startOpenAiBridgeHttpServer).not.toHaveBeenCalled();
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
