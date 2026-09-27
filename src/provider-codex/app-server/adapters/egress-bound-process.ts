import {
  codexProviderEgressCliConfigArgs,
  codexProviderEgressEnv,
  codexProviderEgressPolicy,
  type CodexProviderEgressPolicy,
} from "../../codex-provider-egress-policy";
import type { CodexAppServerProcessFactory } from "../application/app-server-process-port";
import { spawnCodexAppServerProcess } from "./node-app-server-process";

/** Capture the trusted policy before entering the hosted namespace. */
export function egressBoundCodexProcessFactory(
  admitted: CodexProviderEgressPolicy,
  spawn: CodexAppServerProcessFactory = spawnCodexAppServerProcess,
  options?: { readonly namedPermissions?: boolean },
): CodexAppServerProcessFactory {
  const policy = codexProviderEgressPolicy(admitted.profileId);
  return (input) => spawn({
    ...input,
    args: [...input.args, ...codexProviderEgressCliConfigArgs(policy,
      options?.namedPermissions ? { namedPermissions: true } : undefined)],
    env: { ...input.env, ...codexProviderEgressEnv(policy) },
  });
}
