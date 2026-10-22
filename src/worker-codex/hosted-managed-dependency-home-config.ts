import { fileURLToPath } from "node:url";
import { codexJsonHomeConfigToml } from "../provider-codex/codex-session-materializer";
import { hostedCodexPermissionProfilesToml } from "../provider-codex/hosted-codex-permissions";
import type { CodexProviderEgressPolicy } from "../provider-codex/codex-provider-egress-policy";
import type { DependencyToolGuestConfig } from "../core/dependency-environment/dependency-tool-profile";
/** Pure fixed config bytes; no IO, registration or configurable hook callback. */
export function managedDependencyHomeConfig(policy: CodexProviderEgressPolicy, executable: string, tools: DependencyToolGuestConfig): Buffer {
  const hook = fileURLToPath(new URL("./hosted-global-scan-pre-tool-hook.js",import.meta.url));
  const quote = (value:string) => "'"+value.replaceAll("'", "'\\''")+"'";
  return Buffer.from([codexJsonHomeConfigToml({providerEgressPolicy:policy,namedPermissions:true,hooksEnabled:true})
      .replace('cli_auth_credentials_store = "file"\n','cli_auth_credentials_store = "file"\nservice_tier = "default"\n')
      .replace("[features]\n","[features]\nfast_mode = false\n"),
    hostedCodexPermissionProfilesToml(policy,executable,undefined,tools),"[hooks]","[[hooks.PreToolUse]]",'matcher = "Bash|exec"',
    "[[hooks.PreToolUse.hooks]]",'type = "command"',`command = ${JSON.stringify(quote(tools.profile.node.path)+" "+quote(hook))}`,
    "timeout = 5",'statusMessage = "Checking command scope"',""].join("\n"));
}
