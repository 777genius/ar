import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {exactH1PackageSeeds,ToolInputArchitecture} from "./current-h1-tool-inputs-package.ts";
import {qualifiedH1PackagePins,qualifiedH1PackageRequestArguments,qualifiedH1PackageVectorSha256} from "./current-h1-qualified-package-image.ts";

test("qualified package lock reproduces the previously measured complete signed image",()=>{
 const measured="76a701735a773c8a1909ea320a711c7b9f521796c383191c985ac67854024187";
 assert.equal(qualifiedH1PackageVectorSha256,measured);
 assert.equal(createHash("sha256").update(JSON.stringify(qualifiedH1PackagePins)).digest("hex"),measured);
 assert.equal(qualifiedH1PackagePins.length,41);
 assert.equal(new Set(qualifiedH1PackagePins.map(p=>p.package)).size,41);
 assert(Object.isFrozen(qualifiedH1PackagePins)&&qualifiedH1PackagePins.every(Object.isFrozen));
});

test("qualified acquisition pins every dependency and retains all five original seeds",()=>{
 assert.equal(qualifiedH1PackageRequestArguments.length,41);
 for(const seed of exactH1PackageSeeds)assert(qualifiedH1PackageRequestArguments.includes(seed));
 for(const [i,pin] of qualifiedH1PackagePins.entries()){
  const argument=qualifiedH1PackageRequestArguments[i];assert(argument);
  assert.equal(argument.split("=")[1],pin.version);
  assert(argument.startsWith(pin.package+(pin.arch===ToolInputArchitecture.All?"=":":amd64=")));
  assert(/^[a-z0-9][a-z0-9+.-]*(?::amd64)?=[A-Za-z0-9.+:~_-]+$/.test(argument));
 }
 assert(qualifiedH1PackageRequestArguments.includes("libsystemd0:amd64=255.4-1ubuntu8.18"));
 assert(qualifiedH1PackageRequestArguments.includes("tzdata=2026e-0ubuntu0.24.04.1"));
});
