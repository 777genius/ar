import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedDependencyPrivateScratch, managedDependencyPrivateIndexEnvironment, readManagedDependencyPrivateIndex } from "../hosted-dependency-private-scratch";
import type { HostedDependencyRootPurposeContext } from "../hosted-dependency-root-purpose";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// No successful B purpose/issuer is mocked or minted. This reaches the actual
// old env issuer, which accepted forged paths without any genuine provenance.
// Red if a prototype/constructor override can mint a live-index environment or
// any attacker method/getter runs before refusal. Native Git submission remains
// a separate genuine-context acceptance gate.
describe("private scratch environment provenance", () => {
  it.each(["prototype", "subclass", "constructor-override", "getter"])("refuses %s before redirecting the live TEST index", kind => {
    const root = mkdtempSync(join(tmpdir(), "subscription-runtime-TEST-scratch-provenance-")); roots.push(root);
    const git = join(root, ".git"), objects = join(git, "objects");
    mkdirSync(git, { mode: 0o700 }); mkdirSync(objects, { mode: 0o700 });
    const index = join(git, "index"), object = join(objects, "TEST-sentinel");
    const indexBytes = Buffer.from("TEST-live-index-must-survive"), objectBytes = Buffer.from("TEST-live-object-must-survive");
    writeFileSync(index, indexBytes, { mode: 0o600 }); writeFileSync(object, objectBytes, { mode: 0o600 });
    const before = lstatSync(index, { bigint: true }), context = Object.freeze({}) as HostedDependencyRootPurposeContext;
    const redirected = vi.fn(() => ({ temporaryDirectory: git, indexPath: index, objectDirectory: objects }));
    const noDrain = vi.fn(), accessor = vi.fn(() => redirected);
    let snapshot: HostedDependencyPrivateScratch;
    if (kind === "constructor-override") {
      // TypeScript private constructors are runtime-callable. Only completed
      // actual prepare may register provenance, never constructor invocation.
      snapshot = Reflect.construct(HostedDependencyPrivateScratch, [context, {}, {}]) as HostedDependencyPrivateScratch;
    } else if (kind === "subclass") {
      const RuntimeScratch = HostedDependencyPrivateScratch as unknown as new (...args: unknown[]) => HostedDependencyPrivateScratch;
      class Counterfeit extends RuntimeScratch { override paths() { return redirected(); } }
      snapshot = Object.create(Counterfeit.prototype) as HostedDependencyPrivateScratch;
    } else snapshot = Object.create(HostedDependencyPrivateScratch.prototype) as HostedDependencyPrivateScratch;
    const overrides: PropertyDescriptorMap = { pathsWithHeldFence: { value: redirected },
      observeChild: { value: noDrain }, settleChild: { value: noDrain } };
    if (kind !== "subclass") overrides.paths = kind === "getter" ? { get: accessor } : { value: redirected };
    Object.defineProperties(snapshot, overrides);
    expect(snapshot instanceof HostedDependencyPrivateScratch).toBe(true);
    expect(() => managedDependencyPrivateIndexEnvironment(context, snapshot)).toThrow("dependency_private_scratch_held");
    expect(() => readManagedDependencyPrivateIndex(context, Object.freeze({ GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects })))
      .toThrow("dependency_private_scratch_held");
    expect(redirected).not.toHaveBeenCalled(); expect(accessor).not.toHaveBeenCalled(); expect(noDrain).not.toHaveBeenCalled();
    const after = lstatSync(index, { bigint: true });
    expect([after.dev, after.ino, after.size, after.ctimeNs, after.mtimeNs]).toEqual([before.dev, before.ino, before.size, before.ctimeNs, before.mtimeNs]);
    expect(readFileSync(index)).toEqual(indexBytes); expect(readFileSync(object)).toEqual(objectBytes);
    expect(readdirSync(git).sort()).toEqual(["index", "objects"]); expect(readdirSync(objects)).toEqual(["TEST-sentinel"]);
  });
});
