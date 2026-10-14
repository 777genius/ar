import { expect, it } from "vitest";
import { assertHostedFdFrameEnvironment } from "../app-server/adapters/hosted-fd-prelude";
import { assertHostedForegroundResult } from "../app-server/adapters/hosted-fd-launch";

// Regression: the private frame makes a root CLI load a project-controlled
// Node/preload hook or redirect Git/registry before its protected admission.
it.each(["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "LD_AUDIT", "LD_UNKNOWN",
  "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_COUNT", "OPENSSL_CONF", "GCONV_PATH",
  "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"])("rejects root frame override %s", key => {
  expect(() => assertHostedFdFrameEnvironment({ [key]: "" })).toThrow("hosted_fd_frame_environment_denied");
});
// Regression: serialized output metadata is accepted as proof of real close
// and owned stream drainage without the retained actual ChildProcess.
it("refuses reconstructed foreground process facts", () => {
  expect(() => assertHostedForegroundResult({ exitCode: 0,
    unit: "subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service",
    startId: "12345678-1234-1234-1234-123456789abc", artifacts: [] })).toThrow("hosted_fd_boundary_unresolved");
});
it("keeps ordinary application environment data without granting admission", () => {
  expect(() => assertHostedFdFrameEnvironment({ HOME: "/job/home", PATH: "/usr/bin:/bin", LANG: "C",
    SUBSCRIPTION_RUNTIME_JOB_ID: "TEST-fd-contract", NODE_OPTIONS: undefined })).not.toThrow();
});
