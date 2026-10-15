export function freezeFacts<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeFacts(child); if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
