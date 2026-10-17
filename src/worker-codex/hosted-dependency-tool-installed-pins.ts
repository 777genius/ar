/** Physical entry availability for the one fixed Vite/Vitest profile.
 * This supplements metadata pins, not a tool execution or hot byte proof. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "../core/dependency-environment/dependency-owner";
import { dependencyToolPins, type DependencyToolProfile } from "../core/dependency-environment/dependency-tool-profile";

// Exact supported registry distributions, sourced from the reviewed root lock.
// This is additional qualification, never a substitute for the full byte proof.
const toolDistributionIntegrity = Object.freeze({
  vite: "sha512-h9bXPmJichP5fLmVQo3PyaGSDE2n3aPuomeAlVRm0JLmt4rY6zmPKd59HYI4LNW8oTK7tlTsuC7l/m7awx9Jcw==",
  vitest: "sha512-flY6ScbCIt9HThs+C5HS7jvGOB560DJtk/Z15IQROTA6zEy49Nh8T/dofWTQL+n3vswqn87sbJNiuqw1SDp5Ig==",
});

export function assertHostedDependencyToolInstalledPins(workspace: string, profile: DependencyToolProfile, lockBytes: Uint8Array): void {
  const lock: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || !("packages" in lock) ||
      !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) fail();
  const packages = lock.packages as Record<string, unknown>;
  for (const [name, version] of Object.entries(dependencyToolPins)) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("version" in entry) || entry.version !== version ||
        !("resolved" in entry) || entry.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` ||
        !("integrity" in entry) || entry.integrity !== toolDistributionIntegrity[name as keyof typeof toolDistributionIntegrity]) fail();
    const path = join(workspace, "node_modules", name, "package.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || realpathSync(path) !== path) fail();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !("name" in value) || value.name !== name || !("version" in value) || value.version !== version) fail();
    // Package-scope export metadata is reread physically. A prior resolver's
    // package cache must not conceal a changed entry selector in a warm tree.
    if (!("exports" in value) || !value.exports || typeof value.exports !== "object" || Array.isArray(value.exports)) fail();
    if (name === "vite") {
      if (!("." in value.exports) || value.exports["."] !== "./dist/node/index.js") fail();
    } else {
      if (!("./node" in value.exports) || !value.exports["./node"] ||
          typeof value.exports["./node"] !== "object" || Array.isArray(value.exports["./node"])) fail();
      const nodeExport = value.exports["./node"];
      if (Object.keys(nodeExport).sort().join(",") !== "default,types" ||
          !("default" in nodeExport) || nodeExport.default !== "./dist/node.js") fail();
    }
  }
  for (const dependency of profile.optimizerDependencies) {
    const path = join(workspace, "node_modules", dependency);
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) fail();
  }
  assertRequiredEntries(workspace);
}

const requiredEntries = [
  { selector: "vite", relative: "vite/dist/node/index.js" },
  { selector: "vitest/node", relative: "vitest/dist/node.js" },
] as const;
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function assertRequiredEntries(workspace: string): void {
  const tree = join(workspace, "node_modules");
  const held: { fd: number; path: string; stamp: string }[] = [];
  const retain = (path: string, directory: boolean, parent?: number, name?: string): number => {
    const fd = openSync(parent === undefined ? path : `/proc/self/fd/${parent}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
    try {
      const stat = fstatSync(fd, { bigint: true });
      if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n || stat.size <= 0n) ||
          realpathSync(path) !== path) fail();
      held.push({ fd, path, stamp: stamp(stat) });
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  };
  try {
    const root = retain(tree, true), resolve = createRequire(join(tree, "__n3_tool_resolver__.cjs"));
    for (const entry of requiredEntries) {
      // Same two selectors as the config-free child, without import/execute.
      const path = join(tree, entry.relative);
      if (realpathSync(resolve.resolve(entry.selector)) !== path) fail();
      let parent = root, current = tree;
      const components = entry.relative.split("/");
      for (let index = 0; index < components.length; index++) {
        const name = components[index]!;
        current = join(current, name);
        parent = retain(current, index < components.length - 1, parent, name);
      }
    }
    for (const entry of held) {
      const named = lstatSync(entry.path, { bigint: true });
      if (named.isSymbolicLink() || stamp(named) !== entry.stamp ||
          stamp(fstatSync(entry.fd, { bigint: true })) !== entry.stamp || realpathSync(entry.path) !== entry.path) fail();
    }
  } catch { fail(); }
  finally { for (const entry of held.reverse()) closeSync(entry.fd); }
}
function fail(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
