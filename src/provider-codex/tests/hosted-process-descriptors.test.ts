import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const helper = new URL("../../../dist/provider-codex/app-server/adapters/hosted-process-descriptors.js", import.meta.url).href;
// Standard test script builds first; exercise the actual compiled lower adapter
// without adding a source loader or changing the contained helper closure.
const retainedHelper = new URL("../../../dist/provider-codex/app-server/adapters/hosted-retained-tool-files.js", import.meta.url).href;
const probe = `import { assertHostedProcessDescriptors } from ${JSON.stringify(helper)};
try { assertHostedProcessDescriptors(); process.stdout.write("accepted"); }
catch (error) { process.stdout.write(error.message); process.exitCode = 70; }`;

it("accepts an actual fresh process with only pipe stdio", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", stdio: "pipe" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("accepted");
});

it.each(["writable", "readonly", "opath", "directory", "stdio"] as const)(
  "rejects an actual inherited %s descriptor before untrusted code", kind => {
    const root = mkdtempSync(join(tmpdir(), "readonly-fd-"));
    const target = join(root, "protected");
    writeFileSync(target, "unchanged");
    const fd = openSync(kind === "directory" ? root : target,
      kind === "writable" || kind === "stdio" ? constants.O_RDWR : kind === "opath" ? 0x200000 : constants.O_RDONLY);
    try {
      // This real exec inherits exactly one explicit file/directory descriptor.
      // The fixture never touches host authority or creates mounts/namespaces.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
        encoding: "utf8", stdio: kind === "stdio" ? [fd, "pipe", "pipe"] : ["pipe", "pipe", "pipe", fd],
      });
      expect(result.status).toBe(70);
      expect(result.stdout).toBe(kind === "stdio" ? "hosted_custody_stdio_pipe_required" : "hosted_custody_inherited_handle_denied");
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
  },
);

it("checks descriptors in the actual provider launcher before spawning its frame command", () => {
  const source = readFileSync(fileURLToPath(new URL("../app-server/adapters/hosted-app-server-launcher.ts", import.meta.url)), "utf8");
  expect(source.indexOf("assertHostedProcessDescriptors();")).toBeGreaterThan(0);
  expect(source.indexOf("assertHostedProcessDescriptors();")).toBeLessThan(source.indexOf("spawn(frame.command"));
});

const factProbe = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const mode = process.argv[1], replacement = process.argv[2];
const originalStat = fs.fstatSync, originalNames = fs.readdirSync;
let observed = false;
if (mode === "metadata-error") fs.readlinkSync = function() { throw Object.assign(new Error("TEST private metadata canary"), { code: "EACCES" }); };
if (mode === "initial-closed") fs.readdirSync = function(path, ...args) {
  const names = originalNames(path, ...args);
  if (path === "/proc/self/fd") fs.closeSync(3);
  return names;
};
if (["closed", "replaced", "long-number"].includes(mode)) {
  fs.fstatSync = function(fd, ...args) {
    const stat = originalStat(mode === "long-number" && fd > 999999 ? 3 : fd, ...args);
    if (fd === 3 && !observed && mode !== "long-number") {
      observed = true; fs.closeSync(3);
      if (mode === "replaced" && fs.openSync(replacement, fs.constants.O_RDONLY) !== 3) throw new Error("TEST replacement mismatch");
    }
    return stat;
  };
  if (mode === "long-number") fs.readdirSync = function(path, ...args) {
    return path === "/proc/self/fd" ? ["0", "1", "2", "123456789012345678901234567890"] : originalNames(path, ...args);
  };
}
syncBuiltinESMExports();
const { assertHostedProcessDescriptors } = await import(${JSON.stringify(helper)});
try { assertHostedProcessDescriptors(); process.stdout.write("accepted"); }
catch (error) { process.stdout.write(JSON.stringify({ message: error.message, cause: error.cause?.message })); process.exitCode = 70; }`;

it.skipIf(process.platform !== "linux").each([
  ["readonly", constants.O_RDONLY, "file", "read"],
  ["writable", constants.O_WRONLY, "file", "write"],
  ["readwrite", constants.O_RDWR, "file", "readwrite"],
  ["opath", 0x200000, "file", "path"],
  ["directory", constants.O_RDONLY, "directory", "read"],
] as const)("retains denial and closed facts for an actual inherited %s FD", (kind, flags, type, access) => {
  const root = mkdtempSync(join(tmpdir(), "TEST-private-fd-canary-"));
  const target = join(root, "TEST-private-name.events.jsonl"); writeFileSync(target, "private unchanged bytes");
  const fd = openSync(kind === "directory" ? root : target, flags);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", factProbe, "stable"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd],
    });
    expect(result.status).toBe(70);
    expect(JSON.parse(result.stdout)).toEqual({ message: "hosted_custody_inherited_handle_denied",
      cause: `hosted_fd_fact fd=3 type=${type} access=${access} role=${kind === "directory" ? "unknown" : "event"}` });
    expect(result.stdout).not.toContain(root); expect(result.stdout).not.toContain("TEST-private-name");
    expect(readFileSync(target, "utf8")).toBe("private unchanged bytes");
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux").each(["closed", "replaced", "long-number", "metadata-error", "initial-closed"] as const)(
  "retains denial with unknown metadata after actual descriptor %s", mode => {
    const root = mkdtempSync(join(tmpdir(), "TEST-private-fd-race-"));
    const target = join(root, "original"), replacement = join(root, "replacement");
    writeFileSync(target, "original bytes"); writeFileSync(replacement, "replacement bytes");
    const fd = openSync(target, constants.O_RDONLY);
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", factProbe, mode, replacement], {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd],
      });
      if (mode === "initial-closed") { expect(result.status).toBe(0); expect(result.stdout).toBe("accepted"); return; }
      expect(result.status).toBe(70);
      expect(JSON.parse(result.stdout)).toEqual({ message: "hosted_custody_inherited_handle_denied",
        cause: `hosted_fd_fact fd=${mode === "long-number" ? 0 : 3} type=file access=unknown role=unknown` });
      expect(result.stdout).not.toContain(root); expect(result.stdout).not.toContain("123456789012345678901234567890");
      expect(readFileSync(target, "utf8")).toBe("original bytes");
      expect(readFileSync(replacement, "utf8")).toBe("replacement bytes");
    } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
  },
);

it.skipIf(process.platform !== "linux").each([
  [".terminal-checkpoint-admission/writers/01234567-89ab-4cde-8fab-0123456789ab", "checkpoint_writer"],
  [".terminal-checkpoint-admission-other/writers/01234567-89ab-4cde-8fab-0123456789ab", "unknown"],
  [".terminal-checkpoint-admission/writers-extra/01234567-89ab-4cde-8fab-0123456789ab", "unknown"],
  [".terminal-checkpoint-admission/writers/01234567-89ab-4cde-8fab-0123456789ab.json", "unknown"],
  [".terminal-checkpoint-admission/writers/01234567-89AB-4CDE-8FAB-0123456789AB", "unknown"],
  [".terminal-checkpoint-admission/writers/01234567-89ab-4cde-8fab-0123456789ab-secret=TEST-PRIVATE-CANARY", "unknown"],
  [".terminal-checkpoint-admission/mutex/owner", "checkpoint_mutex_owner"],
  [".terminal-checkpoint-admission-other/mutex/owner", "unknown"],
  [".terminal-checkpoint-admission/mutex-other/owner", "unknown"],
  [".terminal-checkpoint-admission/mutex/owner-secret=TEST-PRIVATE-CANARY", "unknown"],
] as const)("reports only a closed lexical role for actual writer-shaped FD %s", (relative, role) => {
  const root = mkdtempSync(join(tmpdir(), "TEST-private-writer-canary-"));
  const target = join(root, relative); mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "TEST-PRIVATE-CONTENT-CANARY");
  const fd = openSync(target, constants.O_WRONLY);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", factProbe, "stable"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd],
    });
    expect(result.status).toBe(70);
    expect(JSON.parse(result.stdout)).toEqual({ message: "hosted_custody_inherited_handle_denied",
      cause: `hosted_fd_fact fd=3 type=file access=write role=${role}` });
    expect(result.stdout).not.toContain(root); expect(result.stdout).not.toContain("01234567");
    expect(result.stdout).not.toContain("CANARY"); expect(result.stdout).not.toContain("secret");
    expect(readFileSync(target, "utf8")).toBe("TEST-PRIVATE-CONTENT-CANARY");
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

it.each(["readonly", "opath", "directory", "state-journal", "alias"] as const)(
  "a copied retained scope cannot exempt an actual %s FD", kind => {
    const root = mkdtempSync(join(tmpdir(), "retained-fd-"));
    const target = join(root, kind === "state-journal" ? "state-journal" : "protected");
    writeFileSync(target, "unchanged");
    const fd = openSync(kind === "directory" ? root : target, kind === "opath" ? 0x200000 : constants.O_RDONLY);
    const alias = kind === "alias" ? openSync(target, constants.O_RDONLY) : undefined;
    const scopedProbe = `import { assertHostedRetainedToolDescriptors } from ${JSON.stringify(retainedHelper)};
try { assertHostedRetainedToolDescriptors({ unit: "subscription-runtime-hosted-01234567-89ab-cdef-0123-456789abcdef.service", fd: 3,
  path: ${JSON.stringify(target)} }); process.stdout.write("accepted"); }
catch (error) { process.stdout.write(error.message); process.exitCode = 70; }`;
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", scopedProbe], {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd, ...(alias === undefined ? [] : [alias])],
      });
      expect(result.status).toBe(70);
      expect(result.stdout).toBe("hosted_retained_tool_files_denied");
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally { if (alias !== undefined) closeSync(alias); closeSync(fd); rmSync(root, { recursive: true, force: true }); }
  },
);
