import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRootDescriptor, closeOriginalHostedDependencyRootDescriptor } from "./hosted-current-dependency-origin";
import type { HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
/** Opaque view only. No issuer/map/open/association lives here. A reflected or
 * direct constructor with a caller Symbol cannot resolve under original B's
 * lexical Symbol, nor become a member of that sole original-origin map. */
export class OriginalHostedDependencyRootDescriptor {
  readonly #origin: CurrentHostedDependencyOrigin;
  readonly #material: HostedDependencyRootDescriptorMaterial;
  readonly #access: symbol;
  constructor(origin: CurrentHostedDependencyOrigin, material: HostedDependencyRootDescriptorMaterial, access: symbol) {
    this.#origin = origin; this.#material = material; this.#access = access;
  }
  static resolve(resource: OriginalHostedDependencyRootDescriptor, access: symbol) {
    if (resource.#access !== access) throw new Error("hosted_dependency_current_origin_unresolved");
    return {origin:resource.#origin,material:resource.#material};
  }
  get fd(): number { return readOriginalHostedDependencyRootDescriptor(this); }
  close(): void { closeOriginalHostedDependencyRootDescriptor(this); }
}
Object.freeze(OriginalHostedDependencyRootDescriptor); Object.freeze(OriginalHostedDependencyRootDescriptor.prototype);
