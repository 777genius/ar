/** Fixed Host installation recipes; inventory identity validation stays in core. */
import { SYSTEM_BUS_CONFIG_PATH, SYSTEM_BUS_ENDPOINT, SYSTEM_BUS_EXECUTABLE } from "../../../core/host-infrastructure/system-bus-infrastructure";

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
  <listen>systemd:</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <deny user="*"/>
    <allow user="root"/>
    <deny own="*"/>
    <deny send_type="method_call"/>
  </policy>
  <policy user="root">
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
