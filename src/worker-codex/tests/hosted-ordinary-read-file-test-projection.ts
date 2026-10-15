type ReadFileSyncApi = Pick<typeof import("node:fs"), "readFileSync">;
type OrdinaryReadFileFixture = Readonly<{
  boot: string; group: string; creatorBirth: string; creatorGroup: string;
  manifestMountInfo: string; populated: boolean;
}>;

// TEST-only finite host projections. Retain the live hoisted fixture reference;
// genuine descriptor/non-string reads always delegate to the captured real API.
export function createOrdinaryReadFileSyncProjection(
  real: ReadFileSyncApi, fixture: OrdinaryReadFileFixture, local: (path: string) => string,
) {
  return (path: Parameters<typeof real.readFileSync>[0], options: Parameters<typeof real.readFileSync>[1]) => {
    if (typeof path !== "string") return real.readFileSync(path, options);
    if (path === "/proc/self/uid_map") return "0 0 4294967295\n";
    if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot;
    if (path === "/etc/machine-id") return "a".repeat(32);
    if (path === "/proc/self/cgroup") return `0::${fixture.group}\n`;
    if (path === "/proc/123/stat") return "123 (supervisor) " + [...Array(19).fill("0"), "456"].join(" ");
    if (path === `/proc/${process.pid}/stat`) return `${process.pid} (dispatcher) ` + [...Array(19).fill("0"), fixture.creatorBirth].join(" ");
    if (path === `/proc/${process.pid}/cgroup`) return `0::${fixture.creatorGroup}\n`;
    if (path === "/proc/self/mountinfo") {
      const text = fixture.manifestMountInfo || "1 0 8:1 / / rw - ext4 /dev/TEST rw\n";
      return options === "utf8" ? text : Buffer.from(text);
    }
    if (path.startsWith("/sys/fs/cgroup") && path.endsWith("/cgroup.events")) return `populated ${fixture.populated ? 1 : 0}\n`;
    if (path.startsWith("/sys/fs/cgroup") && path.endsWith("/cgroup.procs")) return path.includes("trusted.service") ? "123\n" : "";
    return real.readFileSync(local(path), options);
  };
}
