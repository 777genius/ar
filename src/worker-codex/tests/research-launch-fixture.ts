import { vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const fixture = vi.hoisted(() => ({ root: "", group: "/user.slice/TEST-session.scope", birth: "12345", boot: "a".repeat(8) + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  uidMap: "0 0 4294967295", namespaceRoot: false, global: false, projectParent: false, physicalPaths: false, nativeBackingFacts: false, foreign: new Set<string>(),
  fdPaths: new Map<number, string>(), pins: new Map<string, string>(), calls: [] as { command: string; args: string[] }[],
  units: new Map<string, { description: string; pid: number; invocation: string; active: boolean; pending?: boolean;
    state?: "inactive" | "failed" | "activating" | "deactivating"; dropIns?: string }>(),
  processGroups: new Map<number, string>(), killFailures: new Set<string>(), stopFailures: new Set<string>(),
  processNamespaces: new Map<number, Record<"user" | "mnt" | "pid" | "net", string>>(), showFailures: new Set<string>(),
  jobs: new Set<string>(), spawn: vi.fn(), authReads: 0, taskTimeoutMs: 3600000, findmntHook: undefined as (() => void) | undefined,
  scratchNodes: new Map<string, import("../host-scratch-temp").ScratchTempHost extends { lstat(path: string): infer Info } ? Info : never>(),
  scratchMounts: new Map<string, { target?: string; uuid?: string; fsroot?: string } | undefined>() }));
export const host = fixture;
/** The fixture reuses the test PID for binding. Moving the caller to the outside
 * operator must retain the numeric MainPID's already-bound runtime identity. */
export function enterResearchOperatorScope(unit: string): void {
  const service = fixture.units.get(unit), group = "/system.slice/" + unit;
  if (!service || service.pid !== process.pid || !service.active || fixture.group !== group ||
      (fixture.processGroups.has(service.pid) && fixture.processGroups.get(service.pid) !== group))
    throw new Error("Expected a live bound TEST runtime before entering operator scope");
  fixture.processGroups.set(service.pid, group);
  fixture.group = "/user.slice/TEST-operator.scope";
}
const nativeFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
let ownedRoot: { path: string; device: number; inode: number } | undefined;
/** Optional physical backing exists only after this module allocates a TEST root.
 * Callers still use native IO and check actual ancestry before every mutation. */
export function researchScratchBackingPath(path: string): string | undefined {
  if (!fixture.root) return undefined;
  if (!ownedRoot || fixture.root !== ownedRoot.path) throw new Error("Unowned TEST scratch backing root");
  const root = nativeFs.lstatSync(ownedRoot.path);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700 ||
      root.dev !== ownedRoot.device || root.ino !== ownedRoot.inode) throw new Error("Allocated TEST scratch backing root changed");
  const backing = resolve(local(path));
  if (!backing.startsWith(resolve(ownedRoot.path) + "/")) throw new Error("TEST scratch backing path escaped its allocated root");
  return backing;
}
// Official public ISRG Root X1 CA, https://letsencrypt.org/certs/isrgrootx1.pem.
export const publicTestCa = "-----BEGIN CERTIFICATE-----\nMIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\nTzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\ncmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\nWhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\nZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\nMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\nh77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\nA5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\nT8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\nB5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\nB5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\nKBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\nOlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\njh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\nqHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\nrU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\nHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\nhkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\nubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\nNFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\nORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\nTkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\njNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\noyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\nmRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\nemyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n-----END CERTIFICATE-----\n";
// Public synthetic non-CA certificate from nodejs/node test/fixtures/keys/agent1-cert.pem.
// Upstream test-crypto-x509.js independently asserts !x509.ca for this certificate.
export const publicTestLeaf = "-----BEGIN CERTIFICATE-----\nMIID6DCCAtCgAwIBAgIUFH02wcL3Qgben6tfIibXitsApCYwDQYJKoZIhvcNAQEL\nBQAwejELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMQswCQYDVQQHDAJTRjEPMA0G\nA1UECgwGSm95ZW50MRAwDgYDVQQLDAdOb2RlLmpzMQwwCgYDVQQDDANjYTExIDAe\nBgkqhkiG9w0BCQEWEXJ5QHRpbnljbG91ZHMub3JnMCAXDTIyMDkwMzIxNDAzN1oY\nDzIyOTYwNjE3MjE0MDM3WjB9MQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExCzAJ\nBgNVBAcMAlNGMQ8wDQYDVQQKDAZKb3llbnQxEDAOBgNVBAsMB05vZGUuanMxDzAN\nBgNVBAMMBmFnZW50MTEgMB4GCSqGSIb3DQEJARYRcnlAdGlueWNsb3Vkcy5vcmcw\nggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDUVjIK+yDTgnCT3CxChO0E\n37q9VuHdrlKeKLeQzUJW2yczSfNzX/0zfHpjY+zKWie39z3HCJqWxtiG2wxiOI8c\n3WqWOvzVmdWADlh6EfkIlg+E7VC6JaKDA+zabmhPvnuu3JzogBMnsWl68lCXzuPx\ndeQAmEwNtqjrh74DtM+Ud0ulb//Ixjxo1q3rYKu+aaexSramuee6qJta2rjrB4l8\nB/bU+j1mDf9XQQfSjo9jRnp4hiTFdBl2k+lZzqE2L/rhu6EMjA2IhAq/7xA2MbLo\n9cObVUin6lfoo5+JKRgT9Fp2xEgDOit+2EA/S6oUfPNeLSVUqmXOSWlXlwlb9Nxr\nAgMBAAGjYTBfMF0GCCsGAQUFBwEBBFEwTzAjBggrBgEFBQcwAYYXaHR0cDovL29j\nc3Aubm9kZWpzLm9yZy8wKAYIKwYBBQUHMAKGHGh0dHA6Ly9jYS5ub2RlanMub3Jn\nL2NhLmNlcnQwDQYJKoZIhvcNAQELBQADggEBAMM0mBBjLMt9pYXePtUeNO0VTw9y\nFWCM8nAcAO2kRNwkJwcsispNpkcsHZ5o8Xf5mpCotdvziEWG1hyxwU6nAWyNOLcN\nG0a0KUfbMO3B6ZYe1GwPDjXaQnv75SkAdxgX5zOzca3xnhITcjUUGjQ0fbDfwFV5\nix8mnzvfXjDONdEznVa7PFcN6QliFUMwR/h8pCRHtE5+a10OSPeJSrGG+FtrGnRW\nG1IJUv6oiGF/MvWCr84REVgc1j78xomGANJIu2hN7bnD1nEMON6em8IfnDOUtynV\n9wfWTqiQYD5Zifj6WcGa0aAHMuetyFG4lIfMAHmd3gaKpks7j9l26LwRPvI=\n-----END CERTIFICATE-----\n";
export function local(path: string): string {
  if (path.startsWith("/proc/1/root/")) return local(path.slice("/proc/1/root".length));
  const authority = "/run/user/subscription-runtime-research-v1", artifact = "/TEST-artifact", project = "/TEST-project";
  // This portable TEST fixture has no Host scratch policy. Never inspect or
  // activate a real Host binding through executor home preparation.
  if (path === "/etc/subscription-runtime/scratch-temp.json") return join(fixture.root, "absent-scratch-policy");
  // Physical executor fixtures still model protected Host ancestry. Map only
  // their exact backing-temp ancestors to our safe TEST directory, never mask
  // modes or symlinks on selected files/directories (or chmod the real /tmp).
  if (fixture.physicalPaths && fixture.root.startsWith(path + "/")) return fixture.root;
  for (const [pin, target] of fixture.pins) if (path === pin || path.startsWith(pin + "/")) return local(target + path.slice(pin.length));
  for (const [prefix, name] of [[authority, "authority"], [artifact, "artifact"], [project, "project"], ["/TEST-auth", "auth"], ["/TEST-operator", "operator"], ["/run/systemd/transient", "units"], ["/run/systemd/resolve", "system/run/systemd/resolve"]]) {
    if (path === prefix || path.startsWith(prefix + "/")) return join(fixture.root, name!, path.slice(prefix!.length));
  }
  if (path === "/var/lib/subscription-runtime-host-policy" || path === "/run/user/0/subscription-runtime-host-policy") return join(fixture.root, fixture.global ? "global" : "absent");
  if (path.startsWith("/var/lib/subscription-runtime-host-policy/") || path.startsWith("/run/user/0/subscription-runtime-host-policy/")) return join(fixture.root, "absent", path.split("/").at(-1)!);
  if (path === process.execPath || path.startsWith("/usr/bin/")) return join(fixture.root, "executable");
  for (const prefix of ["/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib64"]) if (path === prefix || path.startsWith(prefix + "/")) return join(fixture.root, "system", path.slice(1));
  if (["/", "/run", "/run/systemd", "/run/user", "/run/user/0", "/var", "/var/lib", "/usr", "/usr/bin", "/opt"].includes(path) || process.execPath.startsWith(path + "/")) return fixture.root;
  return path;
}
function syntheticMountInfo(): string {
  const lines = ["1 0 8:1 / / rw - ext4 /dev/TEST rw"];
  for (const [pin, target] of fixture.pins) lines.push(`${lines.length + 1} 1 8:1 ${target} ${pin} rw - ext4 /dev/TEST rw`);
  for (const [target, mount] of fixture.scratchMounts) if (mount) lines.push(`${lines.length + 1} 1 0:11 ${mount.fsroot} ${target} rw - ext4 /dev/TEST-scratch rw`);
  return lines.join("\n") + "\n";
}
function syntheticFdInfo(fd: number): string {
  const path = fixture.fdPaths.get(fd);
  if (path === undefined) throw new Error("unexpected TEST fdinfo descriptor");
  const selected = path.replace(/^\/proc\/1\/root/, "");
  const index = [...fixture.pins.keys()].findIndex(pin => selected === pin || selected.startsWith(pin + "/"));
  return `mnt_id:\t${index === -1 ? 1 : index + 2}\n`;
}
vi.mock("node:url", async original => {
  const real = await original<typeof import("node:url")>();
  return { ...real, fileURLToPath: (url: URL | string) => {
    const path = real.fileURLToPath(url);
    return path === process.cwd() + "/" ? "/TEST-artifact/" : path;
  } };
});
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: string) => fixture.scratchNodes.get(path) ?? Object.assign(real.lstatSync(local(path)), { ...(!fixture.nativeBackingFacts ? { dev: 2049 } : {}), gid: 0, uid: fixture.foreign.has(path) || (fixture.projectParent && path === "/TEST-project") ? 999 : 0 }),
    statSync: (path: string) => Object.assign(real.statSync(local(path)), { ...(!fixture.nativeBackingFacts ? { dev: 2049 } : {}), gid: 0, uid: fixture.foreign.has(path) ? 999 : 0 }),
    fstatSync: (fd: number, options?: { bigint?: boolean }) => {
      const uid = fixture.foreign.has(fixture.fdPaths.get(fd) ?? "") ? 999 : 0;
      return options?.bigint
        ? Object.assign(real.fstatSync(fd, { bigint: true }), { ...(!fixture.nativeBackingFacts ? { dev: 2049n } : {}), gid: 0n, uid: BigInt(uid) })
        : Object.assign(real.fstatSync(fd), { ...(!fixture.nativeBackingFacts ? { dev: 2049 } : {}), gid: 0, uid });
    },
    openSync: (path: string, flags: number | string, mode: number) => {
      const mountInfo = path === "/proc/self/mountinfo" || path === "/proc/1/mountinfo";
      let selected = !fixture.nativeBackingFacts && mountInfo ? join(fixture.root, "mountinfo") : local(path);
      if (!fixture.nativeBackingFacts && mountInfo) real.writeFileSync(selected, syntheticMountInfo(), { mode: 0o600 });
      if (!fixture.nativeBackingFacts && path.startsWith("/proc/self/fdinfo/")) {
        const sourceFd = Number(path.split("/").at(-1));
        selected = join(fixture.root, `fdinfo-${sourceFd}.txt`);
        real.writeFileSync(selected, syntheticFdInfo(sourceFd), { mode: 0o600 });
      }
      const fd = real.openSync(selected, flags, mode); fixture.fdPaths.set(fd, path); return fd;
    },
    existsSync: (path: string) => real.existsSync(local(path)),
    readFileSync: (path: string | number, opts: Parameters<typeof real.readFileSync>[1]) => {
      if (typeof path === "string" && path.startsWith("/proc/")) {
        if (fixture.nativeBackingFacts && (path === "/proc/self/mountinfo" || path === "/proc/1/mountinfo" || path.startsWith("/proc/self/fdinfo/"))) return real.readFileSync(path, opts);
        if (path === "/proc/self/mountinfo" || path === "/proc/1/mountinfo") return syntheticMountInfo();
        if (path.startsWith("/proc/self/fdinfo/")) return syntheticFdInfo(Number(path.split("/").at(-1)));
        if (path.endsWith("/uid_map") || path.endsWith("/gid_map")) return fixture.uidMap;
        if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot;
        if (path.endsWith("/cgroup")) return `0::${fixture.processGroups.get(Number(path.split("/")[2])) ?? fixture.group}\n`;
        if (path.endsWith("/stat")) return `1 (TEST process) ` + ["S", ...Array(18).fill("0"), fixture.birth].join(" ");
        throw new Error("unexpected TEST proc read");
      }
      if (path === "/etc/machine-id") return "b".repeat(32);
      return real.readFileSync(typeof path === "string" ? local(path) : path, opts);
    },
    readlinkSync: (path: string) => {
      if (!path.startsWith("/proc/")) return real.readlinkSync(local(path));
      const parts = path.split("/"), pid = parts[2] === "self" ? process.pid : Number(parts[2]);
      const ids = { user: 4026531837, mnt: 4026531841, pid: 4026531836, net: 4026531840 } as const;
      const kind = parts.at(-1) as keyof typeof ids, selected = fixture.processNamespaces.get(pid)?.[kind];
      if (selected !== undefined) return selected;
      // Canonical labelled TEST identities, not physical namespace evidence.
      if (parts[3] === "ns" && kind in ids) return `${kind}:[${ids[kind] + (fixture.namespaceRoot && pid === process.pid ? 1000 : 0)}]`;
      return "TEST-host";
    },
    realpathSync: (path: string) => { if (fixture.scratchNodes.has(path)) return path; const target = real.realpathSync(local(path)); return target.startsWith(join(fixture.root, "artifact")) ? "/TEST-artifact" + target.slice(join(fixture.root, "artifact").length) : target.startsWith(join(fixture.root, "system") + "/") ? target.slice(join(fixture.root, "system").length) : target === local(path) ? path : target; },
    readdirSync: (path: string, opts: Parameters<typeof real.readdirSync>[1]) => real.readdirSync(local(path), opts),
    mkdirSync: (path: string, opts: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), opts),
    symlinkSync: (target: string, path: string) => real.symlinkSync(target, local(path)),
    writeFileSync: (path: string | number, bytes: Parameters<typeof real.writeFileSync>[1], options: Parameters<typeof real.writeFileSync>[2]) => real.writeFileSync(typeof path === "string" ? local(path) : path, bytes, options),
    renameSync: (from: string, to: string) => real.renameSync(local(from), local(to)),
    unlinkSync: (path: string) => real.unlinkSync(local(path)),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
  };
});
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, readFile: (path: string, opts: Parameters<typeof real.readFile>[1]) => {
    if (path.endsWith("auth.json")) fixture.authReads++;
    return real.readFile(local(path), opts);
  },
  // Supported publication/revoke locks also stay inside the allocated TEST root.
  mkdir: (path: string, options: Parameters<typeof real.mkdir>[1]) => real.mkdir(local(path), options),
  mkdtemp: (prefix: string, options: Parameters<typeof real.mkdtemp>[1]) => real.mkdtemp(local(prefix), options),
  realpath: async (path: string) => { const target = await real.realpath(local(path)); return target === local(path) ? path : target; },
  writeFile: (path: string, bytes: Parameters<typeof real.writeFile>[1], options: Parameters<typeof real.writeFile>[2]) => real.writeFile(local(path), bytes, options),
  rename: (from: string, to: string) => real.rename(local(from), local(to)),
  rm: (path: string, options: Parameters<typeof real.rm>[1]) => real.rm(local(path), options),
  unlink: (path: string) => real.unlink(local(path)),
  link: (from: string, to: string) => real.link(local(from), local(to)),
  readdir: (path: string, options: Parameters<typeof real.readdir>[1]) => real.readdir(local(path), options),
  stat: (path: string) => real.stat(local(path)),
  lstat: async (path: string, options?: { bigint?: boolean }) => {
    const info = await real.lstat(local(path), options);
    const uid = fixture.foreign.has(path) || (fixture.projectParent && path === "/TEST-project") ? 999 : 0;
    return Object.assign(info, { uid: options?.bigint ? BigInt(uid) : uid });
  },
  readlink: async (path: string) => path.startsWith("/proc/") ? "TEST-host" : real.readlink(local(path)),
  open: async (path: string, flags: string | number) => {
    // The custody adapter's fixed read-only FD walk starts at the native root.
    // Its final canonical binding still has to reach the owned TEST directory.
    const nativeRootRead = fixture.nativeBackingFacts && path === "/" &&
      flags === (nativeFs.constants.O_RDONLY | nativeFs.constants.O_DIRECTORY);
    const file = await real.open(nativeRootRead ? path : local(path), flags), stat = file.stat.bind(file);
    file.stat = (async (...args: Parameters<typeof file.stat>) => Object.assign(await stat(...args), { uid: fixture.foreign.has(path) ? 999 : 0 })) as typeof file.stat;
    return file;
  },
  };
});
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...real, spawn: (...args: unknown[]) => {
    if (!fixture.nativeBackingFacts) return fixture.spawn(...args);
    const [command, argv, options] = args as [string, string[], import("node:child_process").SpawnOptions];
    const owned = (path: string): boolean => {
      const selected = researchScratchBackingPath(path);
      return selected === path && fs.realpathSync(path) === path && fs.lstatSync(path).dev === ownedRoot?.device;
    };
    // Only fixed offline readers/operations may run. Provider runtimes never
    // pass this TEST-only effect boundary.
    if (command === process.execPath && argv.length === 6 && argv[1] === "project-control-operation-run" &&
        argv[2] === "--operation-file" && argv[4] === "--format" && argv[5] === "json" &&
        argv[0]?.endsWith("/fake-operation-runner.mjs") && owned(argv[0]) && owned(argv[3]!) &&
        options.stdio === "ignore" && options.detached === true &&
        options.env?.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_RUNNER === "1" &&
        (options.cwd === undefined || typeof options.cwd === "string" && owned(options.cwd))) return real.spawn(command, argv, options);
    const stdio = options?.stdio;
    if (command === "git" && argv.length === 3 && argv.join("\0") === "--no-replace-objects\0cat-file\0--batch" &&
        Array.isArray(stdio) && stdio.length === 3 && stdio.every(value => value === "pipe") &&
        Object.keys(options).every(key => ["cwd", "env", "stdio"].includes(key)) &&
        typeof options.cwd === "string" && owned(options.cwd) && fs.lstatSync(options.cwd).isDirectory() &&
        options.env?.GIT_NO_REPLACE_OBJECTS === "1" && options.env?.GIT_GRAFT_FILE === "/dev/null") {
      return real.spawn("/usr/bin/git", argv, { ...options, env: {
        PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      } });
    }
    if (command === "/usr/bin/mv" && argv.length === 6 &&
        argv.slice(0, 4).join("\0") === "--no-copy\0--no-clobber\0--no-target-directory\0--" &&
        argv.slice(4).every(path => /^\/proc\/self\/fd\/3\/[A-Za-z0-9_.-]+$/.test(path) && !path.endsWith("/.") && !path.endsWith("/..")) &&
        argv[4] !== argv[5] && Array.isArray(stdio) && stdio.length === 4 &&
        stdio.slice(0, 3).every(value => value === "ignore") && typeof stdio[3] === "number" &&
        fs.fstatSync(stdio[3]).isDirectory() && owned(fs.readlinkSync(`/proc/self/fd/${stdio[3]}`)) &&
        options.env?.PATH === "/usr/bin:/bin" && options.env?.LC_ALL === "C") return real.spawn(command, argv, options);
    throw new Error("unexpected TEST native process effect");
  }, spawnSync: (command: string, args: string[]) => {
    fixture.calls.push({ command, args });
    if (command === "/usr/bin/findmnt") {
      // util-linux treats explicit table selectors as mutually exclusive.
      if (args.includes("--task") && args.some(value => ["--kernel", "--mtab", "--fstab"].includes(value)))
        throw new Error("TEST findmnt mutually exclusive table selectors");
      fixture.findmntHook?.();
      if (args.includes("--list")) return { status: 0, stdout: JSON.stringify({ filesystems: [{ id: 1, target: "/", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", fsroot: "/", "maj:min": "8:1" }, ...[...fixture.pins].map(([target, fsroot], index) => ({ id: index + 2, target, fsroot, uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "maj:min": "8:1" }))] }) };
      const path = args[args.indexOf("--target") + 1]!, pins = [...fixture.pins];
      const index = pins.findIndex(([pin]) => path === pin || path.startsWith(pin + "/"));
      return { status: 0, stdout: JSON.stringify({ filesystems: [{ id: index === -1 ? 1 : index + 2,
        target: index === -1 ? "/" : pins[index]![0], uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        fsroot: index === -1 ? "/" : pins[index]![1], "maj:min": "8:1" }] }) };
    }
    if (command === "/usr/bin/mount") { if (args[0] === "--bind") fixture.pins.set(args[2]!, args[1]!); return { status: 0, stdout: "" }; }
    if (command === "/usr/bin/systemd-run") {
      const unit = args.find(a => a.startsWith("--unit="))!.slice(7);
      fixture.units.set(unit, { pid: process.pid, description: args.find(a => a.startsWith("--description="))!.slice(14), invocation: "c".repeat(32), active: true });
      fs.writeFileSync(local(`/run/systemd/transient/${unit}`), "TEST service fragment", { mode: 0o644 });
      return { status: 0, stdout: "" };
    }
    if (command !== "/usr/bin/systemctl") throw new Error("unexpected TEST process effect");
    const unit = args[1]!, service = fixture.units.get(unit);
    if (args[0] === "show") {
      if (fixture.showFailures.has(unit)) return { status: 1, stdout: "" };
      return { status: 0, stdout: service && (service.active || service.state) ? `Id=${unit}\nLoadState=loaded\nMainPID=${service.pending ? 0 : service.pid}\nControlGroup=${service.pending ? "" : "/system.slice/" + unit}\nInvocationID=${service.pending ? "" : service.invocation}\nDescription=${service.description}\nActiveState=${service.state ?? (service.pending ? "activating" : "active")}\nSubState=${service.pending ? "start" : "running"}\nTransient=yes\nFragmentPath=/run/systemd/transient/${unit}\nDropInPaths=${service.dropIns ?? ""}\nKillMode=control-group\n` : `Id=${unit}\nLoadState=not-found\nMainPID=0\nActiveState=inactive\n` };
    }
    if (args[0] === "stop") {
      const selected = args.at(-1)!;
      if (fixture.stopFailures.has(selected)) return { status: 1, stdout: "" };
      const stopped = fixture.units.get(selected);
      if (stopped) { stopped.active = false; delete stopped.state; }
      fixture.jobs.delete(selected);
      return { status: 0, stdout: "" };
    }
    if (args[0] === "kill") return { status: fixture.killFailures.has(args.at(-1)!) ? 1 : 0, stdout: "" };
    if (args[0] === "list-jobs") return { status: 0, stdout: [...fixture.jobs].map((name, i) => `${i + 1} ${name} start waiting`).join("\n") };
    throw new Error("unexpected TEST systemctl effect");
  } };
});
export const request = () => ({ schemaVersion: 1, jobId: "TEST-research-r7", taskId: "TEST-research-r7",
  jobRootDir: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7") : "/TEST-project/jobs/TEST-research-r7",
  workspacePath: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7/workspace") : "/TEST-project/jobs/TEST-research-r7/workspace",
  promptPath: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7/prompt.md") : "/TEST-project/jobs/TEST-research-r7/prompt.md",
  authRootDir: fixture.physicalPaths ? join(fixture.root, "auth") : "/TEST-auth", accounts: ["TEST-a", "TEST-b"],
  codexBinaryPath: "/usr/bin/TEST-codex", model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default", taskTimeoutMs: fixture.taskTimeoutMs });
/** Configure retained TEST operator input before any grant or start is issued. */
export function configureResearchFixtureTaskTimeout(taskTimeoutMs: number): void {
  fixture.taskTimeoutMs = taskTimeoutMs;
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(request()) + "\n", { mode: 0o600 });
}
export function setupResearchFixture(): void;
export function setupResearchFixture(options: { readonly nativeBackingFacts?: boolean }): void;
export function setupResearchFixture(options: { readonly nativeBackingFacts?: boolean } = {}): void {
  fixture.nativeBackingFacts = options.nativeBackingFacts === true;
  fixture.root = nativeFs.mkdtempSync(join(fixture.nativeBackingFacts ? "/dev/shm" : tmpdir(), "TEST-research-launch-r7-"));
  const allocated = nativeFs.lstatSync(fixture.root);
  ownedRoot = { path: fixture.root, device: allocated.dev, inode: allocated.ino };
  fixture.group = "/user.slice/TEST-session.scope"; fixture.birth = "12345"; fixture.uidMap = "0 0 4294967295";
  fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fixture.namespaceRoot = false; fixture.global = false; fixture.projectParent = false; fixture.physicalPaths = false; fixture.foreign.clear(); fixture.fdPaths.clear(); fixture.pins.clear(); fixture.calls = []; fixture.units.clear(); fixture.processGroups.clear(); fixture.processNamespaces.clear(); fixture.showFailures.clear(); fixture.killFailures.clear(); fixture.stopFailures.clear(); fixture.jobs.clear(); fixture.spawn.mockReset(); fixture.authReads = 0; fixture.findmntHook = undefined; fixture.scratchNodes.clear(); fixture.scratchMounts.clear();
  fixture.taskTimeoutMs = 3600000;
  fixture.physicalPaths = fixture.nativeBackingFacts;
  vi.spyOn(process, "getuid").mockReturnValue(0); vi.spyOn(process, "geteuid").mockReturnValue(0);
  for (const dir of ["global", "artifact/dist", "artifact/host-integration", "artifact/node_modules", "artifact/packages/dependency", "project/jobs/TEST-research-r7/workspace", "auth/TEST-a", "auth/TEST-b", "operator", "units", "system/etc/ssl/certs", "system/opt", "system/usr/bin", "system/usr/sbin", "system/usr/lib", "system/usr/lib64"]) mkdirSync(join(fixture.root, dir), { recursive: true, mode: 0o700 });
  mkdirSync(local(dirname(process.execPath)), { recursive: true, mode: 0o700 });
  for (const leaf of ["bin", "sbin", "lib", "lib64"]) symlinkSync("usr/" + leaf, join(fixture.root, "system", leaf));
  for (const [name, bytes] of Object.entries({
    passwd: "root:x:0:0:root:/root:/bin/sh\n", group: "root:x:0:\n",
    "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n", hosts: "127.0.0.1 localhost\n",
    "gai.conf": "# TEST public address-selection defaults\n", "host.conf": "multi on\n", "ssl/certs/ca-certificates.crt": publicTestCa,
  })) writeFileSync(join(fixture.root, "system/etc", name), bytes, { mode: 0o644 });
  writeFileSync(join(fixture.root, "system/etc/resolv.conf"), "nameserver 192.0.2.1\n", { mode: 0o644 });
  writeFileSync(join(fixture.root, "executable"), "TEST executable bytes", { mode: 0o755 });
  writeFileSync(local("/TEST-artifact/package.json"), '{"type":"module"}', { mode: 0o644 });
  writeFileSync(local("/TEST-artifact/dist/main.js"), "TEST runtime bytes", { mode: 0o644 });
  writeFileSync(local("/TEST-artifact/packages/dependency/index.js"), "TEST dependency bytes", { mode: 0o644 });
  writeFileSync(local(request().promptPath), "TEST public research prompt", { mode: 0o600 });
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(request()) + "\n", { mode: 0o600 });
  fixture.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }));
}
export function cleanupResearchFixture(): void {
  fixture.pins.clear();
  try {
    if (ownedRoot) {
      let root: import("node:fs").Stats | undefined;
      try { root = nativeFs.lstatSync(ownedRoot.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (root) {
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== ownedRoot.device || root.ino !== ownedRoot.inode)
          throw new Error("Refusing cleanup of replaced TEST fixture root");
        nativeFs.rmSync(ownedRoot.path, { recursive: true, force: true });
      }
    }
  } finally { ownedRoot = undefined; fixture.root = ""; vi.restoreAllMocks(); }
}
