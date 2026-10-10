// Loaded with --import only in the isolated timeout-test child. Production
// launcher code and every other test child keep their original timer behavior.
export type TestBootstrapClockReport = {
  readonly testBootstrapDelayMs?: number | null;
  readonly testObservedInputBytes?: number;
};

const expireTimerMessage = "TEST-expire-bootstrap-timer";
globalThis.setTimeout = new Proxy(globalThis.setTimeout, {
  apply(schedule, receiver, args: Parameters<typeof setTimeout>) {
    const [callback, delay, ...callbackArgs] = args;
    const timer = Reflect.apply(schedule, receiver, args) as ReturnType<typeof setTimeout>;
    process.send?.({ testBootstrapDelayMs: delay ?? null } satisfies TestBootstrapClockReport);
    process.once("message", message => {
      if (message !== expireTimerMessage) throw new Error("TEST clock command invalid");
      clearTimeout(timer);
      setImmediate(callback, ...callbackArgs);
    });
    return timer;
  },
});
process.stdin.on("data", (chunk: Buffer) => {
  process.send?.({ testObservedInputBytes: chunk.length } satisfies TestBootstrapClockReport);
});
