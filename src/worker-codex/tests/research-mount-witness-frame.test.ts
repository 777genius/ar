import { host, local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as processes from "node:child_process";
import { researchDurableDirectories, researchDurableDirectory } from "../research-durable-handoff-directory";
import { readResearchColdMountTable, researchMountWitnessRows } from "../research-mount-witness-frame";
const native = await vi.importActual<typeof import("node:fs")>("node:fs");
beforeEach(setupResearchFixture); afterEach(cleanupResearchFixture);
const paths = ["/TEST-project/jobs/TEST-research-r7", "/TEST-project/jobs/TEST-research-r7/workspace"];
it("collects exact two-target witnesses without listing unrelated mounts, and queries freshly each assertion", () => {
  const expected = paths.map(path => researchDurableDirectory(path, false)); host.calls.length = 0;
  expect(researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toEqual(expected);
  expect(host.calls.filter(call => call.command === "/usr/bin/findmnt").map(call => call.args))
    .toEqual(paths.map(path => ["--task", "1", "--target", path, "--json", "--output", "ID,TARGET,UUID,FSROOT,MAJ:MIN"]));
  researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })));
  expect(host.calls.filter(call => call.command === "/usr/bin/findmnt")).toHaveLength(4);
  const larger = [paths[0]!, paths[1]!, "/TEST-project"];
  host.calls.length = 0;
  expect(researchDurableDirectories(larger.map(path => ({ path, privateLeaf: false })))).toHaveLength(3);
  expect(host.calls.filter(call => call.command === "/usr/bin/findmnt").map(call => call.args))
    .toEqual([["--task", "1", "--list", "--json", "--output", "ID,TARGET,UUID,FSROOT,MAJ:MIN"]]);
});
it.each(["custody", "mount-id", "mount-row"])("rejects %s changes inside the synchronous query frame", fault => {
  host.findmntHook = () => {
    if (fault === "custody") fs.chmodSync(local(paths[0]!), 0o777);
    if (fault === "mount-id") host.pins.set(paths[0]!, paths[0]!);
    if (fault === "mount-row") host.pins.set("/TEST-mount", "/TEST-other");
  };
  if (fault === "mount-row") host.pins.set("/TEST-mount", "/TEST-before");
  if (fault === "mount-row") {
    // A changed unrelated mount does not alter either selected witness.
    expect(researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toHaveLength(2);
  } else expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
});
it.each(["duplicate", "extra-key", "timeout", "overflow", "cardinality"])("rejects bounded query %s", fault => {
  const row = { id: 1, target: "/", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", fsroot: "/", "maj:min": "8:1" };
  vi.spyOn(processes, "spawnSync").mockReturnValue({ status: fault === "timeout" ? null : 0,
    pid: 1, output: [], stderr: "", signal: null,
    error: fault === "timeout" ? Object.assign(new Error("TEST timeout"), { code: "ETIMEDOUT" }) : undefined,
    stdout: fault === "overflow" ? " ".repeat(16 * 1024 * 1024 + 1) : JSON.stringify({ filesystems: fault === "duplicate" ? [row, row] : fault === "cardinality" ? Array(50001).fill(row) : [{ ...row, ...(fault === "extra-key" ? { children: [] } : {}) }] }),
  } as ReturnType<typeof processes.spawnSync>);
  expect(() => researchMountWitnessRows()).toThrow();
});
it("rejects directory replacement after all descriptors were opened", () => {
  host.findmntHook = () => { fs.renameSync(local(paths[1]!), local(paths[1]!) + "-old"); fs.mkdirSync(local(paths[1]!), { mode: 0o700 }); };
  expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
});
it.each(["uuid", "device", "backing"])("rejects selected mount %s corruption on the second target and closes retained descriptors", fault => {
  const spawn = processes.spawnSync;
  let queries = 0;
  const opened = vi.spyOn(fs, "openSync");
  vi.spyOn(processes, "spawnSync").mockImplementation(((...args: Parameters<typeof processes.spawnSync>) => {
    const result = spawn(...args), parsed = JSON.parse(String(result.stdout));
    if (++queries === 2) {
      if (fault === "uuid") parsed.filesystems[0].uuid = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
      if (fault === "device") parsed.filesystems[0]["maj:min"] = "9:99";
      if (fault === "backing") parsed.filesystems[0].fsroot = "/TEST-foreign";
    }
    return { ...result, stdout: JSON.stringify(parsed) };
  }) as typeof processes.spawnSync);
  expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
  expect(queries).toBe(2);
  const retainedFds = opened.mock.results.filter(result => result.type === "return").map(result => result.value as number);
  expect(retainedFds.length).toBeGreaterThanOrEqual(2);
  for (const fd of new Set(retainedFds)) expect(() => native.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("retains one total fifteen-second query budget and never accepts late target evidence", () => {
  const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n).mockReturnValueOnce(0n)
    .mockReturnValueOnce(14_000_000_000n).mockReturnValueOnce(14_000_000_000n).mockReturnValue(15_000_000_000n);
  const spawn = vi.spyOn(processes, "spawnSync");
  expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
  expect(spawn.mock.calls.map(call => (call[2] as { timeout: number }).timeout)).toEqual([15000, 1000]);
  expect(clock).toHaveBeenCalled();
});
it("refuses a missing second target record instead of retaining only the first query", () => {
  const spawn = processes.spawnSync; let queries = 0;
  vi.spyOn(processes, "spawnSync").mockImplementation(((...args: Parameters<typeof processes.spawnSync>) => {
    const result = spawn(...args);
    return ++queries === 2 ? { ...result, stdout: JSON.stringify({ filesystems: [] }) } : result;
  }) as typeof processes.spawnSync);
  expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
  expect(queries).toBe(2);
});

it("reads cold mountinfo in 64KiB requests and refuses over 8MiB", () => {
  const read = vi.spyOn(fs, "readSync");
  expect(readResearchColdMountTable()).toContain("8:1");
  expect(read.mock.calls.every(args => (args as readonly unknown[])[3] === 65536)).toBe(true);
  read.mockImplementation(() => 65536);
  expect(() => readResearchColdMountTable()).toThrow();
});

it("rejects symlink ancestry before opening any path through it", () => {
  const parent = local("/TEST-project/jobs");
  fs.renameSync(parent, parent + "-old"); fs.symlinkSync(parent + "-old", parent);
  const opens = vi.spyOn(fs, "openSync");
  expect(() => researchDurableDirectories(paths.map(path => ({ path, privateLeaf: false })))).toThrow();
  expect(opens.mock.calls.some(args => String(args[0]).startsWith("/proc/1/root/TEST-project/jobs/"))).toBe(false);
  expect(host.calls.filter(call => call.command === "/usr/bin/findmnt")).toHaveLength(0);
});
