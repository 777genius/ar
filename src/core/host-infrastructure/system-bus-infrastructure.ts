/** Closed infrastructure identity. Pins describe independently staged bytes;
 * parsing never proves that a bus, process or permission exists. */
export enum SystemBusInfrastructureRole { SystemBus = "system-bus" }
export const SYSTEM_BUS_ENDPOINT = "/run/dbus/system_bus_socket";
export const SYSTEM_BUS_CONFIG_PATH = "/etc/subscription-runtime/system-bus/bus.conf";
export const SYSTEM_BUS_EXECUTABLE = "/usr/bin/dbus-daemon";
export const SYSTEM_BUS_CONTROL_GROUP = "/system.slice/dbus.service";
export const SYSTEM_BUS_ARGUMENTS: readonly string[] = Object.freeze([
  `--config-file=${SYSTEM_BUS_CONFIG_PATH}`, "--address=systemd:", "--nofork", "--nopidfile", "--nosyslog",
]);
export const SYSTEM_BUS_SERVICE_FRAGMENT = `[Unit]
Description=Finite runtime system bus
DefaultDependencies=no
Requires=dbus.socket
After=dbus.socket
[Service]
Type=notify
NotifyAccess=main
ExecStart=${SYSTEM_BUS_EXECUTABLE} ${SYSTEM_BUS_ARGUMENTS.join(" ")}
Restart=no
KillMode=control-group
StandardOutput=null
StandardError=null
`;
export const SYSTEM_BUS_SOCKET_FRAGMENT = `[Unit]
Description=Finite runtime system bus socket
DefaultDependencies=no
[Socket]
ListenStream=${SYSTEM_BUS_ENDPOINT}
Service=dbus.service
Accept=no
SocketMode=0600
DirectoryMode=0755
RemoveOnStop=yes
`;
const handshakeMembers = ["Hello", "RequestName", "ReleaseName", "GetNameOwner", "NameHasOwner", "AddMatch", "RemoveMatch",
  "GetId", "GetConnectionUnixProcessID", "GetConnectionUnixUser", "GetConnectionCredentials"];
/** No includes, activation directories/helper, reload, activation environment or
 * systemd-activation option. Root clients are trusted runtime machinery, not
 * workload identities; filesystem/FD boundaries separately exclude workloads. */
export const SYSTEM_BUS_CONFIG = `<busconfig>
  <type>system</type>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <deny user="*"/>
    <deny own="*"/>
    <deny send_type="method_call"/>
  </policy>
  <policy user="root">
    <allow user="root"/>
    <allow own="org.freedesktop.systemd1"/>
    <allow send_destination="org.freedesktop.systemd1"/>
${handshakeMembers.map(member => `    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus" send_member="${member}"/>`).join("\n")}
    <allow send_type="method_return"/>
    <allow send_type="error"/>
    <allow send_type="signal"/>
    <allow receive_type="*"/>
  </policy>
</busconfig>
`;
export type SystemBusFilePin = Readonly<{ path: string; sha256: string }>;
export type SystemBusInfrastructure = Readonly<{
  version: 1; role: SystemBusInfrastructureRole.SystemBus;
  service: Readonly<{ name: "dbus.service"; controlGroup: typeof SYSTEM_BUS_CONTROL_GROUP; fragmentPath: string; fragmentSha256: string }>;
  socket: Readonly<{ name: "dbus.socket"; endpoint: typeof SYSTEM_BUS_ENDPOINT; fragmentPath: string; fragmentSha256: string }>;
  config: SystemBusFilePin; executable: SystemBusFilePin; elfClosure: readonly SystemBusFilePin[];
}>;
function failure(): never { throw new Error("system_bus_infrastructure_invalid"); }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) failure();
  return value as Record<string, unknown>;
}
function path(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) ||
      value.split("/").some(part => part === "." || part === "..")) failure();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) failure();
  return value;
}
function pin(value: unknown): SystemBusFilePin {
  const row = record(value, "path,sha256");
  return Object.freeze({ path: path(row.path), sha256: hash(row.sha256) });
}
export function parseSystemBusInfrastructure(value: unknown): SystemBusInfrastructure {
  const row = record(value, "config,elfClosure,executable,role,service,socket,version");
  if (row.version !== 1 || row.role !== SystemBusInfrastructureRole.SystemBus) failure();
  const service = record(row.service, "controlGroup,fragmentPath,fragmentSha256,name");
  const socket = record(row.socket, "endpoint,fragmentPath,fragmentSha256,name");
  if (service.name !== "dbus.service" || service.controlGroup !== SYSTEM_BUS_CONTROL_GROUP ||
      socket.name !== "dbus.socket" || socket.endpoint !== SYSTEM_BUS_ENDPOINT) failure();
  const config = pin(row.config), executable = pin(row.executable);
  if (config.path !== SYSTEM_BUS_CONFIG_PATH || executable.path !== SYSTEM_BUS_EXECUTABLE ||
      !Array.isArray(row.elfClosure) || row.elfClosure.length < 2 || row.elfClosure.length > 64) failure();
  const closure = row.elfClosure.map(pin);
  if (new Set(closure.map(file => file.path)).size !== closure.length ||
      !closure.some(file => file.path === executable.path && file.sha256 === executable.sha256) ||
      !closure.some(file => /^\/usr\/lib\/[^/]+\/ld-linux-x86-64\.so\.2$/.test(file.path))) failure();
  const fragmentPaths = [path(service.fragmentPath), path(socket.fragmentPath)];
  if (new Set([...fragmentPaths, config.path, ...closure.map(file => file.path)]).size !== 3 + closure.length) failure();
  return Object.freeze({ version: 1, role: SystemBusInfrastructureRole.SystemBus,
    service: Object.freeze({ name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP,
      fragmentPath: fragmentPaths[0]!, fragmentSha256: hash(service.fragmentSha256) }),
    socket: Object.freeze({ name: "dbus.socket", endpoint: SYSTEM_BUS_ENDPOINT,
      fragmentPath: fragmentPaths[1]!, fragmentSha256: hash(socket.fragmentSha256) }),
    config, executable, elfClosure: Object.freeze(closure) });
}

/** Inventory revision 3 requires exactly this role; old revisions cannot carry
 * an ignored field. Callers retain their own independent full inventory parser. */
export function readSystemBusInfrastructureField(inventory: Readonly<Record<string, unknown>>): SystemBusInfrastructure | undefined {
  if (inventory.schemaVersion === 3 || inventory.schemaVersion === 4) return parseSystemBusInfrastructure(inventory.systemBusInfrastructure);
  if ((inventory.schemaVersion !== 1 && inventory.schemaVersion !== 2) || "systemBusInfrastructure" in inventory) failure();
  return undefined;
}
