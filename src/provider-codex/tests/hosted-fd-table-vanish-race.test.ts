import { expect, it, vi } from "vitest";

// Deterministic model of the kernel fdinfo race: seq_show prints nothing when
// the descriptor is no longer held at read time, so the read succeeds with an
// empty body instead of ENOENT.
const state = vi.hoisted(() => ({
  links: new Map<number, string>(),
  reads: new Map<number, string[]>(),
  rows: new Map<number, Readonly<{ dev: bigint; ino: bigint; rdev: bigint; socket: boolean; pipe: boolean;
    character: boolean; file: boolean; directory: boolean }>>(),
  alive: true,
  selfProbe: new Map<number, "held" | "EBADF" | "EIO">(),
  directoryError: undefined as string | undefined,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string): never => { const error = new Error(code) as NodeJS.ErrnoException; error.code = code; throw error; };
  const fdOf = (path: unknown) => Number(String(path).split("/").pop());
  const rowStat = (row: NonNullable<ReturnType<typeof state.rows.get>>) => ({ dev: row.dev, ino: row.ino, rdev: row.rdev,
    isSocket: () => row.socket, isFIFO: () => row.pipe, isCharacterDevice: () => row.character,
    isFile: () => row.file, isDirectory: () => row.directory });
  return {
    ...actual,
    readdirSync: (() => ["0", "3"]) as unknown as typeof import("node:fs").readdirSync,
    readlinkSync: ((path: unknown) => state.links.get(fdOf(path)) ?? fail("ENOENT")) as unknown as typeof import("node:fs").readlinkSync,
    readFileSync: ((path: unknown) => {
      const queue = state.reads.get(fdOf(path));
      if (!queue || !queue.length) return fail("ENOENT");
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    }) as unknown as typeof import("node:fs").readFileSync,
    statSync: ((path: unknown) => {
      if (String(path).endsWith("/fd")) {
        if (state.directoryError) fail(state.directoryError);
        if (!state.alive) fail("ENOENT");
        return { isDirectory: () => true };
      }
      const row = state.rows.get(fdOf(path));
      return row ? rowStat(row) : fail("ENOENT");
    }) as unknown as typeof import("node:fs").statSync,
    fstatSync: ((fd: unknown) => {
      const probe = state.selfProbe.get(Number(fd)) ?? "held";
      if (probe !== "held") fail(probe);
      const row = state.rows.get(Number(fd));
      return row ? rowStat(row) : fail("EBADF");
    }) as unknown as typeof import("node:fs").fstatSync,
    closeSync: (() => {}) as unknown as typeof import("node:fs").closeSync,
    openSync: (() => 3) as unknown as typeof import("node:fs").openSync,
  };
});

const { hostedFdTable } = await import("../app-server/adapters/hosted-fd-table");

function fixture(fdinfo3: readonly string[]) {
  state.alive = true;
  state.directoryError = undefined;
  state.selfProbe = new Map();
  state.links = new Map([[0, "/dev/null"], [3, "/dev/null"]]);
  state.reads = new Map([
    [0, ["pos:\t0\nflags:\t02\nmnt_id:\t22\nino:\t1\n"]],
    [3, [...fdinfo3]],
  ]);
  state.rows = new Map([
    [0, { dev: 6n, ino: 1n, rdev: 259n, socket: false, pipe: false, character: true, file: false, directory: false }],
    [3, { dev: 6n, ino: 2n, rdev: 259n, socket: false, pipe: false, character: true, file: false, directory: false }],
  ]);
}

it("propagates an unexpected self-probe error instead of masking it as a boundary failure", () => {
  fixture([""]);
  state.selfProbe = new Map([[3, "EIO"]]);
  expect(() => hostedFdTable(process.pid)).toThrow("EIO");
});

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

it("drops an empty vanished self row only while the fd number stays closed", () => {
  fixture([""]);
  state.selfProbe = new Map([[3, "EBADF"]]);
  const facts = hostedFdTable(process.pid);
  expect(facts.map(fact => fact.fd)).toEqual([0]);
});

it("refuses an empty vanished self row whose fd number was reused", () => {
  fixture([""]);
  state.selfProbe = new Map([[3, "held"]]);
  expect(() => hostedFdTable(process.pid)).toThrow("hosted_fd_boundary_unresolved");
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

it("propagates unexpected directory stat errors instead of masking them", () => {
  fixture([""]);
  state.directoryError = "EACCES";
  expect(() => hostedFdTable(4242)).toThrow(/EACCES/);
});
