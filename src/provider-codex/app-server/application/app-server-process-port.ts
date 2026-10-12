/** Materialized original-provider paths. Only the installed baseline adapter
 * may turn these three roles into a managed storage request. */
export type OriginalProviderStorageContext = {
  readonly workspace: string;
  readonly home: string;
  readonly codexHome: string;
  readonly agentTemp?: string;
};

export type CodexAppServerProcessFactory = ((input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly storageContext?: OriginalProviderStorageContext;
}) => CodexAppServerChildProcess) & {
  /** Describes input support only; installed physical admission remains required. */
  readonly originalProviderStorageContext?: true;
};

export type CodexAppServerChildProcess = {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type CodexAppServerChildProcessSignaler = (
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
) => void;
