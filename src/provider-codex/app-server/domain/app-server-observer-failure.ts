import { validatedNamespaceFailure, type AppServerNamespaceFailure } from "./app-server-namespace-failure";
/** Source-owned failure locations only. None of these observations admit work. */
export enum AppServerObserverPoint {
  ImageAlias = "image_alias", ImageRoot = "image_root", ImageSource = "image_source", ImageOpen = "image_open", ImageView = "image_view",
  ImageElf = "image_elf", ImageHash = "image_hash", ImageRejoin = "image_rejoin", ImageClose = "image_close",
  Namespace = "namespace", Native = "native", UnitInventory = "unit_inventory", UnitQuery = "unit_query", UnitDecode = "unit_decode",
  UnitArrays = "unit_arrays", UnitLifecycle = "unit_lifecycle", UnitGuards = "unit_guards", UnitRequery = "unit_requery", UnitRejoin = "unit_rejoin",
  BusInitial = "bus_initial", BusPins = "bus_pins", BusService = "bus_service", BusSocket = "bus_socket", BusProcess = "bus_process",
  BusEndpoint = "bus_endpoint", BusListener = "bus_listener", BusManager = "bus_manager", BusArrays = "bus_arrays", BusManagedArrays = "bus_managed_arrays",
  BusRecheck = "bus_recheck", BusFinalManager = "bus_final_manager", BusFinalProcess = "bus_final_process", BusFinalPins = "bus_final_pins", BusFinalListener = "bus_final_listener",
  ArrayPin = "array_pin", ArrayUnit = "array_unit", ArrayRead = "array_read", ArrayPolicy = "array_policy", ArrayFinalPin = "array_final_pin", ManagerRead = "manager_read",
}
export enum AppServerObserverCode { Unknown = "unknown", Boundary = "fd_boundary", Bus = "bus", Arrays = "arrays" }
export enum AppServerObserverErrno { None = "none", Unknown = "unknown", ENOENT = "ENOENT", ESRCH = "ESRCH", EACCES = "EACCES",
  EPERM = "EPERM", EIO = "EIO", ENOTDIR = "ENOTDIR", EBADF = "EBADF", ETIMEDOUT = "ETIMEDOUT", ENOBUFS = "ENOBUFS" }
export interface AppServerObserverFailure { readonly point: AppServerObserverPoint; readonly code: AppServerObserverCode;
  readonly errno: AppServerObserverErrno; readonly elapsedMsCapped: number; readonly namespace?: AppServerNamespaceFailure; }
const failures = new WeakMap<object, AppServerObserverFailure>();
/** Reads own data fields once; no stack, message accessor, cause or raw value survives. */
export function closedObserverFailure(error: unknown, point: AppServerObserverPoint, elapsedMsCapped: number): AppServerObserverFailure {
  let code = AppServerObserverCode.Unknown, errno = AppServerObserverErrno.None;
  try {
    if (typeof error === "object" && error !== null) {
      const retained = failures.get(error); if (retained) return retained;
      const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
      code = message === "hosted_fd_boundary_unresolved" ? AppServerObserverCode.Boundary :
        message === "system_bus_infrastructure_unqualified" ? AppServerObserverCode.Bus :
        message === "systemd_service_arrays_unqualified" ? AppServerObserverCode.Arrays : AppServerObserverCode.Unknown;
      const value = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (value !== undefined) errno = Object.values(AppServerObserverErrno).includes(value) ? value : AppServerObserverErrno.Unknown;
    }
  } catch { code = AppServerObserverCode.Unknown; errno = AppServerObserverErrno.Unknown; }
  return Object.freeze({ point: Object.values(AppServerObserverPoint).includes(point) ? point : AppServerObserverPoint.Native,
    code, errno, elapsedMsCapped: Number.isSafeInteger(elapsedMsCapped) && elapsedMsCapped >= 0 && elapsedMsCapped <= 60000 ? elapsedMsCapped : 0 });
}
export function validatedObserverFailure(value: unknown): AppServerObserverFailure | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value), point = fields.point?.value, code = fields.code?.value;
    const errno = fields.errno?.value, elapsedMsCapped = fields.elapsedMsCapped?.value;
    if (!Object.values(AppServerObserverPoint).includes(point) || !Object.values(AppServerObserverCode).includes(code) ||
        !Object.values(AppServerObserverErrno).includes(errno) || typeof elapsedMsCapped !== "number" ||
        !Number.isSafeInteger(elapsedMsCapped) || elapsedMsCapped < 0 || elapsedMsCapped > 60000) return undefined;
    const namespace = fields.namespace?.value === undefined ? undefined : validatedNamespaceFailure(fields.namespace.value);
    if (fields.namespace?.value !== undefined && (!namespace || point !== AppServerObserverPoint.Namespace)) return undefined;
    return Object.freeze({ point, code, errno, elapsedMsCapped, ...(namespace ? { namespace } : {}) });
  } catch { return undefined; }
}
export function retainObserverFailure(error: unknown, point: AppServerObserverPoint, elapsedMsCapped: number, wrapped?: object): void {
  try {
    const fact = closedObserverFailure(error, point, elapsedMsCapped);
    if (typeof error === "object" && error !== null && !failures.has(error)) failures.set(error, fact);
    if (wrapped) failures.set(wrapped, fact);
  } catch { /* Diagnostic collection must not change the original rejection. */ }
}

export function retainNamespaceObserverFailure(error: object, namespace: AppServerNamespaceFailure): void {
  try {
    const selected = validatedNamespaceFailure(namespace);
    if (selected && !failures.has(error)) failures.set(error, Object.freeze({ ...closedObserverFailure(error, AppServerObserverPoint.Namespace, 0), namespace: selected }));
  } catch { /* Shape collection never replaces the existing rejection. */ }
}
