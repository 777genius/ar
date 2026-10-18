import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { resolveSelectedInstallationRecord } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedSelectedFileName, hostedSelectedRecordNames, hostedSelectionRecordName } from "../../core/host-infrastructure/host-installation-successor";
import { readHostedInstallationActivation } from "../hosted-installation-activation";

// DIRECT tests of the selected-installation reader (a10 F4) and of its single-snapshot read (a10 F5).
//
// Binding vs context. BINDING: every refusal below fails when the corresponding check in `resolveSelectedInstallationRecord`
// (record digest, selected-file digest, no fallback) or the snapshot/settle pair in `readHostedInstallationActivation` is
// removed - run the three-part mutation (assert the edit applied, observe the named test fail, restore). CONTEXT: the in-memory
// matrix proves the DECISION of the resolver over injected bytes; the real-fs block proves the same reader through the real
// private-file reader and the real activation reader. The surface (record names) is DERIVED from the core producers
// (`hostedSelectionRecordName`, `hostedSelectedFileName`, `hostedSelectedRecordNames`), never copied by hand.
//
// Like `hosted-ordinary-activation.test.ts`, only the private root, root ownership and kernel namespace facts are substituted
// over a disposable directory; no authority is injected. Nothing here qualifies an installed host.
const fixture = vi.hoisted(() => ({ root: "", activationOpens: 0, swapAtOpen: 0, swap: null as (() => void) | null }));
const prefix = "/var/lib/subscription-runtime-host-policy";
function mapped(path: string): string {
  if (["/", "/var", "/var/lib", prefix].includes(path)) return fixture.root;
  if (path.startsWith(prefix + "/")) return join(fixture.root, path.slice(prefix.length + 1));
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) => path === "/proc/self/uid_map" ? "0 0 4294967295\n" : real.readFileSync(mapped(path), options),
    readlinkSync: (path: string) => path.startsWith("/proc/self/ns/") || path.startsWith("/proc/1/ns/") ? "host" : real.readlinkSync(mapped(path)),
    lstatSync: (path: string) => Object.assign(real.lstatSync(mapped(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(real.fstatSync(fd), { uid: 0 }),
    openSync: (path: string, flags: number, mode: number) => {
      // A publication that lands while a reader is mid-flight: the Nth open of the activation record sees the NEXT generation.
      if (String(path).endsWith("/host-activation.json") && ++fixture.activationOpens === fixture.swapAtOpen && fixture.swap) {
        const swap = fixture.swap; fixture.swap = null; swap();
      }
      return real.openSync(mapped(path), flags, mode);
    },
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(mapped(path), options),
    rmdirSync: (path: string) => real.rmdirSync(mapped(path)),
  };
});

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const HOST = "host-1", INSTALLATION = "install-1", invalid = "hosted_activation_evidence_invalid";
const installationOf = (tag: string) => ({ schemaVersion: 1, installationId: INSTALLATION, hostId: HOST, runtimeDirectory: "/opt/runtime",
  runtimeSha: tag.repeat(40), runtimeManifestSha256: tag.repeat(64), inventorySha256: tag.repeat(64) });
const activationOf = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, installationId: INSTALLATION, hostId: HOST, bootId: "boot-1",
  supervisorId: "supervisor-1", generation: 2, phase: "CLOSED", ordinaryOriginsSha256: "a".repeat(64), exclusiveEnrollmentSha256: null, ordinaryStarts: [], ...over });
const selectionOf = (generation: number, installationSha256: string, inventorySha256: string) => ({ schemaVersion: 1, installationId: INSTALLATION, generation,
  operationId: "22222222-2222-2222-2222-222222222222", bootId: "11111111-1111-1111-1111-111111111111", supervisorBirth: "300:400",
  predecessor: { selectionSha256: null, installationSha256: "d".repeat(64), inventorySha256: "e".repeat(64), activationSha256: "f".repeat(64), activationGeneration: 1 },
  installationSha256, inventorySha256 });

/** One selectable world: every record the selected reader may touch, keyed by the relative names the producers define. */
function world(tag: string, generation: number) {
  const installation = encoded(installationOf(tag)), inventory = Buffer.from(`inventory-${tag}\n`);
  const record = encoded(selectionOf(generation, sha(installation), sha(inventory))), digest = sha(record);
  const files = new Map<string, Buffer>([
    [hostedSelectionRecordName(digest), record],
    [hostedSelectedFileName(digest, "host-installation.json"), installation],
    [hostedSelectedFileName(digest, "readonly-inventory.json"), inventory],
  ]);
  return { digest, installation, inventory, record, files, activation: encoded(activationOf({ generation: generation + 1, installationSelectionSha256: digest })) };
}
const fixedInstallation = encoded(installationOf("0")), fixedInventory = Buffer.from("inventory-fixed\n");
const fixedOf = (name: string) => name === "host-installation.json" ? fixedInstallation : fixedInventory;

describe("resolveSelectedInstallationRecord: the direct reader refuses and never falls back to older files", () => {
  const reader = (files: Map<string, Buffer>, activation: Buffer | null) => (name: string) => name === "host-activation.json" ? activation : files.get(name) ?? null;
  const withFixed = (w: ReturnType<typeof world>): Map<string, Buffer> => {
    const files = new Map(w.files);
    files.set("host-installation.json", fixedInstallation); files.set("readonly-inventory.json", fixedInventory);
    return files;
  };

  it.each(hostedSelectedRecordNames)("%s: an unselecting activation resolves the original fixed record, a selecting one ONLY the digest-named copy", name => {
    const w = world("1", 1);
    expect(resolveSelectedInstallationRecord(name, reader(withFixed(w), encoded(activationOf())))).toEqual({ path: name, bytes: fixedOf(name) });
    const selected = resolveSelectedInstallationRecord(name, reader(withFixed(w), w.activation));
    expect(selected.path).toBe(hostedSelectedFileName(w.digest, name));
    expect(selected.bytes!.equals(name === "host-installation.json" ? w.installation : w.inventory)).toBe(true);
  });

  type Breaker = (w: ReturnType<typeof world>, name: typeof hostedSelectedRecordNames[number]) => { files: Map<string, Buffer>; activation: Buffer | null };
  const breakers: [string, Breaker][] = [
    ["a selection record that is missing", (w) => { const files = withFixed(w); files.delete(hostedSelectionRecordName(w.digest)); return { files, activation: w.activation }; }],
    ["a selection record whose bytes do not hash to the digest that names it", (w) => {
      const files = withFixed(w); files.set(hostedSelectionRecordName(w.digest), Buffer.concat([w.record, Buffer.from(" ")])); return { files, activation: w.activation }; }],
    ["a selected file that is missing (the fixed record must NOT be returned instead)", (w, name) => {
      const files = withFixed(w); files.delete(hostedSelectedFileName(w.digest, name)); return { files, activation: w.activation }; }],
    ["a selected file whose bytes changed", (w, name) => {
      const files = withFixed(w); files.set(hostedSelectedFileName(w.digest, name), Buffer.from("tampered\n")); return { files, activation: w.activation }; }],
    ["a mixed record: the selection names the digests of ANOTHER generation's files", (w, name) => {
      const other = world("2", 5), files = withFixed(w);
      // A well-formed, self-consistent record (its own digest names it) that pins a different world's bytes for the selected files.
      const mixed = encoded(selectionOf(1, sha(other.installation), sha(other.inventory))), digest = sha(mixed);
      files.set(hostedSelectionRecordName(digest), mixed);
      files.set(hostedSelectedFileName(digest, name), name === "host-installation.json" ? w.installation : w.inventory);
      return { files, activation: encoded(activationOf({ installationSelectionSha256: digest })) }; }],
    ["a selection reference that is not a digest", (w) => ({ files: withFixed(w), activation: encoded(activationOf({ installationSelectionSha256: "not-a-digest" })) })],
    ["a selection reference that is null", (w) => ({ files: withFixed(w), activation: encoded(activationOf({ installationSelectionSha256: null })) })],
    ["a selection reference that is not a string", (w) => ({ files: withFixed(w), activation: encoded(activationOf({ installationSelectionSha256: 7 })) })],
  ];
  const cases = breakers.flatMap(([title, breaker]) => hostedSelectedRecordNames.map(name => [title, name, breaker] as const));
  it.each(cases)("%s (%s)", (_title, name, breaker) => {
    const w = world("1", 1), broken = breaker(w, name);
    expect(() => resolveSelectedInstallationRecord(name, reader(broken.files, broken.activation))).toThrow(invalid);
  });

  it("resolves from the bytes it is GIVEN for the activation: a later reference on disk cannot change the answer", () => {
    const a = world("1", 1), b = world("2", 2), files = new Map([...a.files, ...b.files]);
    const read = (name: string) => name === "host-activation.json" ? b.activation : files.get(name) ?? null; // disk already moved on to B
    expect(resolveSelectedInstallationRecord("host-installation.json", name => name === "host-activation.json" ? a.activation : read(name)).bytes!.equals(a.installation)).toBe(true);
    expect(resolveSelectedInstallationRecord("host-installation.json", read).bytes!.equals(b.installation)).toBe(true);
  });
});

describe("the selected reader over the real private-file reader and ONE activation snapshot", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  function put(name: string, bytes: Buffer): void { writeFileSync(join(fixture.root, name), bytes, { mode: 0o600 }); }
  function seed(w: ReturnType<typeof world>): void {
    mkdirSync(join(fixture.root, "installation-successors", w.digest), { recursive: true, mode: 0o700 });
    for (const [name, bytes] of w.files) put(name, bytes);
  }
  beforeEach(() => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    fixture.root = mkdtempSync(join(tmpdir(), "hosted-selected-reader-"));
    fixture.activationOpens = 0; fixture.swapAtOpen = 0; fixture.swap = null;
    put("host-installation.json", fixedInstallation);
  });
  afterEach(() => { Object.defineProperty(process, "platform", platform); rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("every record name the core producers emit is accepted by the Host reader's own name check (no layout drift between the two definitions)", () => {
    const digest = "a".repeat(64);
    mkdirSync(join(fixture.root, "installation-successors", digest), { recursive: true, mode: 0o700 }); // the reader requires the ancestry, a missing FILE is just null
    const produced = [hostedSelectionRecordName(digest), ...hostedSelectedRecordNames.map(name => hostedSelectedFileName(digest, name))];
    for (const name of produced) expect(() => readHostedActivationBytes(name), name).not.toThrow();
    expect(() => readHostedActivationBytes(`installation-successors/${digest}/other.json`)).toThrow(invalid);
  });

  it("returns the installation of the SELECTED world together with the activation that selected it", () => {
    const w = seed1();
    const read = readHostedInstallationActivation();
    expect(read.activation.installationSelectionSha256).toBe(w.digest);
    expect(read.installation.runtimeSha).toBe("1".repeat(40));
    expect(readHostedActivationBytes("host-installation.json")!.equals(w.installation)).toBe(true);
  });

  it("a host that never selected anything still reads the original fixed installation", () => {
    put("host-activation.json", encoded(activationOf()));
    expect(readHostedInstallationActivation().installation.runtimeSha).toBe("0".repeat(40));
  });

  it("a selected copy that changed on disk refuses (the reader never answers with the predecessor)", () => {
    const w = seed1();
    put(hostedSelectedFileName(w.digest, "host-installation.json"), Buffer.from("tampered\n"));
    expect(() => readHostedInstallationActivation()).toThrow(invalid);
    expect(() => readHostedActivationBytes("host-installation.json")).toThrow(invalid);
  });

  // BINDING (a10 F5). Before: the installation was resolved from one read of the activation and the activation itself came from a
  // SECOND read, so a publication in between returned world A's installation with generation B's activation. Mutation: delete the
  // `settled` comparison at the end of `readHostedInstallationActivation` (assert the edit applied) and this test stops refusing.
  it("a publication that lands while the reader is mid-flight is refused, never merged into one mixed answer", () => {
    const a = seed1(), b = world("2", 2);
    seed(b);
    fixture.activationOpens = 0; fixture.swapAtOpen = 2; // the second open of the activation record sees generation B
    fixture.swap = () => put("host-activation.json", b.activation);
    expect(() => readHostedInstallationActivation()).toThrow(invalid);
    expect(fixture.swap).toBeNull(); // the publication really happened inside the read: the refusal above is not vacuous
    // Retried after the publication settled, the reader answers consistently with the NEW world.
    const settled = readHostedInstallationActivation();
    expect(settled.activation.installationSelectionSha256).toBe(b.digest);
    expect(settled.installation.runtimeSha).toBe("2".repeat(40));
    expect(a.digest).not.toBe(b.digest);
  });

  function seed1() {
    const w = world("1", 1);
    seed(w); put("host-activation.json", w.activation);
    fixture.activationOpens = 0;
    return w;
  }
});
