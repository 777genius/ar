import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import type { DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyParentRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { decodeHostedInventoryBytes, hostedInventoryMaximumBytes, parseHostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { parseFlags, option, resolvePath } from "./codex-goal-cli-support";
import { sameRootDescriptorStat as sameStat, readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { readCurrentHostedDependencySignedParentRecipe } from "./hosted-dependency-current-facts";
import { CurrentHostedDependencyOriginKind, readCurrentHostedManagedDependencyProviderParent, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import type { createFixedCodexAgentDriver } from "./file-backend-codex-agent-driver-factory";
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
function selectedFile(path: string, maximum: number, privateFile = true) {
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) invalid();
  const ancestors: { path: string; stat: BigIntStats }[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const stat = lstatSync(p, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) ||
        (privateFile && p === dirname(path) && (stat.mode & 0o077n))) invalid();
    ancestors.push({ path: p, stat }); if (p === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & (privateFile ? 0o077n : 0o022n)) ||
        before.size < 1n || before.size > BigInt(maximum) || !sameStat(before,entry)) invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true})) || !sameStat(before,lstatSync(path,{bigint:true}))) invalid();
    for (const p of ancestors) { const now = lstatSync(p.path,{bigint:true});
      if (!now.isDirectory() || now.dev !== p.stat.dev || now.ino !== p.stat.ino || now.uid !== p.stat.uid || now.mode !== p.stat.mode) invalid(); }
    const data = bytes.subarray(0,length), reference: DependencyProtectedReference = { path,
      identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(data) };
    return { bytes:data, reference };
  } finally { closeSync(fd); }
}
function fixed(name: string, maximum = 65536) { return selectedFile(`${root}/${name}`,maximum); }
// Actual authenticated signed recipe selects the only directory paths; returned facts register no home/use/store.
export function prepareOriginalHostedSessionRuntimeFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  options:Parameters<typeof createFixedCodexAgentDriver>[0]["options"]) {
  const actual = readCurrentHostedManagedDependencyProviderParent(context,fence);
    const bytes = fixed("readonly-inventory.json", hostedInventoryMaximumBytes), decoded = decodeHostedInventoryBytes(bytes.bytes);
    const inventory = decoded && typeof decoded === "object" && "schemaVersion" in decoded && decoded.schemaVersion === 5
      ? parseHostedInventoryV5(decoded) : parseHostedReadonlyHostInventory(decoded);
    const installation = actual.facts.kind === CurrentHostedDependencyOriginKind.Ordinary ? actual.facts.ordinary.installation : actual.facts.installation;
    if (hash(bytes.bytes) !== installation.inventorySha256) invalid();
    const original = readCurrentHostedDependencySignedParentRecipe(actual.facts);
    const launch = readHostedDependencyParentRecipe(original,actual.binding.jobRootDir,actual.binding.workspace.canonicalPath);
    const flags = parseFlags(launch.args.slice(2));
    const signedRoot = option(flags,{},"--state-root",[]) ?? actual.binding.jobRootDir+"/state";
    const model = option(flags,{},"--model",[]);
    if (options.stateRootDir !== resolvePath(launch.cwd,signedRoot) ||
        model !== "gpt-6.1-sol" || options.model !== model || (options.serviceTier ?? "default") !== "default" ||
        (option(flags,{},"--service-tier",[]) ?? "default") !== "default" || options.codexBinaryPath !== "codex" ||
        (option(flags,{},"--codex-binary",[]) ?? "codex") !== "codex") throw new Error("hosted_dependency_session_profile_unsupported");
    const job = readHostedDependencyRootDirectoryPin(actual.binding.jobRootDir);
    const pins = [options.stateRootDir,options.stateRootDir+"/sessions"].map(path => {
      try { mkdirSync(path,{mode:0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const pin = readHostedDependencyRootDirectoryPin(path), stat = lstatSync(path);
      if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700 || pin.dev !== job.dev || pin.mountId !== job.mountId) invalid(); return pin;
    });
  readCurrentHostedManagedDependencyProviderParent(context,fence);
  return {root:options.stateRootDir,model,stateRoot:pins[0]!,sessionRoot:pins[1]!};
}
