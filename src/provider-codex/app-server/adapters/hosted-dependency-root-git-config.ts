/** Data-only fixed grammar, shared by admission and the retained root context.
 * It accepts no include/filter/hooks/credential/submodule/extension directive.
 */
export function assertHostedDependencyRootGitConfigBytes(bytes: Uint8Array): void {
  const config = Buffer.from(bytes).toString("utf8");
  if (bytes.length > 65536 || !Buffer.from(config).equals(Buffer.from(bytes)) || config.includes("\0")) invalid();
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[(core|user)\]$/i.test(line)) { section = line.slice(1,-1).toLowerCase(); continue; }
    const setting = /^([a-zA-Z]+)\s*=\s*(.*)$/.exec(line);
    if (!setting || (section === "core" ? !["repositoryformatversion","filemode","bare","logallrefupdates"].includes(setting[1]!.toLowerCase()) :
        section === "user" ? !["name","email"].includes(setting[1]!.toLowerCase()) : true)) invalid();
    if (section === "core" && setting[1]!.toLowerCase() === "bare" && setting[2]!.toLowerCase() !== "false") invalid();
  }
}
function invalid(): never { throw new Error("hosted_dependency_root_git_config_unsupported"); }
