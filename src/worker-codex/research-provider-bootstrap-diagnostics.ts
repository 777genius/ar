/** A finite transport protocol, not a general provider stderr logger. */
export function createResearchProviderBootstrapDiagnostics(emit: (safeMessage: string) => void) {
  let pending = "";
  let discarded = false;
  let latest: string | undefined;
  let emitted = 0;
  const consume = (line: string) => {
    let safeMessage: string | undefined;
    const transition = /^research_root_transition_failed phase=(descriptor-validation|pivot|detach-old-root|namespace-transition) code=([0-9]{1,3})$/.exec(line);
    if (transition && Number(transition[2]) <= 255) {
      safeMessage = `research_root_transition_failed phase=${transition[1]} code=${Number(transition[2])}`;
    } else if (line.startsWith("{")) {
      try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return;
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.some(key => !["event", "legacyCode", "cause", "diagnostic", "assemblyLine", "assemblyColumn"].includes(key))) return;
        if (record.event !== "research_provider_root_assembly_failed" ||
            !(record.legacyCode === "unclassified" || (Number.isInteger(record.legacyCode) && Number(record.legacyCode) >= 0 && Number(record.legacyCode) <= 7)) ||
            typeof record.cause !== "string" || typeof record.diagnostic !== "string") return;
        const location = record.assemblyLine !== undefined || record.assemblyColumn !== undefined;
        if (location && ![record.assemblyLine, record.assemblyColumn].every(n => Number.isInteger(n) && Number(n) >= 1 && Number(n) <= 999999)) return;
        // Cause/diagnostic text belongs to the producer; never copy it across this boundary.
        safeMessage = `research_provider_root_assembly_failed legacyCode=${record.legacyCode}${location ? ` assemblyLine=${record.assemblyLine} assemblyColumn=${record.assemblyColumn}` : ""}`;
      } catch { return; }
    }
    if (safeMessage !== undefined && emitted < 8 && safeMessage !== latest) {
      emitted += 1;
      latest = safeMessage;
      emit(safeMessage);
    }
  };
  return {
    push(chunk: string): void {
      // Scan incrementally without retaining an arbitrarily large stderr chunk.
      for (const character of chunk) {
        if (character === "\n") {
          if (!discarded) consume(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
          pending = ""; discarded = false;
        } else if (!discarded) {
          if (pending.length >= 4096) { pending = ""; discarded = true; }
          else pending += character;
        }
      }
    },
    finish(): void { if (!discarded && pending) consume(pending); pending = ""; discarded = false; },
    latest(): string | undefined { return latest; },
  };
}

/** Stderr completion, rather than process exit, owns final frame completion. */
export function observeResearchProviderBootstrapDiagnostics(stream: {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  once(event: "end" | "close", listener: () => void): unknown;
}, publish: (safeMessage: string) => void): void {
  const decoder = createResearchProviderBootstrapDiagnostics(publish);
  stream.on("data", chunk => decoder.push(String(chunk)));
  stream.once("end", () => decoder.finish());
  stream.once("close", () => decoder.finish());
}
