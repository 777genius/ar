import { describe, expect, it } from "vitest";
import { qualifyHostedDependencyInstallerInputs } from "../hosted-dependency-installer-inputs";

const packageJson = { name: "TEST-contained-installer", version: "1.0.0", dependencies: { tiny: "1.0.0" } };
const lock = () => ({ name: packageJson.name, version: "1.0.0", lockfileVersion: 3,
  packages: { "": packageJson, "node_modules/tiny": { version: "1.0.0",
    resolved: "https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") } } });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("contained installer input closure", () => {
  // Regression: caller-buffer mutation changes captured bytes after admission.
  it("retains detached exact bytes and keys every input byte", () => {
    const pkg = bytes(packageJson), original = Buffer.from(pkg), locked = bytes(lock());
    const qualified = qualifyHostedDependencyInstallerInputs(pkg, locked);
    pkg.fill(0); locked.fill(0);
    expect(qualified.packageBytes).toEqual(original);
    expect(JSON.parse(qualified.lockBytes.toString()).lockfileVersion).toBe(3);
    const changed = qualifyHostedDependencyInstallerInputs(Buffer.concat([original, Buffer.from("\n")]), bytes(lock()));
    expect(changed.sha256).not.toBe(qualified.sha256);
  });

  // Regression: npm receives a source/local/network input outside fixed registry.
  it.each(["file:../sentinel", "https://evil.invalid/pkg.tgz", "https://registry.npmjs.org@evil.invalid/tiny.tgz",
    "https://user:secret@registry.npmjs.org/tiny.tgz", "https://registry.npmjs.org/tiny.tgz?token=secret",
    "git+https://registry.npmjs.org/tiny.git"]) ("rejects nonclosed resolved input %s", resolved => {
    const candidate = lock(); candidate.packages["node_modules/tiny"].resolved = resolved;
    expect(() => qualifyHostedDependencyInstallerInputs(bytes(packageJson), bytes(candidate))).toThrow("inputs_unsupported");
  });
  it.each([{ scripts: { postinstall: "write-source" } }, { workspaces: ["../outside"] },
    { overrides: { tiny: "file:../outside" } }, { dependencies: { tiny: "file:../outside" } }])("rejects source-dependent package policy %j", policy => {
    expect(() => qualifyHostedDependencyInstallerInputs(bytes({ ...packageJson, ...policy }), bytes(lock()))).toThrow("inputs_unsupported");
  });
  it.each(["node_modules/../outside", "../outside", "node_modules/x/../../outside"]) ("rejects escaping package membership %s", path => {
    const candidate = lock(), row = candidate.packages["node_modules/tiny"];
    const packages = { "": packageJson, [path]: row };
    expect(() => qualifyHostedDependencyInstallerInputs(bytes(packageJson), bytes({ ...candidate, packages }))).toThrow("inputs_unsupported");
  });
  it.each([{ link: true }, { hasInstallScript: true }, { integrity: undefined }])("rejects undeclared installer effects %j", effect => {
    const candidate = lock(); Object.assign(candidate.packages["node_modules/tiny"], effect);
    expect(() => qualifyHostedDependencyInstallerInputs(bytes(packageJson), bytes(candidate))).toThrow("inputs_unsupported");
  });
});
