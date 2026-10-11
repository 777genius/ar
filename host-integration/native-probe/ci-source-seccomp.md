# Disposable NativeProbe SOURCE TEST seccomp profile

Derived from moby/profiles seccomp/default.json at commit
2ceae35d351c156cb5a8efc0fdc4a08cf94569d8, upstream SHA256
6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6.
Apache-2.0 license retained in ci-source-seccomp.LICENSE.
Source: https://github.com/moby/profiles/blob/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp/default.json
Modified for this repository on 2026-10-09.

Only clone3 changes: remove it from the CAP_SYS_ADMIN group and replace
the no-CAP_SYS_ADMIN ENOSYS rule with ALLOW for argument1 size88, the
clone_args ABI used by actual fixture births and libc threads. All other
upstream rules, default ERRNO policy and capability conditions are preserved.
Seccomp cannot inspect clone_args pointer contents, so this is not a flags
filter or production authority policy. Used only by the owned disposable
CI TEST container with unchanged capabilities, namespaces and no host mounts.
No CAP_SYS_ADMIN, privileged or seccomp-unconfined mode added.

Workflow verifies SHA256 5589a5a9c0c4a09dc755d8d8af511905b513f94e2d15bb0b7d6cdd89b710e087 before supplying
the profile to Docker and retains exact supplied bytes/hash, Docker version
and runner kernel facts. check-inputs includes profile/attribution/license.
The actor's own post-READY TSYNC filter still must deny clone3/open/exec
with EPERM. Genuine actor tests are the executable acceptance gate.
No kernel support or Native qualification is inferred from this JSON.
