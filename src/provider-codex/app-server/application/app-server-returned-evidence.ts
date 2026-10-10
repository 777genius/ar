import type { AgentUsage, NativeWebEvidence } from "@vioxen/subscription-runtime/core";
import { AppServerUsageError, nativeWebFromError, usageFromError } from "../domain/app-server-usage-error";

/** Invocation-local facts already returned by the provider. Lifecycle failures
 * keep their original cause and precedence; this never admits late events. */
export class AppServerReturnedEvidence {
  private result: { readonly usage?: AgentUsage; readonly nativeWeb?: NativeWebEvidence } | undefined;

  capture(result: { readonly usage?: AgentUsage; readonly nativeWeb?: NativeWebEvidence }): void {
    this.result = result;
  }

  retain(error: unknown): unknown {
    if (!this.result) return error;
    const retained = new AppServerUsageError(error, usageFromError(error) ?? this.result.usage, true,
      nativeWebFromError(error) ?? this.result.nativeWeb);
    // A redaction failure's bounded empty receipt remains authoritative even if
    // cleanup subsequently closes the lifetime and wins the outer wait race.
    this.capture(retained);
    return retained;
  }
}
