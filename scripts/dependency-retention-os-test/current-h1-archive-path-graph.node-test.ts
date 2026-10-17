import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FixedGnuMemberKind as K, FixedGnuMemberProfile, type FixedGnuArchiveMembers, type FixedGnuMemberRow } from "./current-h1-archive-members-TEST.ts";
import { ToolInputArchitecture, type AcquiredSignedPackage } from "./current-h1-tool-inputs-package.ts";
import { ciIndexOperationalBytes } from "./current-h1-tool-inputs-ci-index.ts";
import { assertFixedH1GraphRecordBytes, FixedH1AliasState, FixedH1Disposition, preflightFixedH1ArchiveRole, serializeFixedH1ArchiveRole } from "./current-h1-archive-path-graph-TEST.ts";
const vector = "d89a9c1fd845ec3123839f3d223e24d3a1a1c02ce36c3bb36637d6902a839d5b", source = "6dd8c978dd0b8a9beb02929c286a4fb6cfb57a6b";
const hash = (s: string) => createHash("sha256").update(s).digest("hex"), b64 = (s: string) => Buffer.from(s).toString("base64");
// Exact retained package commitments. All rows below are synthetic DATA only.
const packages: readonly AcquiredSignedPackage[] = Object.freeze([
    Object.freeze({ "package": "debconf", "version": "1.5.86ubuntu1", "arch": ToolInputArchitecture.All, "sha256": "bb390da466a7461bfc87aa3e6b7cd145dae84af3e26bf437f2c0c218ba226294", "size": 124096, "filename": "pool/main/d/debconf/debconf_1.5.86ubuntu1_all.deb" }),
    Object.freeze({ "package": "gcc-14-base", "version": "14.2.0-4ubuntu2~24.04.1", "arch": ToolInputArchitecture.Amd64, "sha256": "b95c172411a7fdae70307cf33a9f5320ba5e056b556454543dd5b679d5ce1c4f", "size": 51014, "filename": "pool/main/g/gcc-14/gcc-14-base_14.2.0-4ubuntu2~24.04.1_amd64.deb" }),
    Object.freeze({ "package": "libaudit-common", "version": "1:3.1.2-2.1ubuntu0.1", "arch": ToolInputArchitecture.All, "sha256": "b1b6fca3f7ed86db971c073352a6741f1f60f4a94eeb2c1eb0aca8a7e4b11660", "size": 5948, "filename": "pool/main/a/audit/libaudit-common_3.1.2-2.1ubuntu0.1_all.deb" }),
    Object.freeze({ "package": "libaudit1", "version": "1:3.1.2-2.1ubuntu0.1", "arch": ToolInputArchitecture.Amd64, "sha256": "326a55fce45a620f12b98baf581fb037eb0fcea1ab3969c54cf177f51be8abfe", "size": 47082, "filename": "pool/main/a/audit/libaudit1_3.1.2-2.1ubuntu0.1_amd64.deb" }),
    Object.freeze({ "package": "libblkid1", "version": "2.39.3-9ubuntu6.6", "arch": ToolInputArchitecture.Amd64, "sha256": "3bcf169cd65e2539059b2287924090fc629f9bf90f595fc25465a7efe950ee82", "size": 124124, "filename": "pool/main/u/util-linux/libblkid1_2.39.3-9ubuntu6.6_amd64.deb" }),
    Object.freeze({ "package": "libbz2-1.0", "version": "1.0.8-5.1ubuntu0.1", "arch": ToolInputArchitecture.Amd64, "sha256": "36ee08b00b1ee5018b2fce02881b7d2d73c9b4e32990bde3388400d86c48126a", "size": 34562, "filename": "pool/main/b/bzip2/libbz2-1.0_1.0.8-5.1ubuntu0.1_amd64.deb" }),
    Object.freeze({ "package": "libc6", "version": "2.39-0ubuntu8.9", "arch": ToolInputArchitecture.Amd64, "sha256": "ff5557d99b51f761c4b7c92368b9cc45565eda17df9bf9eb4b134d09825008be", "size": 3264314, "filename": "pool/main/g/glibc/libc6_2.39-0ubuntu8.9_amd64.deb" }),
    Object.freeze({ "package": "libcap-ng0", "version": "0.8.4-2build2", "arch": ToolInputArchitecture.Amd64, "sha256": "cf1e9437ac7ddf6539dbe87b68858cbdef84d78c6aac243ab3b6e564a52ed930", "size": 15180, "filename": "pool/main/libc/libcap-ng/libcap-ng0_0.8.4-2build2_amd64.deb" }),
    Object.freeze({ "package": "libcap2", "version": "1:2.66-5ubuntu2.4", "arch": ToolInputArchitecture.Amd64, "sha256": "23c627c77c66552a658e62852f244f4946dc543898e0ec5428d5dc6bffde2d6a", "size": 30500, "filename": "pool/main/libc/libcap2/libcap2_2.66-5ubuntu2.4_amd64.deb" }),
    Object.freeze({ "package": "libcrypt1", "version": "1:4.4.36-4build1", "arch": ToolInputArchitecture.Amd64, "sha256": "9474785cd6f398512bf8c305c3901dbb111569dccb6f5832002373c0a8ac5832", "size": 82302, "filename": "pool/main/libx/libxcrypt/libcrypt1_4.4.36-4build1_amd64.deb" }),
    Object.freeze({ "package": "libdb5.3t64", "version": "5.3.28+dfsg2-7", "arch": ToolInputArchitecture.Amd64, "sha256": "a78a25c8fad8fdd0b7bc6b297da5d5685579be1e57732aa47870830e4a13161e", "size": 734100, "filename": "pool/main/d/db5.3/libdb5.3t64_5.3.28+dfsg2-7_amd64.deb" }),
    Object.freeze({ "package": "libexpat1", "version": "2.6.1-2ubuntu0.6", "arch": ToolInputArchitecture.Amd64, "sha256": "494b8e672f722130c6bca6a7bc4cc31a43ca891a31d60d868bfdd699a3c20b13", "size": 98940, "filename": "pool/main/e/expat/libexpat1_2.6.1-2ubuntu0.6_amd64.deb" }),
    Object.freeze({ "package": "libffi8", "version": "3.4.6-1build1", "arch": ToolInputArchitecture.Amd64, "sha256": "637e6a7744de08cd331a41f4efd0d24e6ea9064843dea9d1c6ca87bdb5f038a2", "size": 24718, "filename": "pool/main/libf/libffi/libffi8_3.4.6-1build1_amd64.deb" }),
    Object.freeze({ "package": "libgcc-s1", "version": "14.2.0-4ubuntu2~24.04.1", "arch": ToolInputArchitecture.Amd64, "sha256": "aa7fadbe33b78bcf99885318040601c550c208929565b179891d9a3cc2aa68cd", "size": 78392, "filename": "pool/main/g/gcc-14/libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb" }),
    Object.freeze({ "package": "libgcrypt20", "version": "1.10.3-2ubuntu0.2", "arch": ToolInputArchitecture.Amd64, "sha256": "957b9eeaa83cf6f2d5d5d76dbb8aa31d3297e6781d8a02fa08dcc897ae650a0b", "size": 536494, "filename": "pool/main/libg/libgcrypt20/libgcrypt20_1.10.3-2ubuntu0.2_amd64.deb" }),
    Object.freeze({ "package": "libgpg-error0", "version": "1.47-3build2.1", "arch": ToolInputArchitecture.Amd64, "sha256": "93654ee8180a73a0363f25c51dc673d67cbabcbecd164187b8a2deb54d007aef", "size": 70092, "filename": "pool/main/libg/libgpg-error/libgpg-error0_1.47-3build2.1_amd64.deb" }),
    Object.freeze({ "package": "liblz4-1", "version": "1.9.4-1build1.1", "arch": ToolInputArchitecture.Amd64, "sha256": "319331270d5cc52d5ebffe51c941d7b01b432bc402c2924b557209a64d4ecbad", "size": 63062, "filename": "pool/main/l/lz4/liblz4-1_1.9.4-1build1.1_amd64.deb" }),
    Object.freeze({ "package": "liblzma5", "version": "5.6.1+really5.4.5-1ubuntu0.3", "arch": ToolInputArchitecture.Amd64, "sha256": "d2eabd41ca77d2c2dd9d5d4ef478cccb64ffde6279c47cf4699a857d46785a52", "size": 127352, "filename": "pool/main/x/xz-utils/liblzma5_5.6.1+really5.4.5-1ubuntu0.3_amd64.deb" }),
    Object.freeze({ "package": "libmount1", "version": "2.39.3-9ubuntu6.6", "arch": ToolInputArchitecture.Amd64, "sha256": "8f2c25589f187dacfdc5bb6be2af0aee6c2ba7b4d2edd1ca4b26753469f07aae", "size": 134082, "filename": "pool/main/u/util-linux/libmount1_2.39.3-9ubuntu6.6_amd64.deb" }),
    Object.freeze({ "package": "libncursesw6", "version": "6.4+20240113-1ubuntu2.2", "arch": ToolInputArchitecture.Amd64, "sha256": "579c9488755d1ddd70f66480cafd2f68776f68314d15d9cf4b5449d0de0fc968", "size": 147816, "filename": "pool/main/n/ncurses/libncursesw6_6.4+20240113-1ubuntu2.2_amd64.deb" }),
    Object.freeze({ "package": "libpam0g", "version": "1.5.3-5ubuntu5.7", "arch": ToolInputArchitecture.Amd64, "sha256": "1d7f54e77f0455ab5e607cd5e78b576801d8efdc66115e02cf3c6e708d093667", "size": 68124, "filename": "pool/main/p/pam/libpam0g_1.5.3-5ubuntu5.7_amd64.deb" }),
    Object.freeze({ "package": "libpcre2-8-0", "version": "10.42-4ubuntu2.1", "arch": ToolInputArchitecture.Amd64, "sha256": "110a797a57673d3ee497a141cf988199258058c57525799c63194d81822529a0", "size": 226662, "filename": "pool/main/p/pcre2/libpcre2-8-0_10.42-4ubuntu2.1_amd64.deb" }),
    Object.freeze({ "package": "libpython3.12-minimal", "version": "3.12.3-1ubuntu0.17", "arch": ToolInputArchitecture.Amd64, "sha256": "d646ad7112b5adec21ba0e1af015f04ae8ca7f5efdc619622547dd6673c4c14b", "size": 838536, "filename": "pool/main/p/python3.12/libpython3.12-minimal_3.12.3-1ubuntu0.17_amd64.deb" }),
    Object.freeze({ "package": "libpython3.12-stdlib", "version": "3.12.3-1ubuntu0.17", "arch": ToolInputArchitecture.Amd64, "sha256": "45d3f530ba1f9d6e879ad46b92046fabab13fe50a82450e4f65557a3bbad1489", "size": 2070530, "filename": "pool/main/p/python3.12/libpython3.12-stdlib_3.12.3-1ubuntu0.17_amd64.deb" }),
    Object.freeze({ "package": "libreadline8t64", "version": "8.2-4build1", "arch": ToolInputArchitecture.Amd64, "sha256": "563977a16df03b611f5239cc1e9a0426e86479fcc616b5c9e200ea32063119e5", "size": 152856, "filename": "pool/main/r/readline/libreadline8t64_8.2-4build1_amd64.deb" }),
    Object.freeze({ "package": "libselinux1", "version": "3.5-2ubuntu2.1", "arch": ToolInputArchitecture.Amd64, "sha256": "6abaa6c26f46ef17764c4a753e0e84de1cdadde5634fd2987621fdc617988d19", "size": 79660, "filename": "pool/main/libs/libselinux/libselinux1_3.5-2ubuntu2.1_amd64.deb" }),
    Object.freeze({ "package": "libsmartcols1", "version": "2.39.3-9ubuntu6.6", "arch": ToolInputArchitecture.Amd64, "sha256": "84f33a780d27cce20a2cd925e7ce8498daba2dbc614d433548a19fbb2c5dac18", "size": 66282, "filename": "pool/main/u/util-linux/libsmartcols1_2.39.3-9ubuntu6.6_amd64.deb" }),
    Object.freeze({ "package": "libsqlite3-0", "version": "3.45.1-1ubuntu2.8", "arch": ToolInputArchitecture.Amd64, "sha256": "b1190bb72359f5fcc47406aa46065eaf4f1ca208085c51224a52b04bedc0b4bb", "size": 701602, "filename": "pool/main/s/sqlite3/libsqlite3-0_3.45.1-1ubuntu2.8_amd64.deb" }),
    Object.freeze({ "package": "libssl3t64", "version": "3.0.13-0ubuntu3.16", "arch": ToolInputArchitecture.Amd64, "sha256": "219f43b1cd836a4da550938db5fda93160d269d39a4edcf1f1ce698a470db797", "size": 1945300, "filename": "pool/main/o/openssl/libssl3t64_3.0.13-0ubuntu3.16_amd64.deb" }),
    Object.freeze({ "package": "libsystemd0", "version": "255.4-1ubuntu8.17", "arch": ToolInputArchitecture.Amd64, "sha256": "4776d2ac7e21efe2ae31f3f7955a7ccd97277225eecf36910a26faf4544979ae", "size": 431784, "filename": "pool/main/s/systemd/libsystemd0_255.4-1ubuntu8.17_amd64.deb" }),
    Object.freeze({ "package": "libtinfo6", "version": "6.4+20240113-1ubuntu2.2", "arch": ToolInputArchitecture.Amd64, "sha256": "b67a6df2bdab61d273eabebd208bb6a3fb12618a390a067e1ee305a409ff03d9", "size": 108086, "filename": "pool/main/n/ncurses/libtinfo6_6.4+20240113-1ubuntu2.2_amd64.deb" }),
    Object.freeze({ "package": "libudev1", "version": "255.4-1ubuntu8.17", "arch": ToolInputArchitecture.Amd64, "sha256": "6efea3770f738db2fd43ebdaed3d91ef0cde8aa8387b4803080af473326ebdb0", "size": 177608, "filename": "pool/main/s/systemd/libudev1_255.4-1ubuntu8.17_amd64.deb" }),
    Object.freeze({ "package": "libuuid1", "version": "2.39.3-9ubuntu6.6", "arch": ToolInputArchitecture.Amd64, "sha256": "7e2992d3a79fc05514dc5966558ee9c66a7214a47edf2a36017b9e2777528665", "size": 36596, "filename": "pool/main/u/util-linux/libuuid1_2.39.3-9ubuntu6.6_amd64.deb" }),
    Object.freeze({ "package": "libzstd1", "version": "1.5.5+dfsg2-2build1.1", "arch": ToolInputArchitecture.Amd64, "sha256": "dfcf25061e07aad7efd3f4f880ba5ad4d4d09ebe7fc8cc77ab6b8a161d6d4727", "size": 299472, "filename": "pool/main/libz/libzstd/libzstd1_1.5.5+dfsg2-2build1.1_amd64.deb" }),
    Object.freeze({ "package": "media-types", "version": "10.1.0", "arch": ToolInputArchitecture.All, "sha256": "31bfb7eec55ab6d34a50ba995150e1498d4cb897714085d8025e330d3b529747", "size": 27474, "filename": "pool/main/m/media-types/media-types_10.1.0_all.deb" }),
    Object.freeze({ "package": "netbase", "version": "6.4", "arch": ToolInputArchitecture.All, "sha256": "8cdbc9c3dca01e660759bf9d840f72e45ac72faf5d19ca1faecacaf6a60c1a87", "size": 13112, "filename": "pool/main/n/netbase/netbase_6.4_all.deb" }),
    Object.freeze({ "package": "python3.12-minimal", "version": "3.12.3-1ubuntu0.17", "arch": ToolInputArchitecture.Amd64, "sha256": "d452689b9660845345a4c3e05e4ad82c082d5474e04031b7aa47f1a6d5610a6e", "size": 2334634, "filename": "pool/main/p/python3.12/python3.12-minimal_3.12.3-1ubuntu0.17_amd64.deb" }),
    Object.freeze({ "package": "readline-common", "version": "8.2-4build1", "arch": ToolInputArchitecture.All, "sha256": "879bfd7f8a9bc4c0f7cdc777cdd8bc6de5f8c4a2ac80c060322a1b22f13504bb", "size": 56484, "filename": "pool/main/r/readline/readline-common_8.2-4build1_all.deb" }),
    Object.freeze({ "package": "tzdata", "version": "2026c-0ubuntu0.24.04.1", "arch": ToolInputArchitecture.All, "sha256": "ef12c9ef81905b5ac558504b2f8c20da9be5f28861020b3fb5e8b15fb3fae2f6", "size": 279816, "filename": "pool/main/t/tzdata/tzdata_2026c-0ubuntu0.24.04.1_all.deb" }),
    Object.freeze({ "package": "util-linux", "version": "2.39.3-9ubuntu6.6", "arch": ToolInputArchitecture.Amd64, "sha256": "08eb17ba3b83378ed1e73d8335d0ce03b429c0bbeb07e374f536234edab02465", "size": 1128326, "filename": "pool/main/u/util-linux/util-linux_2.39.3-9ubuntu6.6_amd64.deb" }),
    Object.freeze({ "package": "zlib1g", "version": "1:1.3.dfsg-3.1ubuntu2.2", "arch": ToolInputArchitecture.Amd64, "sha256": "84b9cf5752b29c9f92c27cd4c4ba9bbcc70b5ccf9b1b515421a28ae23212e273", "size": 62988, "filename": "pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2.2_amd64.deb" }),
]);
type Seed = Readonly<{
    name: string;
    kind: K;
    link?: string;
    mtime?: number;
    mode?: number;
    bytes?: number;
    sha256?: string;
}>;
const dir = (name: string, mtime = 0): Seed => ({ name, kind: K.Directory, mtime }), file = (name: string): Seed => ({ name, kind: K.Regular }), alias = (name: string, link: string): Seed => ({ name, kind: K.Symlink, link });
function fixture(extra: readonly Seed[] = [], change?: (name: string, seeds: Seed[]) => void): readonly FixedGnuArchiveMembers[] {
    return Object.freeze(packages.map((p, index) => {
        const rows: FixedGnuMemberRow[] = [];
        let offset = 0;
        const seeds: Seed[] = [dir("./")];
        if (index === 0)
            seeds.push(...["usr", "usr/bin", "usr/lib", "usr/lib/python3.12", "usr/lib/x86_64-linux-gnu", "usr/lib64", "usr/share", "usr/share/zoneinfo", "etc", "etc/python3.12"].map(n => dir("./" + n)), ...extra);
        if (p.package === "python3.12-minimal")
            seeds.push(file("./usr/bin/python3.12"));
        if (p.package === "util-linux")
            seeds.push(file("./usr/bin/nsenter"), { ...file("./usr/bin/su"), mode: 0o4755 });
        if (p.package === "libpython3.12-minimal")
            seeds.push(alias("./usr/lib/python3.12/sitecustomize.py", "/etc/python3.12/sitecustomize.py"), { ...file("./etc/python3.12/sitecustomize.py"), bytes: 155, sha256: "43d81125d92376b1a69d53a71126a041cc9a18d8080e92dea0a2ae23be138b1e" });
        if (p.package === "libc6")
            seeds.push(alias("./usr/lib64/ld-linux-x86-64.so.2", "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"), file("./usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"));
        if (p.package === "tzdata")
            seeds.push(alias("./usr/share/zoneinfo/localtime", "/etc/localtime"));
        change?.(p.package, seeds);
        for (const s of seeds) {
            const size = s.kind === K.Regular ? s.bytes ?? 3 : 0;
            rows.push(Object.freeze({ ordinal: rows.length + 1, headerOffset: offset, headerSha256: hash(p.package + ":" + rows.length + ":" + s.name), kind: s.kind, nameBytesBase64: b64(s.name), linkBytesBase64: b64(s.link ?? ""), mode: s.mode ?? (s.kind === K.Directory ? 0o755 : s.kind === K.Symlink ? 0o777 : 0o644), uid: 0, gid: 0, mtime: s.mtime ?? 0, size, payloadOffset: offset + 512, payloadBytes: size, payloadSha256: s.sha256 ?? hash(size ? "abc" : "") }));
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        return Object.freeze({ schemaVersion: 1, profile: FixedGnuMemberProfile.Basic, package: p, stream: Object.freeze({ sha256: hash(p.package + ":synthetic-stream"), bytes: offset + 1024, archiveSha256: p.sha256, archiveBytes: p.size }), rows: Object.freeze(rows), nativeQualified: false });
    }));
}
const run = (rows: readonly FixedGnuArchiveMembers[]) => preflightFixedH1ArchiveRole(rows, vector, performance.now() + 10000);
test("fixed H1 graph retains repeated directory origins and mtimes with deterministic DATA identity", () => {
    const rows = fixture([], (name, seeds) => {
        if (name === packages[1]?.package)
            seeds.push(dir("usr/", 99));
    });
    const graph = run(rows), usr = graph.nodes.find(n => n.path === "usr");
    assert(usr);
    assert.equal(usr.origins.length, 2);
    assert.deepEqual(usr.origins.map(o => o.row.mtime), [0, 99]);
    assert.equal(graph.roots.length, 41);
    assert(graph.roots.every(o => o.normalization === "root-sentinel"));
    const a = serializeFixedH1ArchiveRole(graph, rows, source, performance.now() + 10000), b = serializeFixedH1ArchiveRole(run(rows), rows, source, performance.now() + 10000);
    assert(a.graph.equals(b.graph));
    assert(a.selection.equals(b.selection));
    assert.equal(a.graphSha256, createHash("sha256").update(a.graph).digest("hex"));
    assert.equal(graph.nativeQualified, false);
    assert.equal(graph.physicalRootCreated, false);
    assert.equal(graph.selectedPlanExecutable, false);
});
test("fixed H1 canonical collisions unsafe parents and directory security drift refuse before writes", () => {
    const baseRows = fixture(), firstArchive = baseRows[0];
    assert(firstArchive);
    const firstRow = firstArchive.rows[0];
    assert(firstRow);
    let calls = 0;
    const forbidden = () => { calls++; return "substituted DATA"; };
    const nonInvokingRefusal = (input: readonly FixedGnuArchiveMembers[]) => {
        calls = 0;
        let refused = false;
        try { run(input); } catch { refused = true; }
        assert.equal(calls, 0, "closed shape must not invoke toJSON/getter/Proxy traps");
        assert.equal(refused, true, "non-data shape must refuse");
    };
    const rowInput = (row: FixedGnuMemberRow) => Object.freeze([
        Object.freeze({ ...firstArchive, rows: Object.freeze([row, ...firstArchive.rows.slice(1)]) }),
        ...baseRows.slice(1)
    ]);
    const hiddenRow = { ...firstRow };
    Object.defineProperty(hiddenRow, "toJSON", { value: forbidden, enumerable: false });
    nonInvokingRefusal(rowInput(Object.freeze(hiddenRow)));
    const symbolicRow = { ...firstRow };
    Object.defineProperty(symbolicRow, Symbol("hidden"), { value: forbidden, enumerable: false });
    nonInvokingRefusal(rowInput(Object.freeze(symbolicRow)));
    const accessorRow = { ...firstRow };
    Object.defineProperty(accessorRow, "mode", { get: forbidden, enumerable: true });
    nonInvokingRefusal(rowInput(Object.freeze(accessorRow)));
    const accessorArchive = { ...firstArchive };
    Object.defineProperty(accessorArchive, "package", { get: forbidden, enumerable: true });
    nonInvokingRefusal(Object.freeze([Object.freeze(accessorArchive), ...baseRows.slice(1)]));
    const hiddenArray = [...baseRows];
    Object.defineProperty(hiddenArray, "toJSON", { value: forbidden, enumerable: false });
    nonInvokingRefusal(Object.freeze(hiddenArray));
    const accessorArray = [...baseRows];
    Object.defineProperty(accessorArray, "0", { get: forbidden, enumerable: true });
    nonInvokingRefusal(Object.freeze(accessorArray));
    const traps = {
        get(target: object, key: string | symbol) { calls++; return Reflect.get(target, key); },
        ownKeys(target: object) { calls++; return Reflect.ownKeys(target); },
        getPrototypeOf(target: object) { calls++; return Reflect.getPrototypeOf(target); },
        getOwnPropertyDescriptor(target: object, key: string | symbol) { calls++; return Reflect.getOwnPropertyDescriptor(target, key); }
    };
    nonInvokingRefusal(new Proxy<readonly FixedGnuArchiveMembers[]>(baseRows, traps));
    nonInvokingRefusal(rowInput(new Proxy<FixedGnuMemberRow>(firstRow, traps)));
    const proxyLeafPackage = Object.freeze({ ...firstArchive.package, package: new Proxy({}, traps) });
    // Runtime closed-shape boundary is tested without changing the typed API.
    const primitiveDescriptorArchive = { ...firstArchive };
    Object.defineProperty(primitiveDescriptorArchive, "package", { value: proxyLeafPackage, enumerable: true });
    nonInvokingRefusal(Object.freeze([Object.freeze(primitiveDescriptorArchive), ...baseRows.slice(1)]));

    const invalid = [file("usr/bin/python3.12"), file("./usr"), file("./usr//x"), file("./usr/./x"), file("./usr/../x"), file("/absolute"), file("././usr/x"), file("./usr/x/"), file("./usr/x\\y"), file("./usr/\u00e9"), file("./missing/x"), alias("./usr/bin/x", "etc/python3.12/sitecustomize.py"), file("./usr/bin/x/y"), { ...dir("./usr"), mode: 0o700 }];
    const own = mkdtempSync(join(tmpdir(), "TEST-H1-graph-refusal-"));
    try {
        for (const row of invalid)
            assert.throws(() => run(fixture([row])));
        assert.deepEqual(readdirSync(own), []);
        const base = fixture(), changed = base.map((a, i) => i !== 0 ? a : Object.freeze({ ...a, rows: Object.freeze(a.rows.map((row, n) => n !== 1 ? row : Object.freeze({ ...row, gid: 1 }))) }));
        assert.throws(() => run(Object.freeze(changed)), /shape/);
    }
    finally {
        rmSync(own, { recursive: true });
    }
});
test("fixed H1 alias graph keeps missing unselected targets and pending site recipe but vetoes unsafe edges", () => {
    const graph = run(fixture());
    assert.equal(graph.aliases.find(a => a.path === "usr/share/zoneinfo/localtime")?.state, FixedH1AliasState.Missing);
    assert.equal(graph.aliases.find(a => a.path === "usr/share/zoneinfo/localtime")?.target, "etc/localtime");
    assert.equal(graph.aliases.find(a => a.path === "usr/lib64/ld-linux-x86-64.so.2")?.target, "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");
    assert.equal(graph.disposition, FixedH1Disposition.AwaitingPhysicalRecipe);
    for (const extras of [[alias("./usr/lib/x", "../../../escape")], [alias("./usr/lib/x", "x")], [alias("./usr/lib/x", "y"), alias("./usr/lib/y", "x")], [alias("./usr/lib/x", "/etc/missing")], [alias("./usr/lib/x", "/etc/python3.12/sitecustomize.py")], [alias("./usr/lib/x", "../bin/su")], [alias("./usr/lib/x", "y/file"), alias("./usr/lib/y", "../bin")]])
        assert.throws(() => run(fixture(extras)));
    assert.throws(() => run(fixture([], (name, seeds) => {
        if (name === "libpython3.12-minimal") {
            const n = seeds.findIndex(s => s.name === "./etc/python3.12/sitecustomize.py");
            seeds.splice(n, 1);
        }
    })), /selected/);
});
test("fixed H1 role selects original nsenter but excludes privileged and absent objects and refuses origin drift", () => {
    const rows = fixture(), graph = run(rows);
    assert(graph.selected.includes("usr/bin/nsenter"));
    assert(graph.selected.includes("usr/bin/python3.12"));
    assert(!graph.selected.includes("usr/bin/su"));
    assert(!graph.selected.includes("usr/share/zoneinfo/localtime"));
    const su = graph.nodes.find(n => n.path === "usr/bin/su");
    assert.equal(su?.origins[0]?.row.mode, 0o4755);
    assert.throws(() => preflightFixedH1ArchiveRole(rows, "0".repeat(64), performance.now() + 10000), /origin/);
    assert.throws(() => run(Object.freeze(rows.slice(1))), /origin/);
    const first = rows[0];
    assert(first);
    for (const change of [Object.freeze({ ...first, package: Object.freeze({ ...first.package, size: first.package.size + 1 }) }), Object.freeze({ ...first, stream: Object.freeze({ ...first.stream, archiveSha256: "0".repeat(64) }) }), Object.freeze({ ...first, rows: Object.freeze(first.rows.map((row, i) => i !== 1 ? row : Object.freeze({ ...row, ordinal: 99 }))) })])
        assert.throws(() => run(Object.freeze([change, ...rows.slice(1)])));
    const changed = Object.freeze([Object.freeze({ ...first, rows: Object.freeze(first.rows.map((row, i) => i !== 1 ? row : Object.freeze({ ...row, mtime: 123 }))) }), ...rows.slice(1)]);
    assert.throws(() => serializeFixedH1ArchiveRole(graph, changed, source, performance.now() + 10000), /origin/);
});
test("fixed H1 complete records enforce operational boundary deadline and owned exclusive publication", () => {
    assert.doesNotThrow(() => assertFixedH1GraphRecordBytes(ciIndexOperationalBytes));
    assert.throws(() => assertFixedH1GraphRecordBytes(ciIndexOperationalBytes + 1), /budget/);
    const rows = fixture(), graph = run(rows);
    assert.throws(() => preflightFixedH1ArchiveRole(rows, vector, performance.now()), /deadline/);
    assert.throws(() => serializeFixedH1ArchiveRole(graph, rows, source, performance.now()), /deadline/);
    const many = fixture(Array.from({ length: 5000 }, (_, i) => file("./usr/lib/f-" + i))), workDeadline = performance.now() + 2;
    assert(performance.now() < workDeadline);
    assert.throws(() => preflightFixedH1ArchiveRole(many, vector, workDeadline), /deadline/);
    const own = mkdtempSync(join(tmpdir(), "TEST-H1-graph-publication-"));
    try {
        assert.throws(() => assertFixedH1GraphRecordBytes(ciIndexOperationalBytes + 1));
        assert.deepEqual(readdirSync(own), []);
        const body = serializeFixedH1ArchiveRole(graph, rows, source, performance.now() + 10000);
        for (const [name, bytes] of [["graph.json", body.graph], ["selection.json", body.selection]] as const) {
            const path = join(own, name);
            writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
            const fd = openSync(path, "r");
            try {
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            const dir = openSync(own, "r");
            try {
                fsyncSync(dir);
            }
            finally {
                closeSync(dir);
            }
            assert(readFileSync(path).equals(bytes));
            assert.throws(() => writeFileSync(path, bytes, { flag: "wx" }), /EEXIST/);
        }
        const selection: unknown = JSON.parse(body.selection.toString());
        assert(selection && typeof selection === "object" && "sourceSha" in selection && selection.sourceSha === source);
        assert.throws(() => serializeFixedH1ArchiveRole(graph, rows, "forged", performance.now() + 10000), /origin/);
    }
    finally {
        rmSync(own, { recursive: true });
    }
});
