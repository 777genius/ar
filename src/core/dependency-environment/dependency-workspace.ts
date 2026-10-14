export type DependencyTreeIdentity = { readonly dev: string; readonly ino: string };
export type DependencyWorkspaceIdentity = DependencyTreeIdentity & { readonly canonicalPath: string };
export function sameDependencyTree(left: DependencyTreeIdentity, right: DependencyTreeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
export function sameDependencyWorkspace(left: DependencyWorkspaceIdentity, right: DependencyWorkspaceIdentity): boolean {
  return left.canonicalPath === right.canonicalPath && sameDependencyTree(left, right);
}
