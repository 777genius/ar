import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostedCodexPermissionProfilesToml } from "../hosted-codex-permissions";
import { codexProviderApiEgressPolicy } from "../codex-provider-egress-policy";
import { assertHostedOpenWorkerLayout, renderHostedOpenWorkerProfilesToml } from "../hosted-open-worker-permissions";

const strictProfilesToml = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
const renderInput = { workspacePath: "/project", toolRoot: "/project.tool", commitAllowed: false,
  strictProfilesToml, denyDirectories: ["/srv/workers/jobs/private"] };
const error = (code: string) => `hosted_open_worker_layout_invalid:${code}`;
const roots: string[] = [];
// System credential directories can exist on Linux and be absent on macOS.
function fixtureDenies(input: Parameters<typeof assertHostedOpenWorkerLayout>[0]) {
  return assertHostedOpenWorkerLayout(input).denyDirectories.filter(path => !["/etc/credstore", "/etc/credstore.encrypted"].includes(path));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(commitAllowed = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-worker-layout-")));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const toolRoot = `${workspacePath}.tool`;
  const read = join(root, "read");
  for (const path of [workspacePath, toolRoot, `${toolRoot}/home`, `${toolRoot}/tmp`, read,
    ...(commitAllowed ? [`${toolRoot}/git`] : [])]) mkdirSync(path, { mode: 0o700 });
  return { workspacePath, toolRoot, commitAllowed, readRoots: [read], secretRoots: [] as string[],
    deniedRoots: [] as string[], pathEnv: "/usr/bin:/bin", ownerUid: process.getuid!() };
}

describe("open worker profile additions", () => {
  it("preserves strict policy bytes including root deny and workspace metadata rules", () => {
    const rendered = renderHostedOpenWorkerProfilesToml(renderInput);
    const additions = ['"/opt/nodejs" = "read"', '"/srv/workers/jobs" = "read"',
      '"/project.tool/home" = "write"', '"/project.tool/tmp" = "write"',
      '"/srv/workers/jobs/private" = "deny"'];
    expect(rendered.split("\n").filter(line => !additions.includes(line)).join("\n")).toBe(strictProfilesToml);
    for (const profile of ["read", "write"]) expect(rendered).toContain(
      `[permissions.hosted-project-${profile}.filesystem]\n${additions.join("\n")}\n":root" = "deny"`);
    expect(rendered.match(/":root" = "deny"/g)).toHaveLength(2);
    expect(rendered).toContain('".git" = "read"');
    expect(rendered).toContain('".codex" = "read"');
    expect(rendered).not.toContain("danger-full-access");
    expect(rendered).not.toContain('"/project.tool/git"');
  });
  it("grants Git config only in the write profile with commit authorization", () => {
    const rendered = renderHostedOpenWorkerProfilesToml({ ...renderInput, commitAllowed: true });
    const [read, write] = rendered.split("[permissions.hosted-project-write.filesystem]");
    expect(read).not.toContain('"/project.tool/git"');
    expect(write?.match(/"\/project.tool\/git" = "write"/g)).toHaveLength(1);
  });
  it("skips an identical existing key and refuses a conflicting grant", () => {
    const header = "[permissions.hosted-project-read.filesystem]";
    const existing = strictProfilesToml.replace(header, `${header}\n"/opt/nodejs" = "read"`);
    expect(renderHostedOpenWorkerProfilesToml({ ...renderInput, strictProfilesToml: existing })
      .match(/"\/opt\/nodejs" = "read"/g)).toHaveLength(2);
    expect(() => renderHostedOpenWorkerProfilesToml({ ...renderInput,
      strictProfilesToml: existing.replace('"/opt/nodejs" = "read"', '"/opt/nodejs" = "write"') }))
      .toThrow(error("profile_key_conflict"));
  });
  it("fails closed on section and root policy drift", () => {
    for (const toml of [strictProfilesToml.replace("[permissions.hosted-project-read.filesystem]", ""),
      `${strictProfilesToml}\n[permissions.hosted-project-read.filesystem]\n`]) {
      expect(() => renderHostedOpenWorkerProfilesToml({ ...renderInput, strictProfilesToml: toml }))
        .toThrow(error("profile_section_drift"));
    }
    expect(() => renderHostedOpenWorkerProfilesToml({ ...renderInput,
      strictProfilesToml: strictProfilesToml.replaceAll('":root" = "deny"', '":root" = "read"') }))
      .toThrow(error("profile_root_not_denied"));
  });
  it("rejects broadened read roots, non-normalized paths, and tool placement", () => {
    for (const readRoot of ["/", "/srv", "/srv/workers"]) expect(() =>
      renderHostedOpenWorkerProfilesToml({ ...renderInput, readRoots: [readRoot] })).toThrow(error("read_root_forbidden"));
    for (const path of ["project", "/project/", "/project/../elsewhere"]) expect(() =>
      renderHostedOpenWorkerProfilesToml({ ...renderInput, workspacePath: path })).toThrow(error("path_not_normalized"));
    for (const toolRoot of ["/project/tools", "/project", "/other"]) expect(() =>
      renderHostedOpenWorkerProfilesToml({ ...renderInput, toolRoot })).toThrow(error("tool_root_placement"));
  });
});

describe("open worker layout custody", () => {
  // Binding tests below fail when the corresponding layout guard is removed.
  it("keeps missing in-root directory masks and collapses existing and missing nested masks", () => {
    const input = fixture();
    const parent = join(input.readRoots[0]!, "private");
    mkdirSync(join(parent, "nested"), { recursive: true });
    const later = join(input.readRoots[0]!, "created-later");
    input.deniedRoots = [parent, join(parent, "nested"), later, join(later, "nested"), "/outside-not-admitted"];
    expect(fixtureDenies(input)).toEqual([parent, later]);
  });
  it("refuses file or symlink masks beneath read roots", () => {
    const input = fixture();
    const file = join(input.readRoots[0]!, "file");
    const link = join(input.readRoots[0]!, "link");
    writeFileSync(file, "test");
    symlinkSync(input.toolRoot, link);
    for (const path of [file, link]) expect(() => assertHostedOpenWorkerLayout({ ...input, deniedRoots: [path] }))
      .toThrow(error("deny_root_not_directory"));
  });
  it("refuses denied-root aliases before admitting their real target beneath a read root", () => {
    const input = fixture();
    const target = join(input.readRoots[0]!, "private");
    mkdirSync(target);
    const alias = `${input.workspacePath}.alias`;
    symlinkSync(input.readRoots[0]!, alias);
    expect(() => assertHostedOpenWorkerLayout({ ...input, deniedRoots: [join(alias, "private")] }))
      .toThrow(error("deny_root_alias_mismatch"));
  });
  it("ignores denied-root symlinks outside read roots", () => {
    const input = fixture();
    const target = `${input.workspacePath}.outside`;
    const link = `${target}.link`;
    mkdirSync(target);
    symlinkSync(target, link);
    expect(fixtureDenies({ ...input, deniedRoots: [link] })).toEqual([]);
  });
  it.each(["var/run", "bin"])("ignores %s-style denied-root aliases outside read roots", spelling => {
    const input = fixture();
    const system = `${input.workspacePath}.system`;
    const target = join(system, "usr", "target");
    const alias = join(system, spelling);
    mkdirSync(join(target, "private"), { recursive: true });
    mkdirSync(join(alias, ".."), { recursive: true });
    symlinkSync(target, alias);
    expect(fixtureDenies({ ...input, deniedRoots: [join(alias, "private")] })).toEqual([]);
  });
  it("refuses missing denied roots whose nearest existing ancestor aliases into a read root", () => {
    const input = fixture();
    const alias = `${input.workspacePath}.alias`;
    symlinkSync(input.readRoots[0]!, alias);
    expect(() => assertHostedOpenWorkerLayout({ ...input, deniedRoots: [join(alias, "later", "nested")] }))
      .toThrow(error("deny_root_alias_mismatch"));
  });
  it("rejects masks containing reads and outside masks overlapping writes", () => {
    const input = fixture();
    for (const path of ["/isolated", "/isolated/read"]) {
      expect(() => assertHostedOpenWorkerLayout({ ...input, readRoots: ["/isolated/read"], deniedRoots: [path] }))
        .toThrow(error("denied_root_contains_read_root"));
    }
    expect(() => assertHostedOpenWorkerLayout({ ...input, deniedRoots: [`${input.toolRoot}/home/private`] }))
      .toThrow(error("write_root_secret_overlap"));
  });
  it("rejects denied directories overlapping writes even beneath a read root", () => {
    const input = fixture();
    const readRoot = input.workspacePath.slice(0, input.workspacePath.lastIndexOf("/"));
    for (const denied of [input.workspacePath, `${input.workspacePath}/secret`, readRoot]) expect(() =>
      assertHostedOpenWorkerLayout({ ...input, readRoots: [readRoot], deniedRoots: [denied] }))
      .toThrow(error("write_root_secret_overlap"));
  });
  it("rejects every direction of secret overlap with reads or writes", () => {
    const input = fixture();
    for (const write of [input.workspacePath, input.toolRoot, `${input.toolRoot}/home`, `${input.toolRoot}/tmp`, `${input.toolRoot}/git`]) {
      for (const secret of [write, `${write}/secret`, write.slice(0, write.lastIndexOf("/"))]) expect(() =>
        assertHostedOpenWorkerLayout({ ...input, secretRoots: [secret] })).toThrow(error("write_root_secret_overlap"));
    }
    for (const secret of [input.readRoots[0]!, `${input.readRoots[0]}/secret`]) expect(() =>
      assertHostedOpenWorkerLayout({ ...input, secretRoots: [secret] })).toThrow(error("read_root_secret_overlap"));
    expect(() => assertHostedOpenWorkerLayout({ ...input, readRoots: ["/isolated/read"], secretRoots: ["/isolated"] }))
      .toThrow(error("read_root_secret_overlap"));
  });
  it("requires private owned real tool directories", () => {
    const input = fixture();
    expect(() => assertHostedOpenWorkerLayout({ ...input, ownerUid: input.ownerUid + 1 })).toThrow(error("tool_root_owner"));
    chmodSync(input.toolRoot, 0o755);
    expect(() => assertHostedOpenWorkerLayout(input)).toThrow(error("tool_root_mode"));
    chmodSync(input.toolRoot, 0o700);
    rmSync(`${input.toolRoot}/home`, { recursive: true });
    symlinkSync(input.workspacePath, `${input.toolRoot}/home`);
    expect(() => assertHostedOpenWorkerLayout(input)).toThrow(error("tool_root_not_directory"));
  });
  it("requires Git state exactly for commits and forbids a tool workspace", () => {
    const input = fixture();
    expect(() => assertHostedOpenWorkerLayout({ ...input, commitAllowed: true })).toThrow(error("tool_git_presence"));
    mkdirSync(`${input.toolRoot}/git`);
    expect(() => assertHostedOpenWorkerLayout(input)).toThrow(error("tool_git_presence"));
    expect(fixtureDenies({ ...input, commitAllowed: true })).toEqual([]);
    rmSync(`${input.toolRoot}/git`, { recursive: true });
    writeFileSync(`${input.toolRoot}/.git`, "gitdir: /elsewhere");
    expect(() => assertHostedOpenWorkerLayout(input)).toThrow(error("tool_root_is_workspace"));
  });
  it("rejects empty, relative, workspace, tool and job PATH entries", () => {
    const input = fixture();
    for (const path of ["", "bin", "/usr/bin:", input.workspacePath, `${input.workspacePath}/bin`,
      input.toolRoot, `${input.toolRoot}/bin`, "/srv/workers/jobs", "/srv/workers/jobs/other/bin", "/usr/bin/../bin"]) {
      expect(() => assertHostedOpenWorkerLayout({ ...input, pathEnv: path })).toThrow(error("path_entry_unsafe"));
    }
  });
});
