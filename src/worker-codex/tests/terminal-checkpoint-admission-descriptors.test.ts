import { spawnSync } from "node:child_process";
import { fstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({ opened: undefined as ((fd: number) => void) | undefined, failSync: false }));
// Observe real native handles at the same microtask boundary for both APIs.
// Opens return actual handles; only the explicit fsync-failure case injects an
// error. File contents and close operations always use the native filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args); observation.opened?.(fd); return fd;
  }, fsyncSync: (fd: number) => {
    if (observation.failSync) { observation.failSync = false; throw Object.assign(new Error("TEST fsync failure"), { code: "EIO" }); }
    return actual.fsyncSync(fd);
  } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args); observation.opened?.(file.fd); return file;
  } };
});
import { LocalTerminalCheckpointAdmission } from "../../store-local-file/terminal-checkpoint/local-terminal-checkpoint-admission";

it("closes actual private writer and directory handles before the next microtask", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-checkpoint-fd-"));
  const held: string[] = [], observed: string[] = [];
  observation.opened = fd => {
    const before = fstatSync(fd), kind = before.isDirectory() ? "directory" : "file";
    observed.push(kind);
    queueMicrotask(() => {
      try {
        const after = fstatSync(fd);
        if (before.dev === after.dev && before.ino === after.ino && before.mode === after.mode) held.push(kind);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
    });
  };
  try {
    let effects = 0;
    await new LocalTerminalCheckpointAdmission(root).withWriter(async () => {
      effects++;
      const writers = join(root, ".terminal-checkpoint-admission", "writers"), names = readdirSync(writers);
      expect(names).toHaveLength(1);
      expect(readFileSync(join(writers, names[0]!), "utf8")).toBe(`${process.pid}\n`);
      expect(statSync(join(writers, names[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(writers).mode & 0o777).toBe(0o700);
      await Promise.resolve();
    });
    await Promise.resolve();
    expect(effects).toBe(1); expect(observed).toContain("file"); expect(observed).toContain("directory");
    expect(held).toEqual([]);
    expect(readdirSync(join(root, ".terminal-checkpoint-admission"))).toEqual(["writers"]);
  } finally { observation.opened = undefined; rmSync(root, { recursive: true, force: true }); }
});

it("closes a real writer handle and withholds the effect when fsync fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-checkpoint-fsync-"));
  let effect = false;
  const opened: number[] = [];
  observation.opened = fd => { opened.push(fd); };
  observation.failSync = true;
  try {
    await expect(new LocalTerminalCheckpointAdmission(root).withWriter(async () => { effect = true; })).rejects.toMatchObject({ code: "EIO" });
    expect(effect).toBe(false); expect(opened.length).toBeGreaterThan(0);
    for (const fd of opened) expect(() => fstatSync(fd)).toThrow();
    expect(readdirSync(join(root, ".terminal-checkpoint-admission"))).toEqual(["writers"]);
  } finally { observation.opened = undefined; observation.failSync = false; rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("passes an actual strict census between admission I/O turns", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-checkpoint-native-census-")));
  const adapter = new URL("../../../dist/store-local-file/terminal-checkpoint/local-terminal-checkpoint-admission.js", import.meta.url).href;
  const census = new URL("../../../dist/provider-codex/app-server/adapters/hosted-process-descriptors.js", import.meta.url).href;
  const script = `import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { assertHostedProcessDescriptors } from ${JSON.stringify(census)};
const root = process.argv[1], failures = []; let observed = 0;
function observe(path) {
  if (typeof path !== "string" || !path.startsWith(root + "/")) return;
  observed++;
  queueMicrotask(() => { try { assertHostedProcessDescriptors(); } catch (error) { failures.push(error.message); } });
}
const openSync = fs.openSync, open = promises.open;
fs.openSync = function(path, ...args) { const fd = openSync(path, ...args); observe(path); return fd; };
promises.open = async function(path, ...args) { const file = await open(path, ...args); observe(path); return file; };
syncBuiltinESMExports();
const { LocalTerminalCheckpointAdmission } = await import(${JSON.stringify(adapter)});
await new LocalTerminalCheckpointAdmission(root).withWriter(async () => { assertHostedProcessDescriptors(); await Promise.resolve(); });
await Promise.resolve();
assertHostedProcessDescriptors();
if (observed < 2 || failures.length !== 0) throw new Error("TEST admission census failed");
process.stdout.write("admission-closed");`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", stdio: "pipe" });
    expect(result.status).toBe(0); expect(result.stdout).toBe("admission-closed"); expect(result.stderr).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
