import { CodexCliSessionDriver, type CodexCliSessionDriverOptions } from "../provider-codex/codex-cli-session-driver";
import type { ProviderSessionDriver } from "@vioxen/subscription-runtime/core";
import type { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
/** Fixed managed bootstrap; caller workspace/runner never selects its IO or exec. */
export class HostedManagedDependencySessionDriver extends CodexCliSessionDriver {
  readonly #materializer: HostedManagedDependencySessionMaterializer;
  constructor(options: CodexCliSessionDriverOptions, materializer: HostedManagedDependencySessionMaterializer) { super(options); this.#materializer = materializer; Object.freeze(this); }
  override refreshSession(input: Parameters<ProviderSessionDriver["refreshSession"]>[0]) { return this.#materializer.refresh(input); }
}

Object.freeze(HostedManagedDependencySessionDriver); Object.freeze(HostedManagedDependencySessionDriver.prototype);
