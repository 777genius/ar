import type { ProviderTaskResult, RedactorPort } from "@vioxen/subscription-runtime/core";
import { safeNativeWebFromError, usageFromError } from "./app-server/domain/app-server-usage-error";
import { codexExecutionFailure } from "./codex-json-execution-engine";
import type { MimoProxyFailure } from "./mimo-proxy-failure";
import { finishReasonForFailure } from "./codex-json-agent-finish-reason";

/** Shared failure projection for first turns and retained managed runs. */
export function codexDriverFailure(input: {
  error: unknown;
  evidenceError: unknown;
  redactor: RedactorPort;
  startedAt: number;
  proxyFailure?: MimoProxyFailure | undefined;
  priorProxyFailure?: MimoProxyFailure | undefined;
}): Extract<ProviderTaskResult, { readonly status: "failed" }> {
  const failure = codexExecutionFailure(input.error, input.redactor);
  const proxy = input.proxyFailure;
  const nativeWeb = safeNativeWebFromError(input.evidenceError, input.redactor);
  const usage = usageFromError(input.evidenceError);
  const details = proxy && proxy !== input.priorProxyFailure ? {
    ...failure.failure.details,
    mimoProxyReason: proxy.reason, mimoProxyPhase: proxy.phase,
    mimoProxyElapsedMs: String(proxy.elapsed_ms), mimoProxyRequestNumber: String(proxy.request_number),
    ...(proxy.upstream_status === undefined ? {} : { mimoUpstreamStatus: String(proxy.upstream_status) }),
    ...(proxy.transport_code === undefined ? {} : { mimoTransportCode: proxy.transport_code }),
    ...(proxy.validation_code === undefined ? {} : { mimoValidationCode: proxy.validation_code }),
  } : undefined;
  if (details) input.redactor.assertNoKnownSecret(JSON.stringify(details), "MiMo proxy failure context");
  return {
    ...failure,
    ...(details ? { failure: { ...failure.failure, details } } : {}),
    telemetry: {
      durationMs: Date.now() - input.startedAt,
      finishReason: finishReasonForFailure(failure.failure.code),
      ...(nativeWeb === undefined ? {} : { nativeWeb }),
      ...(usage === undefined ? {} : { usage }),
    },
  };
}
