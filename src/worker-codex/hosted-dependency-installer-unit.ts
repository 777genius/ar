import { spawnSync } from "node:child_process";
import { collectUnitNotFound } from "./hosted-readonly-linux-collector";

/** Fixed native installer observation, not a caller supplied stop/terminal DTO. */
export function assertInstallerTerminalUnit(unit: string): void {
  const fail = (): never => { throw new Error("dependency_installer_unit_unresolved"); };
  if (!/^subscription-runtime-installer-[a-f0-9-]{36}\.service$/.test(unit)) fail();
  const result = spawnSync("/usr/bin/systemctl", ["show", "--all", "--property=Id,LoadState,ActiveState,SubState,MainPID,ControlGroup,DropInPaths", "--", unit], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" },
  });
  if (result.error || result.signal) fail();
  if (result.status !== 0) { if (result.status === 4 && collectUnitNotFound(unit)) return; fail(); }
  const row: Record<string, string> = {};
  for (const line of result.stdout.trimEnd().split("\n")) {
    const i = line.indexOf("="), key = line.slice(0, i);
    if (i < 1 || !["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlGroup", "DropInPaths"].includes(key) || Object.hasOwn(row, key)) fail();
    row[key] = line.slice(i + 1);
  }
  if (Object.keys(row).length !== 7 || row.Id !== unit) fail();
  if (row.LoadState === "not-found") { if (collectUnitNotFound(unit)) return; fail(); }
  const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
  if (row.LoadState !== "loaded" || row.ActiveState !== "inactive" || row.SubState !== "dead" || row.MainPID !== "0" ||
      (row.ControlGroup && row.ControlGroup !== group) || row.DropInPaths !== "") fail();
}
