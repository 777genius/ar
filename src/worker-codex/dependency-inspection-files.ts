import { access, lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";

/** Read operations only. Callers own scope/custody; this port cannot install,
 * publish a diagnostic, create a cache, or issue launch authority. */
export type DependencyInspectionFiles = {
  readonly access: (path: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly readdir: (path: string) => Promise<readonly { readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]>;
  readonly readlink: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
};
export const legacyDependencyInspectionFiles: DependencyInspectionFiles = {
  access, lstat, readFile: path => readFile(path),
  readdir: path => readdir(path, { withFileTypes: true }), readlink, realpath,
};
