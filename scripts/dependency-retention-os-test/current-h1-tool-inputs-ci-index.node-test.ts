import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertCiPublicEvidenceBasename, assertCompleteUbuntuIndex, assertUbuntuArchiveSignature, CiUbuntuPocket, joinCompleteUbuntuIndex, parseUbuntuRelease, ubuntuArchive2018Fingerprint } from "./current-h1-tool-inputs-ci-index.ts";
// Expected trust anchor is independently fixed from the task/source contract.
const fp="F6ECB3762474EDA9D21B7022871920D1991BC93C";
const status=`[GNUPG:] GOODSIG 871920D1991BC93C Ubuntu Archive\n[GNUPG:] VALIDSIG ${fp} 2026-10-09 1791504000 0 4 0 1 8 01 ${fp}\n`;
test("only genuine-success status with fixed independent primary fingerprint is admissible data",()=>{
 assert.equal(ubuntuArchive2018Fingerprint,fp);
 assert.doesNotThrow(()=>assertUbuntuArchiveSignature(status));
 for(const bad of [status.replace(fp,"0".repeat(40)),status.replace(/F6ECB3762474EDA9D21B7022871920D1991BC93C\n$/,"0".repeat(40)+"\n"),status+"[GNUPG:] BADSIG unknown\n",status+status,"[GNUPG:] GOODSIG anything\n",status.replace(" 1 8 01 "," 1 2 01 ")])assert.throws(()=>assertUbuntuArchiveSignature(bad),/refused/);
});
const bytes=Buffer.from("Package: TEST\n\n"),sha=createHash("sha256").update(bytes).digest("hex"),row={path:"main/binary-amd64/Packages",sha256:sha,size:bytes.length};
const release=`Origin: Ubuntu\nLabel: Ubuntu\nSuite: noble-security\nCodename: noble\nDate: Fri, 09 Oct 2026 00:00:00 UTC\nValid-Until: Sat, 10 Oct 2026 00:00:00 UTC\nSHA256:\n ${sha} ${bytes.length} main/binary-amd64/Packages\n ${sha} ${bytes.length} universe/binary-amd64/Packages\n`;
test("complete uncompressed index must join the exact authenticated pocket row, EOF and hash",()=>{
 // Exact retained signed noble.Release row from failed ARC artifact11614866649.
 const icon=" 650ebdd9cef3bfb3af47d512d1a96a788d2cf636b94c19c6b2870d203931de4d            59904 main/dep11/icons-128x128@2.tar\n";
 const withIcon=release+icon;
 assert.doesNotThrow(()=>parseUbuntuRelease(withIcon,CiUbuntuPocket.Security,Date.parse("2026-10-09T01:00:00Z")));
 assert.deepEqual(parseUbuntuRelease(withIcon,CiUbuntuPocket.Security,Date.parse("2026-10-09T01:00:00Z")).get("main/binary-amd64/Packages"),row);
 for(const value of [withIcon+icon,release+icon.replace("main/dep11/","main/../"),release+icon.replace("main/dep11/","/main/dep11/"),release+icon.replace("@2","@2\\outside")])assert.throws(()=>parseUbuntuRelease(value,CiUbuntuPocket.Security,Date.parse("2026-10-09T01:00:00Z")),/refused/);
 const rows=parseUbuntuRelease(release,CiUbuntuPocket.Security,Date.parse("2026-10-09T01:00:00Z"));assert.deepEqual(rows.get(row.path),row);assert.doesNotThrow(()=>assertCompleteUbuntuIndex(bytes,row));
 for(const b of [bytes.subarray(1),Buffer.concat([bytes,Buffer.from("x")]),Buffer.from(bytes.toString().replace("TEST","FAKE"))])assert.throws(()=>assertCompleteUbuntuIndex(b,row),/refused/);
 for(const text of [release.replace("noble-security","noble-updates"),release.replace("Origin: Ubuntu","Origin: Mirror"),release.replace("10 Oct","08 Oct"),release+` ${sha} ${bytes.length} main/binary-amd64/Packages\n`,release.replace("main/binary-amd64/Packages","../Packages")])assert.throws(()=>parseUbuntuRelease(text,CiUbuntuPocket.Security,Date.parse("2026-10-09T01:00:00Z")),/refused/);
});
test("same package version architecture hash and size must occur in one complete original index stanza",()=>{
 const fields="Package: libffi8\nVersion: 3.4.6-TEST\nArchitecture: amd64\n",archive={sha256:"a".repeat(64),size:42};
 const stanza=fields+`Filename: pool/main/libf/libffi/libffi8_TEST_amd64.deb\nSHA256: ${archive.sha256}\nSize: 42\n`;
 assert.equal(joinCompleteUbuntuIndex(fields,Buffer.from("Package: other\nVersion: other\n\n"+stanza),archive)?.sha256,archive.sha256);
 assert.equal(joinCompleteUbuntuIndex(fields,Buffer.from(stanza.replace("3.4.6-TEST","3.4.7-TEST")),archive),undefined);
 for(const index of [stanza.replace("Size: 42","Size: 43"),stanza.replace(`SHA256: ${archive.sha256}\n`,"")+"\n"+stanza.replace("Size: 42\n",""),stanza+"\n"+stanza.replace(archive.sha256,"b".repeat(64))])assert.throws(()=>joinCompleteUbuntuIndex(fields,Buffer.from(index),archive),/Held|refused/);
});
test("public evidence accepts exact Debian epoch and tilde basenames while refusing every path escape",()=>{
 for(const name of ["noble-security.Release","libapt-pkg6.0t64_2.8.3_amd64.deb","libgcc-s1_14.2.0-4ubuntu2~24.04_amd64.deb","libc6_2%3a2.39-0ubuntu8.9_amd64.deb","libc6_2:2.39-0ubuntu8.9_amd64.deb"])assert.doesNotThrow(()=>assertCiPublicEvidenceBasename(name));
 for(const name of ["",".","..","/tmp/public.deb","../public.deb","x/y.deb","x\\y.deb","x\n.deb","x\0.deb","x".repeat(256)])assert.throws(()=>assertCiPublicEvidenceBasename(name),/refused/);
});
