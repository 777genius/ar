import type { HostedMimoCodingWorkerOrigin } from "../../hosted-mimo-worker-origin";
import {
  CodexProviderEgressProfileId,
  codexProviderEgressCliConfigArgs,
  codexProviderEgressEnv,
  codexProviderEgressPolicy,
  type CodexProviderEgressPolicy,
} from "../../codex-provider-egress-policy";
import type { CodexAppServerProcessFactory } from "../application/app-server-process-port";
import { readHostedMimoCodingProcessFactoryOrigin, spawnCodexAppServerProcess } from "./node-app-server-process";

const codingEgressFactories = new WeakMap<CodexAppServerProcessFactory, Readonly<{ factory: CodexAppServerProcessFactory; origin: HostedMimoCodingWorkerOrigin }>>();
export function assertHostedMimoCodingEgressFactory(factory: CodexAppServerProcessFactory, origin: HostedMimoCodingWorkerOrigin): void {
  const retained = codingEgressFactories.get(factory);
  if (!retained || retained.origin !== origin || readHostedMimoCodingProcessFactoryOrigin(retained.factory) !== origin) {
    throw new Error("hosted_mimo_coding_factory_invalid");
  }
}
export function readHostedMimoCodingEgressFactoryOrigin(factory: CodexAppServerProcessFactory): HostedMimoCodingWorkerOrigin | undefined {
  const retained = codingEgressFactories.get(factory);
  if (!retained) return undefined;
  assertHostedMimoCodingEgressFactory(factory, retained.origin);
  return retained.origin;
}
/** Capture the trusted policy before entering the hosted namespace. */
export function egressBoundCodexProcessFactory(
  admitted: CodexProviderEgressPolicy,
  spawn: CodexAppServerProcessFactory = spawnCodexAppServerProcess,
  options?: { readonly namedPermissions?: boolean },
): CodexAppServerProcessFactory {
  const policy = codexProviderEgressPolicy(admitted.profileId);
  const namedPermissions = options?.namedPermissions === true;
  const origin = readHostedMimoCodingProcessFactoryOrigin(spawn);
  if (origin && (policy.profileId !== CodexProviderEgressProfileId.ManagedPublicInternetV1 || !namedPermissions)) {
    throw new Error("hosted_mimo_coding_egress_invalid");
  }
  const factory: CodexAppServerProcessFactory = (input) => spawn({
    ...input,
    args: [...input.args, ...codexProviderEgressCliConfigArgs(policy,
      namedPermissions ? { namedPermissions: true } : undefined)],
    env: { ...input.env, ...codexProviderEgressEnv(policy) },
  });
  if (spawn.originalProviderStorageContext) Object.defineProperty(factory, "originalProviderStorageContext", { value: true });
  if (origin) codingEgressFactories.set(factory, Object.freeze({ factory: spawn, origin }));
  return factory;
}
