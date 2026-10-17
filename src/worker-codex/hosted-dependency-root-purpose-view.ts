import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencyRootPurpose } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
// Opaque immutable view only. Every genuine authority lookup remains in the original contexts map.
export class OriginalHostedDependencyRootPurpose {
  readonly #origin:CurrentHostedDependencyOrigin; readonly #purpose:HostedDependencyRootPurpose; readonly #access:symbol;
  constructor(origin:CurrentHostedDependencyOrigin,purpose:HostedDependencyRootPurpose,access:symbol) {
    this.#origin = origin; this.#purpose = purpose; this.#access = access; Object.freeze(this);
  }
  static origin(context:OriginalHostedDependencyRootPurpose,purpose:HostedDependencyRootPurpose,access:symbol):CurrentHostedDependencyOrigin {
    if (typeof context !== "object" || context === null || !(#access in context) || context.#access !== access || context.#purpose !== purpose) throw new Error("hosted_dependency_current_origin_unresolved"); return context.#origin;
  }
}
Object.freeze(OriginalHostedDependencyRootPurpose); Object.freeze(OriginalHostedDependencyRootPurpose.prototype);
