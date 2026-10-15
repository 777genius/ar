type FileSystem = Pick<typeof import("node:fs"), "openSync" | "mkdirSync" | "rmdirSync" | "linkSync" | "unlinkSync">;

export function installationFileOperations(real: FileSystem, local: (path: string) => string) {
  return {
    openSync: (path: string, flags: Parameters<FileSystem["openSync"]>[1], mode?: Parameters<FileSystem["openSync"]>[2]) => real.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<FileSystem["mkdirSync"]>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
    linkSync: (existingPath: string, newPath: string) => real.linkSync(local(existingPath), local(newPath)),
    unlinkSync: (path: string) => real.unlinkSync(local(path)),
  };
}
