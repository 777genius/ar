import { describe, expect, it } from "vitest";
import { HostedDependencyRootGitRecipe, parseHostedDependencyRootGitProfile } from "../hosted-dependency-root-git-profile";

// These are parser data, never an actual profile issuer or a positive purpose.
const pin = (path: string) => ({path,sha256:"a".repeat(64),dev:"0",ino:"1",mountId:"1",uid:0,gid:0,mode:0o755,size:"1"});
const profile = () => ({version:1,recipe:HostedDependencyRootGitRecipe.RootGitReadV1,executable:pin("/usr/bin/git"),
  libraries:[pin("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"),pin("/usr/lib/x86_64-linux-gnu/libc.so.6")]});
describe("closed root Git profile data contract", () => {
  it("detaches closed factual data without authorizing execution", () => {
    const input = profile(), parsed = parseHostedDependencyRootGitProfile(input);
    input.executable.path = "/usr/bin/sh";
    expect(parsed.executable.path).toBe("/usr/bin/git");
    expect(Object.isFrozen(parsed.libraries)).toBe(true);
    expect(Object.isFrozen(parsed.executable)).toBe(true);
  });
  it("rejects alternate executors, extra fields and incomplete independent ELF closure", () => {
    const input = profile();
    for (const value of [{...input,executable:pin("/usr/bin/node")},{...input,version:2},
      {...input,callback:true},{...input,executable:{...input.executable,kind:"file"}},
      {...input,libraries:[input.libraries[0]]},{...input,libraries:[input.libraries[1]]},
      {...input,libraries:[...input.libraries,input.libraries[1]]},
      {...input,libraries:[...input.libraries].reverse()},
      {...input,libraries:[pin("/usr/lib/../tmp/ld-linux-x86-64.so.2"),input.libraries[1]]}]) {
      expect(() => parseHostedDependencyRootGitProfile(value)).toThrow("dependency_root_git_profile_unsupported");
    }
  });
  it.each([{uid:65532},{gid:65532},{mode:0o777},{mode:0o4755},{mode:0o2755},{mode:0o644},
    {mode:0.5},{dev:"01"},{ino:"0"},{mountId:"0"},{size:"0"},{size:String(32*1024*1024+1)},
    {sha256:"b".repeat(63)}])("rejects unsafe executable pin %j", changed => {
    const input = profile();
    expect(() => parseHostedDependencyRootGitProfile({...input,executable:{...input.executable,...changed}}))
      .toThrow("dependency_root_git_profile_unsupported");
  });
  it("rejects accessors and proxies before invoking caller behavior", () => {
    let calls = 0; const accessor = profile();
    Object.defineProperty(accessor.executable,"path",{enumerable:true,get(){calls++; return calls % 2 ? "/usr/bin/git" : "/usr/bin/sh";}});
    expect(() => parseHostedDependencyRootGitProfile(accessor)).toThrow("dependency_root_git_profile_unsupported");
    const top = profile(); Object.defineProperty(top,"libraries",{enumerable:true,get(){calls++; return [];}});
    expect(() => parseHostedDependencyRootGitProfile(top)).toThrow("dependency_root_git_profile_unsupported");
    const array = profile(); Object.defineProperty(array.libraries,"0",{enumerable:true,get(){calls++; return pin("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");}});
    expect(() => parseHostedDependencyRootGitProfile(array)).toThrow("dependency_root_git_profile_unsupported");
    expect(() => parseHostedDependencyRootGitProfile(new Proxy(profile(),{ownKeys(){calls++; return [];}})))
      .toThrow("dependency_root_git_profile_unsupported");
    expect(calls).toBe(0);
    expect(() => parseHostedDependencyRootGitProfile(Object.assign(Object.create({authority:true}),profile())))
      .toThrow("dependency_root_git_profile_unsupported");
  });
  it("enforces independent total bytes and maximum library count", () => {
    const input = profile(), libraries = [...input.libraries,
      ...Array.from({length:7},(_,i) => pin(`/usr/lib/x86_64-linux-gnu/libz${i}.so.1`))];
    expect(() => parseHostedDependencyRootGitProfile({...input,libraries:libraries.map(p => ({...p,size:String(32*1024*1024)}))}))
      .toThrow("dependency_root_git_profile_unsupported");
    expect(() => parseHostedDependencyRootGitProfile({...input,libraries:[...input.libraries,
      ...Array.from({length:31},(_,i) => pin(`/usr/lib/x86_64-linux-gnu/libz${String(i).padStart(2,"0")}.so.1`))]}))
      .toThrow("dependency_root_git_profile_unsupported");
  });
});
