import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
export class OriginalHostedOrdinaryProviderTerminal {
  readonly #origin:CurrentHostedDependencyOrigin;readonly #access:symbol;
  constructor(origin:CurrentHostedDependencyOrigin,access:symbol) {this.#origin=origin;this.#access=access;}
  static hasBrand(value:unknown):value is OriginalHostedOrdinaryProviderTerminal {
    return value!==null && typeof value==="object" && #origin in value;
  }
  static resolve(value:OriginalHostedOrdinaryProviderTerminal,access:symbol):CurrentHostedDependencyOrigin {
    if (!OriginalHostedOrdinaryProviderTerminal.hasBrand(value) || value.#access!==access) throw new Error("hosted_dependency_current_origin_unresolved");return value.#origin;
  }
}
Object.freeze(OriginalHostedOrdinaryProviderTerminal.prototype);Object.freeze(OriginalHostedOrdinaryProviderTerminal);
