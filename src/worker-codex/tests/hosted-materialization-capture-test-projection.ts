import { join } from "node:path";
import type { open } from "node:fs/promises";
type Path = Parameters<typeof open>[0];
type Fixture = { captureAncestry: boolean; captureDirectories: Map<number,string> };
function child(path: string, fixture: Fixture): string | undefined {
  const selected = /^\/proc\/self\/fd\/([0-9]+)\/(.+)$/.exec(path);
  const parent = selected ? fixture.captureDirectories.get(Number(selected[1])) : undefined;
  return parent === undefined ? undefined : join(parent,selected![2]!);
}
/** TEST transport only: exact logical ancestors map to real disposable fixture
 * directories. Actual FileHandle.stat/read/close and fdinfo are unchanged. */
export function projectCapturePath(path: Path, fixture: Fixture, local: (path:string)=>string, manifestScratch: string): Path {
  if (typeof path === "string" && (path === manifestScratch || path.startsWith(manifestScratch+"/"))) return local(path);
  if (!fixture.captureAncestry || typeof path !== "string") return path;
  const logical = path === "/" ? "/" : child(path,fixture);
  return logical === undefined ? path : local(logical);
}
export function retainCapturePath(fd: number, path: Path, fixture: Fixture): void {
  if (!fixture.captureAncestry || typeof path !== "string") return;
  const logical = path === "/" ? "/" : child(path,fixture);
  if (logical !== undefined) fixture.captureDirectories.set(fd,logical);
}
