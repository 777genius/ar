/** Public compatibility composition. Internal core consumers use core/index.
 * Host installation recipes are owned by the provider adapter; retaining these
 * legacy exports here avoids adding an outward dependency to the core layer. */
export * from "./core/index";
/** @deprecated Import Host recipes from @vioxen/subscription-runtime/provider-codex. */
export { SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_CONFIG, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT } from "./provider-codex/app-server/adapters/system-bus-configuration";
