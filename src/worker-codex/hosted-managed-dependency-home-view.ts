import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
/** Opaque view. No path/state factory, issuer, map or independent provenance.
 * Only original B's lexical Symbol can resolve a genuine retained instance. */
export class OriginalHostedDependencySessionHome {
  readonly #origin: CurrentHostedDependencyOrigin; readonly #access: symbol;
  constructor(origin: CurrentHostedDependencyOrigin, access: symbol) { this.#origin = origin; this.#access = access; }
  static origin(home: OriginalHostedDependencySessionHome, access: symbol): CurrentHostedDependencyOrigin {
    if (home.#access !== access) throw new Error("hosted_dependency_current_origin_unresolved"); return home.#origin;
  }
}
Object.freeze(OriginalHostedDependencySessionHome); Object.freeze(OriginalHostedDependencySessionHome.prototype);
