import type { CodexAppServerProcessFactory } from "./app-server/application/app-server-process-port";
import { AppServerExecutionLifetime } from "./app-server/application/app-server-child-lifetime";
import { readHostedMimoCodingEgressFactoryOrigin, assertHostedMimoCodingEgressFactory } from "./app-server/adapters/egress-bound-process";
import { assertHostedMimoCodingWorkerOriginCurrent, type HostedMimoCodingWorkerOrigin } from "./hosted-mimo-worker-origin";

declare const authorityBrand: unique symbol;
export type HostedMimoCodingEngineAuthority = Readonly<{ [authorityBrand]: true }>;
type Binding = Readonly<{ processFactory: CodexAppServerProcessFactory; executionLifetime: AppServerExecutionLifetime;
  workspacePath: string; model: string; codexBinaryPath: string }>;
const issued = new WeakMap<HostedMimoCodingEngineAuthority, Binding & { origin: HostedMimoCodingWorkerOrigin; deadlineEpochMs: number }>();
function invalid(): never { throw new Error("hosted_mimo_coding_engine_authority_invalid"); }
/** Constructor provenance is retained by the concrete provider adapter and its
 * specific egress wrapper; arbitrary callbacks cannot register themselves. */
export function prepareHostedMimoCodingEngineAuthority(input: Binding): HostedMimoCodingEngineAuthority {
  const binding = Object.freeze({ processFactory: input.processFactory, executionLifetime: input.executionLifetime,
    workspacePath: input.workspacePath, model: input.model, codexBinaryPath: input.codexBinaryPath });
  const origin = readHostedMimoCodingEgressFactoryOrigin(binding.processFactory);
  if (!origin || !(binding.executionLifetime instanceof AppServerExecutionLifetime) || binding.workspacePath !== origin.workspacePath || binding.model !== origin.model ||
      binding.codexBinaryPath !== origin.codexBinaryPath || origin.maxGoalTurns !== 64 || binding.executionLifetime.maxGoalTurns !== 64 ||
      binding.executionLifetime.childBudget !== undefined || binding.executionLifetime.remainingMs() > origin.taskTimeoutMs) invalid();
  const authority = Object.freeze({}) as HostedMimoCodingEngineAuthority;
  issued.set(authority, Object.freeze({ ...binding, origin, deadlineEpochMs: binding.executionLifetime.deadlineEpochMs }));
  assertHostedMimoCodingEngineAuthority(authority);
  return authority;
}
export function assertHostedMimoCodingEngineAuthority(authority: HostedMimoCodingEngineAuthority | undefined,
  expected?: { readonly [K in keyof Binding]?: Binding[K] | undefined }): void {
  const retained = authority && issued.get(authority);
  if (!retained) invalid();
  if (retained.executionLifetime.maxGoalTurns !== 64 || retained.executionLifetime.childBudget !== undefined ||
      retained.executionLifetime.deadlineEpochMs !== retained.deadlineEpochMs) invalid();
  if (retained.workspacePath !== retained.origin.workspacePath || retained.model !== retained.origin.model ||
      retained.codexBinaryPath !== retained.origin.codexBinaryPath) invalid();
  retained.executionLifetime.assertActive();
  assertHostedMimoCodingWorkerOriginCurrent(retained.origin);
  assertHostedMimoCodingEgressFactory(retained.processFactory, retained.origin);
  if (expected) for (const key of ["processFactory", "executionLifetime", "workspacePath", "model", "codexBinaryPath"] as const) {
    if (Object.hasOwn(expected, key) && expected[key] !== retained[key]) invalid();
  }
}
