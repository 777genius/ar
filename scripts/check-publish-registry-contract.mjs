#!/usr/bin/env node
import { verifyRegistryPackageAccess } from "./publish-preflight.mjs";

const result = await verifyRegistryPackageAccess({
  registryUrl: "https://npm.pkg.github.com",
  token: process.env.GITHUB_TOKEN,
});

console.log(JSON.stringify({
  ok: true,
  registryOrigin: result.registryOrigin,
  authenticated: result.authenticated,
  packageName: result.packageName,
  packagePresent: result.packagePresent,
  versionCount: result.versionCount,
}));
