import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const helper = new URL("../app-server/adapters/hosted-process-descriptors.ts", import.meta.url).href;
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
