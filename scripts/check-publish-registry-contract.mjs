#!/usr/bin/env node
import { verifyRegistryAuthentication } from "./publish-preflight.mjs";

const result = await verifyRegistryAuthentication({
  registryUrl: "https://npm.pkg.github.com",
  token: process.env.GITHUB_TOKEN,
});

console.log(JSON.stringify({
  ok: true,
  registryOrigin: result.registryOrigin,
  authenticated: result.authenticated,
}));
