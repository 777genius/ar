export function projectControlAdmissionOwnedPaths(
  value: unknown,
): readonly string[] | undefined {
  if (!value || typeof value !== "object" || !("contract" in value)) return undefined;
  const contract = value.contract;
  if (!contract || typeof contract !== "object" || !("ownedPaths" in contract)) {
    return undefined;
  }
  return Array.isArray(contract.ownedPaths) && contract.ownedPaths.length > 0 &&
      contract.ownedPaths.every((path): path is string => typeof path === "string")
    ? contract.ownedPaths
    : undefined;
}
