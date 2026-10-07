/** Independent Node resolver contract; public DATA only, no Codex/native launch. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { currentCodexPublicRelativeDestination } from "./compose-current-real-codex.js";
test("official platform alias resolves within the frontend readonly package root", () => {
  const root = mkdtempSync(join(tmpdir(),"TEST-codex-public-layout-"));
  try {
    const frontend = join(root,currentCodexPublicRelativeDestination("codex/bin/codex.js"));
    const metadata = join(root,currentCodexPublicRelativeDestination("codex-linux-x64/package.json"));
    mkdirSync(dirname(frontend),{recursive:true}); mkdirSync(dirname(metadata),{recursive:true});
    // Official alias package metadata has name @openai/codex. Node resolves the
    // alias directory, independently of that metadata name, without executing it.
    writeFileSync(metadata,JSON.stringify({name:"@openai/codex",version:"0.160.1-linux-x64"}));
    const resolved = createRequire(frontend).resolve("@openai/codex-linux-x64/package.json");
    assert.equal(resolved,metadata);
    const within = relative(join(root,"codex"),resolved);
    assert(!within.startsWith("..") && !within.startsWith("/"));
    assert.throws(() => currentCodexPublicRelativeDestination("codex/../auth.json"));
    assert.throws(() => currentCodexPublicRelativeDestination("auth/auth.json"));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
