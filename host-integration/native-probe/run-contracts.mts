import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile, rm, chmod, realpath, lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkInputs, type CheckedInput } from "./check-inputs.mts";
import { createHash, randomUUID } from "node:crypto";

const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const compiler = join(workspace, "node_modules/typescript/bin/tsc");
const config = join(workspace, "host-integration/native-probe/tsconfig.json");
const codecConfig = join(workspace, "tsconfig.host-inventory-codec.json");
const evidence = resolve(process.env.SR_NATIVE_PROBE_EVIDENCE ?? join(workspace, "delivery/a0-native-probe"));
await mkdir(evidence, { recursive: true });
const attempt = randomUUID();
const log: Array<{ command: readonly string[]; pid: number | null; exit: number | null; signal: string | null; error: string | null; naturalClose: boolean; output: string; stdout: string; stderr: string; stdoutSha256: string; stderrSha256: string; stdoutPath: string; stderrPath: string }> = [];
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
async function run(command: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}, display = true, cwd = workspace): Promise<string> {
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", ...extra } });
  let output = "", error: string | null = null;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); output += chunk.toString(); if (display) process.stdout.write(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); output += chunk.toString(); if (display) process.stderr.write(chunk); });
  const result = await new Promise<{ code: number | null; signal: string | null }>(accept => {
    child.once("error", failure => { error = failure.message; });
    child.once("close", (code, signal) => accept({ code, signal }));
  });
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  const stdoutPath = join(evidence, `${attempt}-check-${log.length}.stdout`), stderrPath = join(evidence, `${attempt}-check-${log.length}.stderr`);
  await writeFile(stdoutPath, out, { flag: "wx" }); await writeFile(stderrPath, err, { flag: "wx" });
  log.push({ command: [command, ...args], pid: child.pid ?? null, exit: result.code, signal: result.signal, error, naturalClose: true, output, stdout: out.toString(), stderr: err.toString(), stdoutSha256: sha256(out), stderrSha256: sha256(err), stdoutPath, stderrPath });
  if (result.code !== 0 || result.signal !== null || error !== null) throw new Error(`source check failed: ${command} (${result.code}/${result.signal}/${error})`);
  return output;
}
const temporary = await mkdtemp(join(process.env.SR_NATIVE_PROBE_TMP ?? tmpdir(), "sr-native-probe-contract-"));
const originalTemporary = await lstat(temporary, { bigint: true });
const ownerAttempts = join(temporary, "original-owner-attempts");
await mkdir(ownerAttempts, { mode: 0o700 });
interface Artifact { readonly path: string; readonly kind: "file" | "directory" | "symlink" | "other"; readonly bytes: string; readonly mode: string; readonly uid: string; readonly device: string; readonly inode: string; readonly sha256: string | null; readonly target: string | null }
async function inventory(path: string, rows: Artifact[] = []): Promise<readonly Artifact[]> {
  const s = await lstat(path, { bigint: true });
  const kind = s.isFile() ? "file" : s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "other";
  rows.push({ path, kind, bytes: s.size.toString(), mode: (s.mode & 0o7777n).toString(8), uid: s.uid.toString(), device: s.dev.toString(), inode: s.ino.toString(), sha256: kind === "file" ? sha256(await readFile(path)) : null, target: kind === "symlink" ? await readlink(path) : null });
  if (kind === "directory") for (const entry of (await readdir(path)).sort()) await inventory(join(path, entry), rows);
  return rows;
}
async function ownerJoined(): Promise<boolean> {
  const names = await readdir(ownerAttempts);
  const results = names.filter(name => name.endsWith("-result.json"));
  if (results.length !== 1 || names.filter(name => name.endsWith("-started.json")).length !== 1) return false;
  const value: unknown = JSON.parse(await readFile(join(ownerAttempts, results[0]!), "utf8"));
  return !!value && typeof value === "object" && "kind" in value && value.kind === "original-owner-seal" && "naturalClose" in value && value.naturalClose === true && "joined" in value && value.joined === true && "code" in value && value.code === 0 && "signal" in value && value.signal === null;
}
let inputs: readonly CheckedInput[] = [], inputsStable = false, passed = false;
let ownerFixture = false, originalOwnerJoined = false, originalOwnerSettled = false;
try {
  const graph = (await run(process.execPath, [compiler, "--listFilesOnly", "-p", config], {}, false)).trim() + "\n" +
    (await run(process.execPath, [compiler, "--listFilesOnly", "-p", codecConfig], {}, false)).trim();
  inputs = await checkInputs(workspace, graph);
  await run(process.execPath, [compiler, "--noEmit", "--skipLibCheck", "false", "-p", config]);
  const build = join(temporary, "dist"), client = join(temporary, "contract-client");
  await run(process.execPath, [compiler, "-p", config, "--skipLibCheck", "false", "--noEmit", "false", "--outDir", build]);
  await writeFile(join(build, "package.json"), '{"type":"module"}\n');
  await run(process.execPath, [join(workspace, "scripts/rewrite-dist-esm-imports.mjs"), "--imports-only"], {}, true, temporary);
  const native = join(workspace, "host-integration/native-probe/native");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-pthread", ...["clock.c", "channel.c", "helper-profile.c", "publication.c", "resources.c", "stock-manager.c", "contract-client.c"].map(file => join(native, file)), "-Wl,-l:libsystemd.so.0", "-o", client]);
  const dataCodec = join(temporary, "native-root-codec-test");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", join(native, "native-root-control.c"), join(native, "native-root-codec-test.c"), "-o", dataCodec]);
  const dataClient = join(temporary, "native-root-client");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", join(native, "clock.c"), join(native, "publication.c"), join(native, "native-root-control.c"), join(native, "native-root-client.c"), "-o", dataClient]);
  const ipcDirectory = join(temporary, "data-ipc"); await mkdir(ipcDirectory, { mode: 0o700 });
  const ipcClient = join(temporary, "native-root-disposable-client"), ipcFixture = join(temporary, "native-root-ipc-test");
  const ipcPins = [`-DNP_ROOT_DIRECTORY=${JSON.stringify(ipcDirectory)}`, `-DNP_ROOT_SOCKET=${JSON.stringify(join(ipcDirectory, "control.sock"))}`];
  const ipcSources = ["clock.c", "publication.c", "native-root-control.c"].map(name => join(native, name));
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", ...ipcPins, ...ipcSources, join(native, "native-root-client.c"), "-o", ipcClient]);
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", ...ipcPins, `-DNP_ROOT_TEST_CLIENT=${JSON.stringify(ipcClient)}`, ...ipcSources, join(native, "native-root-ipc-test.c"), "-o", ipcFixture]);
  const rawDirectory = join(build, "host-integration/host-jobs");
  await mkdir(rawDirectory, { recursive: true });
  for (const name of ["read-request.mjs", "endpoint.mjs", "manager.mjs", "contract.mjs", "storage-policy.mjs"]) await copyFile(join(workspace, "host-integration/host-jobs", name), join(rawDirectory, name));
  const managedDirectory = join(build, "host-integration/managed-launcher"); await mkdir(managedDirectory, { recursive: true });
  for (const name of ["launch.mjs", "profiles.mjs", "payload-guard.mjs"]) await copyFile(join(workspace, "host-integration/managed-launcher", name), join(managedDirectory, name));
  // The staged launcher receives the policy emitted by this same checked source
  // graph, without depending on the workspace's independently built dist.
  await writeFile(join(managedDirectory, "hosted-host-policy.mjs"),
    "// Generated from src/provider-codex/app-server/adapters/hosted-host-policy.ts.\n" +
    (await readFile(join(build, "src/provider-codex/app-server/adapters/hosted-host-policy.js"), "utf8"))
      .replace(/^\/\/# sourceMappingURL=.*$/m, ""));
  for (const name of ["hosted-native-probe/ingress.js", "hosted-native-probe/protocol.js", "hosted-native-probe/original-owner-client.js", "hosted-native-probe/original-owner-adapter.js", "worker-core/hosted-custody/ports/native-probe.js", "worker-core/hosted-custody/application/native-probe.js", "worker-core/hosted-custody/domain/native-probe.js", "core/scoped-retained-resource-contract.js", "core/scoped-termination-contract.js"]) {
    const destination = join(rawDirectory, "native-probe", name); await mkdir(resolve(destination, ".."), { recursive: true }); await copyFile(join(build, "src", name), destination);
  }
  // This separate emitted TEST closure binds the actual C client to our
  // disposable socket. The production client constant/source stays fixed.
  const endpointClient = join(rawDirectory, "native-probe/hosted-native-probe/original-owner-client.js");
  const emittedClient = await readFile(endpointClient,"utf8");
  const fixedClient = '"/opt/subscription-runtime/native-probe/native-root-client"';
  if(!emittedClient.includes(fixedClient))throw new Error("missing fixed emitted DATA client");
  await writeFile(endpointClient,emittedClient.replace(fixedClient,JSON.stringify(ipcClient)));
  await run(process.execPath, ["--test", join(build, "host-integration/native-probe/ingress-client-contracts.test.mjs")], { NP_DATA_CLIENT: dataClient, NP_DATA_CODEC: dataCodec, NP_DATA_IPC: ipcFixture });
  const addon = join(temporary, "node-contract.node");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-pthread", "-shared", "-fPIC", join(native, "helper-profile.c"), join(native, "node-contract-addon.c"), "-o", addon]);
  await run(process.execPath, ["--test", join(build, "host-integration/native-probe/contracts.test.mjs")], { NP_CLIENT: client, NP_FIXTURES: temporary, NP_NODE_SCRIPT: join(build, "host-integration/native-probe/node-contract.mjs"), NP_NODE_ADDON: addon });
  const owner = join(temporary, "original-owner"), ownerAddon = join(temporary, "original-owner.node");
  const ownerScript = join(build, "host-integration/native-probe/original-owner-helper.mjs");
  const ownerNode = await realpath(process.execPath);
  const ownerSources = ["clock.c", "channel.c", "helper-profile.c", "original-owner.c"].map(file => join(native, file));
  const strictC = ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-pthread"];
  // Build-bound fixed closure, passed as literal compiler arguments, never a
  // caller-selected runtime env/argv/path. All bytes join checkInputs custody.
  await run("/usr/bin/cc", [...strictC, ...ownerSources, join(native, "original-owner-entry.c"), `-DNP_OWNER_NODE=${JSON.stringify(ownerNode)}`, `-DNP_OWNER_SCRIPT=${JSON.stringify(ownerScript)}`, `-DNP_OWNER_ADDON=${JSON.stringify(ownerAddon)}`, "-o", owner]);
  await run("/usr/bin/cc", [...strictC, "-shared", "-fPIC", ...ownerSources, join(native, "original-owner-addon.c"), "-o", ownerAddon]);
  const refusalFixture = join(temporary, "original-owner-refusal-fixture");
  await run("/usr/bin/cc", [...strictC, ...ownerSources, join(native, "original-owner-entry.c"), "-DNP_OWNER_REFUSAL_FIXTURE", `-DNP_OWNER_NODE=${JSON.stringify(ownerNode)}`, `-DNP_OWNER_TEST_SCRIPT=${JSON.stringify(join(build, "host-integration/native-probe/original-owner-contracts.test.mjs"))}`, `-DNP_OWNER_ADDON=${JSON.stringify(ownerAddon)}`, "-o", refusalFixture]);
  const producer = join(temporary,"root-producer-entry"), associatedAddon = join(temporary,"original-owner-associated.node"), gateFixture = join(temporary,"root-origin-gate-test");
  const producerSources = ["clock.c","channel.c","helper-profile.c","publication.c","original-owner.c","native-root-control.c","root-producer-native.c","root-managed-launch.c"].map(file=>join(native,file));
  const associated = [...strictC,"-DNP_ASSOCIATED_ORIGIN_V2"];
  await run("/usr/bin/cc",[...associated,...producerSources,join(native,"root-producer-entry.c"),"-Wl,-l:libsystemd.so.0","-o",producer]);
  await run("/usr/bin/cc",[...associated,"-shared","-fPIC",...producerSources,join(native,"original-owner-addon.c"),"-Wl,-l:libsystemd.so.0","-o",associatedAddon]);
  await run("/usr/bin/cc",[...associated,...producerSources,join(native,"root-origin-gate-test.c"),"-Wl,-l:libsystemd.so.0","-o",gateFixture]);
  await run(process.execPath,["--test",join(build,"host-integration/native-probe/root-producer-contracts.test.mjs")],{NP_ROOT_PRODUCER_ENTRY:producer,NP_ROOT_ORIGIN_GATE:gateFixture,TMPDIR:temporary});
  // Retain actual reviewed Source candidates for the later separate Root
  // installation gate. This does not create an image, permit or Origin.
  const candidate = join(evidence,`${attempt}-root-producer-source-candidate`);
  await mkdir(candidate,{mode:0o700});
  for(const [from,name] of [[producer,"root-producer-entry"],[associatedAddon,"original-owner-associated.node"],[dataClient,"native-root-client"],[ownerScript,"original-owner-helper.mjs"]])await copyFile(from!,join(candidate,name!));
  // A1 gets a distinct binary/profile/artifact tuple. No A0 proof qualifies
  // these new resource effects; this is a Source candidate only.
  const retainedEntry=join(temporary,"retained-v2-entry");
  const retainedSources=[...producerSources,...["resources.c","stock-manager.c","retained-v2.c","retained-v2-publication.c"].map(file=>join(native,file))];
  await run("/usr/bin/cc",[...associated,"-DNP_RETAINED_V2_A1",...retainedSources,join(native,"retained-v2-entry.c"),"-Wl,-l:libsystemd.so.0","-o",retainedEntry]);
  const retainedCandidate=join(evidence,`${attempt}-retained-v2-source-candidate`);await mkdir(retainedCandidate,{mode:0o700});
  for(const [from,name] of [[retainedEntry,"retained-v2-entry"],[associatedAddon,"original-owner-associated.node"],[dataClient,"native-root-client"],[ownerScript,"original-owner-helper.mjs"]])await copyFile(from!,join(retainedCandidate,name!));
  await writeFile(join(retainedCandidate,"expected-helper-policy.json"),'{"kind":"NativeRetainedV2ExpectedLeafV1","postExec":"np_helper_filter_v1","preExec":"np_helper_preexec_filter_v1","source":false,"work":false}\n',{flag:"wx",mode:0o644});
  await run(process.execPath,["--test",join(build,"host-integration/native-probe/retained-v2-refusal-contracts.test.mjs")],{NP_RETAINED_V2_ENTRY:retainedEntry});
  const retainedAdmin=join(retainedCandidate,"admin");
  await mkdir(join(retainedAdmin,"host-integration/native-probe"),{recursive:true});await mkdir(join(retainedAdmin,"src/core"),{recursive:true});
  for(const name of ["retained-v2-operator.mjs","install-root-producer.mjs","assemble-newtest.mjs"])await copyFile(join(build,"host-integration/native-probe",name),join(retainedAdmin,"host-integration/native-probe",name));
  for(const name of ["scoped-retained-resource-contract.js","scoped-termination-contract.js"])await copyFile(join(build,"src/core",name),join(retainedAdmin,"src/core",name));
  await copyFile(join(build,"package.json"),join(retainedAdmin,"package.json"));
  await writeFile(join(retainedCandidate,"source-profile.json"),JSON.stringify({schemaVersion:1,profile:"NativeRetainedV2A1",closed:true,source:false,work:false,physicalQualified:false,inputs},null,2)+"\n",{flag:"wx"});
  const admin = join(candidate,"admin");await mkdir(admin,{recursive:true});
  // Preserve the compiler's import layout; each actual emitted leaf is in the
  // retained candidate inventory and the checked source input graph.
  async function copyTree(from:string,to:string):Promise<void>{await mkdir(to,{recursive:true});for(const name of await readdir(from)){const path=join(from,name),s=await lstat(path);if(s.isDirectory())await copyTree(path,join(to,name));else if(s.isFile())await copyFile(path,join(to,name));else throw new Error("nonregular emitted admin input");}}
  await copyTree(join(build,"src"),join(admin,"src"));
  await mkdir(join(admin,"host-integration/native-probe"),{recursive:true});
  for(const name of ["root-origin-operator.mjs","install-root-producer.mjs","assemble-newtest.mjs","newtest-bootstrap.mjs","newtest-guest.mjs"])await copyFile(join(build,"host-integration/native-probe",name),join(admin,"host-integration/native-probe",name));
  await copyFile(join(build,"package.json"),join(admin,"package.json"));
  // Retain an independently executable fixed NEWTEST v1 closure. These
  // binaries are never run by Source CI and cannot select production paths.
  const physical = join(candidate,"physical");await mkdir(physical,{mode:0o755});
  const fixedPhysical = "/opt/native-newtest/artifact/physical";
  const fixedScript = fixedPhysical + "/host-integration/native-probe/original-owner-helper.mjs";
  const fixedAddon = fixedPhysical + "/original-owner.node";
  const physicalPins = [`-DNP_OWNER_NODE=${JSON.stringify("/opt/subscription-runtime/runtime/node")}`,`-DNP_OWNER_SCRIPT=${JSON.stringify(fixedScript)}`,`-DNP_OWNER_ADDON=${JSON.stringify(fixedAddon)}`];
  await run("/usr/bin/cc",[...strictC,...ownerSources,join(native,"original-owner-entry.c"),...physicalPins,"-o",join(physical,"original-owner")]);
  await run("/usr/bin/cc",[...strictC,"-shared","-fPIC",...ownerSources,join(native,"original-owner-addon.c"),"-o",join(physical,"original-owner.node")]);
  await run("/usr/bin/cc",[...strictC,...ownerSources,join(native,"original-owner-entry.c"),"-DNP_OWNER_REFUSAL_FIXTURE",...physicalPins,`-DNP_OWNER_TEST_SCRIPT=${JSON.stringify(fixedPhysical+"/host-integration/native-probe/original-owner-contracts.test.mjs")}`,"-o",join(physical,"original-owner-refusal-fixture")]);
  await chmod(join(physical,"original-owner"),0o755);await chmod(join(physical,"original-owner.node"),0o644);await chmod(join(physical,"original-owner-refusal-fixture"),0o755);
  await copyTree(join(build,"src"),join(physical,"src"));
  await mkdir(join(physical,"host-integration/native-probe"),{recursive:true,mode:0o755});
  for(const name of ["original-owner-helper.mjs","original-owner-contracts.test.mjs","root-producer-contracts.test.mjs","install-root-producer.mjs","root-origin-operator.mjs","retained-v2-operator.mjs"])await copyFile(join(build,"host-integration/native-probe",name),join(physical,"host-integration/native-probe",name));
  await copyFile(join(build,"package.json"),join(physical,"package.json"));
  // Fixed installer inputs and emitted ingress closure retain normal layout.
  const source = join(candidate,"runtime-source");await mkdir(source,{mode:0o755});
  for(const [directory,names] of [["host-jobs",["install","contract.mjs","manager.mjs","read-request.mjs","endpoint.mjs","storage-policy.mjs","ssh-endpoint","ssh-ingress-shell"]],["managed-launcher",["install","install-policy","install-policy.mjs","launch.mjs","profiles.mjs","payload-guard.mjs"]],["native-probe",["installed-data-package.json"]]] as const){
    const target=join(source,"host-integration",directory);await mkdir(target,{recursive:true,mode:0o755});
    for(const name of names)await copyFile(join(workspace,"host-integration",directory,name),join(target,name));
  }
  // Compile the installer's standalone CommonJS codec from this checked graph,
  // never from the workspace's independently generated installation artifact.
  const codecBuild = join(temporary,"host-inventory-codec");
  await run(process.execPath,[compiler,"-p",codecConfig,"--outDir",codecBuild]);
  const codecBytes = await readFile(join(codecBuild,"host-inventory.js"));
  // Same standalone-closure criterion as scripts/package-host-inventory-codec.mts.
  if(/\brequire\s*\(|\bimport\s*(?:\(|[^\n]*\bfrom\b)/.test(codecBytes.toString("utf8")))throw new Error("host_inventory_codec_runtime_import");
  const candidateCodec = join(source,"host-integration/managed-launcher/host-inventory-codec.cjs");
  await writeFile(candidateCodec,codecBytes,{flag:"wx"});
  await copyFile(join(managedDirectory,"hosted-host-policy.mjs"),join(source,"host-integration/managed-launcher/hosted-host-policy.mjs"));
  await copyTree(join(build,"src"),join(source,"dist"));
  // Fixture JS is readable by the actual sealed/helper and managed identities;
  // actual content remains separately hashed in the candidate census.
  async function readableTree(path:string):Promise<void>{const metadata=await lstat(path);if(metadata.isDirectory()){await chmod(path,0o755);for(const name of await readdir(path))await readableTree(join(path,name));}else if(metadata.isFile())await chmod(path,(metadata.mode&0o111)?0o755:0o644);else throw new Error("foreign physical fixture input");}
  await readableTree(physical);await readableTree(source);
  await run(process.execPath,["--test",join(build,"host-integration/native-probe/newtest-contracts.test.mjs"),join(build,"host-integration/native-probe/managed-original-ends-contracts.test.mjs")],{NP_HOST_INVENTORY_CODEC:candidateCodec});
  await writeFile(join(candidate,"source-artifacts.json"),JSON.stringify({kind:"SOURCE_CANDIDATE_ONLY",authorityIssued:false,physicalQualified:false,inputs,artifacts:await inventory(candidate)},null,2)+"\n",{flag:"wx"});
  ownerFixture = process.env.SR_NATIVE_PROBE_ORIGINAL_OWNER_FIXTURE === "65532-seal-admitted";
  if (ownerFixture) {
    if (process.geteuid?.() !== 0) throw new Error("admitted original owner fixture lacks trusted initial privilege");
    // These are harmless emitted fixture bytes, not dependencies/credentials.
    // The fixed 65532 helper needs traverse permission to its held module URL.
    await chmod(temporary, 0o755);
  }
  await run(process.execPath, ["--test", join(build, "host-integration/native-probe/original-owner-contracts.test.mjs")], { NP_ORIGINAL_OWNER: owner, NP_ORIGINAL_OWNER_ADDON: ownerAddon, NP_ORIGINAL_OWNER_REFUSAL_FIXTURE: refusalFixture, NP_ORIGINAL_OWNER_ATTEMPTS: ownerAttempts, ...(ownerFixture ? { NP_ORIGINAL_OWNER_PRIVILEGED: "65532-seal-admitted" } : {}) });
  originalOwnerJoined = ownerFixture && await ownerJoined();
  originalOwnerSettled = ownerFixture ? originalOwnerJoined : (await readdir(ownerAttempts)).length === 0;
  if (!originalOwnerSettled) throw new Error("original owner attempt lacks natural close and original positive join");
  inputsStable = JSON.stringify(inputs) === JSON.stringify(await checkInputs(workspace, graph));
  if (!inputsStable) throw new Error("checked source changed during verification");
  passed = true;
} finally {
  let artifacts: readonly Artifact[] = [], artifactError: string | null = null;
  try { artifacts = await inventory(temporary); } catch (failure) { artifactError = failure instanceof Error ? failure.message : String(failure); }
  const current = await lstat(temporary, { bigint: true });
  const owned = current.isDirectory() && !current.isSymbolicLink() && current.dev === originalTemporary.dev && current.ino === originalTemporary.ino && current.uid === originalTemporary.uid && artifacts.every(row => row.device === current.dev.toString() && row.uid === current.uid.toString());
  const cleanupEligible = passed && inputsStable && originalOwnerSettled && owned && artifactError === null && log.every(check => check.naturalClose && check.exit === 0 && check.signal === null && check.error === null);
  // Persist the original bytes/identities before any successful disposal. A
  // failure/unresolved result always retains its owned tree; no retry/prune.
  await writeFile(join(evidence, `source-check-${attempt}.json`), JSON.stringify({ qualification: "source-contracts-only", attempt, passed, inputsStable, inputs, checks: log, fixture: { path: temporary, originalDevice: originalTemporary.dev.toString(), originalInode: originalTemporary.ino.toString(), originalUid: originalTemporary.uid.toString(), ownerFixture, originalOwnerJoined, originalOwnerSettled, artifacts, artifactError, cleanupEligible, disposition: "retained" } }, null, 2) + "\n", { flag: "wx" });
  if (cleanupEligible) {
    let removed = false, cleanupError: string | null = null;
    try {
      const immediate = await lstat(temporary, { bigint: true });
      if (!immediate.isDirectory() || immediate.isSymbolicLink() || immediate.dev !== originalTemporary.dev || immediate.ino !== originalTemporary.ino || immediate.uid !== originalTemporary.uid) throw new Error("fixture identity changed before cleanup");
      await rm(temporary, { recursive: true, force: false }); removed = true;
    } catch (failure) { cleanupError = failure instanceof Error ? failure.message : String(failure); }
    await writeFile(join(evidence, `source-check-${attempt}-disposition.json`), JSON.stringify({ attempt, path: temporary, removed, cleanupError }) + "\n", { flag: "wx" });
    if (cleanupError) throw new Error(`verified-success fixture cleanup failed: ${cleanupError}`);
  }
}
