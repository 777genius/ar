import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  readonly version?: unknown;
};

export function subscriptionRuntimePackageJsonUrl(
  moduleUrl: string | URL = import.meta.url,
): URL {
  return new URL("../../package.json", moduleUrl);
}

const metadata = createRequire(import.meta.url)(
  fileURLToPath(subscriptionRuntimePackageJsonUrl()),
) as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("subscription_runtime_package_version_invalid");
}

export const subscriptionRuntimePackageVersion = metadata.version;
