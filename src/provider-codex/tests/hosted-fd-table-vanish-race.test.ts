import { expect, it, vi } from "vitest";

// Deterministic model of the kernel fdinfo race: seq_show prints nothing when
// the descriptor is no longer held at read time, so the read succeeds with an
// empty body instead of ENOENT.
const state = vi.hoisted(() => ({
  links: new Map<string, string>(),
  reads: new Map<string, string[]>(),
  rows: new Map<string, Readonly<{ dev: bigint; ino: bigint; rdev: bigint; socket: boolean; pipe: boolean;
    character: boolean; file: boolean; directory: boolean }>>(),
  alive: true,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const enoent = (): never => { const error = new Error("ENOENT") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; };
  return {
    ...actual,
    readdirSync: (() => ["0", "3"]) as unknown as typeof import("node:fs").readdirSync,
    readlinkSync: ((path: unknown) => state.links.get(String(path)) ?? enoent()) as unknown as typeof import("node:fs").readlinkSync,
    readFileSync: ((path: unknown) => {
      const queue = state.reads.get(String(path));
      if (!queue?.length) enoent();
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    }) as unknown as typeof import("node:fs").readFileSync,
    statSync: ((path: unknown) => {
      const key = String(path);
      if (key === "/proc/4242/fd") { if (!state.alive) enoent(); return { isDirectory: () => true }; }
      const row = state.rows.get(key);
      if (!row) enoent();
      return { dev: row.dev, ino: row.ino, rdev: row.rdev, isSocket: () => row.socket, isFIFO: () => row.pipe,
        isCharacterDevice: () => row.character, isFile: () => row.file, isDirectory: () => row.directory };
    }) as unknown as typeof import("node:fs").statSync,
    fstatSync: (() => enoent()) as unknown as typeof import("node:fs").fstatSync,
    closeSync: (() => {}) as unknown as typeof import("node:fs").closeSync,
    openSync: (() => 3) as unknown as typeof import("node:fs").openSync,
  };
});

const { hostedFdTable } = await import("../app-server/adapters/hosted-fd-table");

function fixture(fdinfo3: readonly string[]) {
  state.alive = true;
  state.links = new Map([["/proc/4242/fd/0", "/dev/null"], ["/proc/4242/fd/3", "/dev/null"]]);
  state.reads = new Map([
    ["/proc/4242/fdinfo/0", ["pos:\t0\nflags:\t02\nmnt_id:\t22\nino:\t1\n"]],
    ["/proc/4242/fdinfo/3", [...fdinfo3]],
  ]);
  state.rows = new Map([
    ["/proc/4242/fd/0", { dev: 6n, ino: 1n, rdev: 259n, socket: false, pipe: false, character: true, file: false, directory: false }],
    ["/proc/4242/fd/3", { dev: 6n, ino: 2n, rdev: 259n, socket: false, pipe: false, character: true, file: false, directory: false }],
  ]);
}

it("drops a row whose fdinfo read hits an empty vanished read instead of failing the whole table", () => {
  fixture([""]);
  const facts = hostedFdTable(4242);
  expect(facts.map(fact => fact.fd)).toEqual([0]);
  expect(facts[0]).toMatchObject({ fd: 0, target: "/dev/null" });
});

it("drops a row that vanishes between the two fdinfo reads", () => {
  fixture(["pos:\t0\nflags:\t02\nmnt_id:\t22\nino:\t2\n", ""]);
  const facts = hostedFdTable(4242);
  expect(facts.map(fact => fact.fd)).toEqual([0]);
});

it("still refuses a non-empty fdinfo without a flags line", () => {
  fixture(["pos:\t0\nmnt_id:\t22\nino:\t2\n"]);
  expect(() => hostedFdTable(4242)).toThrow("hosted_fd_boundary_unresolved");
});

it("still refuses an empty vanished read once the process is gone", () => {
  fixture([""]);
  state.alive = false;
  expect(() => hostedFdTable(4242)).toThrow();
});
