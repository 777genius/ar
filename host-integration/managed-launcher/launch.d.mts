/** Type-only view of the fixed command owned by the original launcher. */
export const managedSystemdRunExecutable: string;
export function parseNativeUnitProperties(text: string, properties: readonly string[]): Record<string, string>;

export const ManagedLauncherProfile: Readonly<{Standard: "standard"; FixedFullPositiveTest: "fixed_full_positive_test"}>;
export const fullPositiveTestJob: string;
export const fullPositiveTestEntry: string;
export function runManagedLauncherMain(): Promise<void>;

export function managedLauncherInvocation(request: unknown, profile?: "standard"|"fixed_full_positive_test"): {command:string;args:string[]};
export function assertManagedLauncherProfile(profile:unknown, jobId:unknown):void;
export const legacyFullTestJob:string;
export function buildSystemdInvocation(request:unknown):Promise<unknown>;

export const fullPositiveTestRoot:string;
