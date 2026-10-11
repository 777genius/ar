import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ cgroup: "", stat: "123 (owned observer) " + Array.from({length:20}, (_,i) => i===1?"1":i===19?"456":"0").join(" ") }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string) => {
    if (path === "/proc/123/stat") return fixture.stat;
    if (path === "/proc/123/cgroup") return fixture.cgroup;
    if (path === "/proc/123/cmdline") return Buffer.from("/usr/bin/node\0/owned/worker.js\0");
    if (/^\/proc\/123\/(?:uid_map|gid_map)$/.test(path)) return "0 0 4294967295\n";
    if (path === "/proc/123/status") return "Pid:\t123\n";
    throw new Error("unselected process read");
  }, readlinkSync: (path: string) => path === "/proc/123/exe" ? "/usr/bin/node" : "synthetic namespace",
}));
vi.mock("../app-server/adapters/hosted-fd-table", () => ({ hostedFdTable: () => Object.freeze([]) }));
import { observeHostedFdProcess } from "../app-server/adapters/hosted-fd-observation";
const group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-hosted-22222222-2222-4222-8222-222222222222.service";
beforeEach(() => { fixture.cgroup = `0::${group}\n`; });
it.each([`0::${group}\n`, `0::${group}\n1:name=systemd:/\n`, `1:name=systemd:/\n0::${group}\n`])("returns canonical membership alongside original birth/argv/executable facts", raw => {
  fixture.cgroup = raw;
  expect(observeHostedFdProcess(123)).toMatchObject({ pid:123, parentPid:1, birth:"123:456", group:`0::${group}`, exe:"/usr/bin/node", argv:["/usr/bin/node","/owned/worker.js"] });
});
it.each([`0::${group}\n0::/foreign\n`, `0::${group}\n1:name=systemd:/foreign\n`, `0::${group}\n1:name=systemd:/\n1:name=systemd:/\n`])("refuses duplicate or foreign membership before FDA admission", raw => {
  fixture.cgroup = raw;
  expect(() => observeHostedFdProcess(123)).toThrow("hosted_custody_kernel_evidence_invalid");
});
