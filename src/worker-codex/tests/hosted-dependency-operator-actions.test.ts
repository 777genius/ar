import { expect, it } from "vitest";
import { HostedDependencyOperatorAction as Action, parseHostedDependencyOperatorRequest as parse } from "../hosted-dependency-operator-actions";
// Red if CLI silently routes an unknown action/recovery alias, accepts extra
// authority fields, or loses exact compare revision/generation/key constraints.
it("keeps all five operator wire actions closed and recovery distinct from remove",()=>{
  expect(parse("dependency-report",[])).toEqual({action:Action.Report});expect(parse("dependency-report",["TEST-own"])).toEqual({action:Action.Report,jobId:"TEST-own"});
  expect(parse("dependency-evict",["TEST-own","12","TEST-generation","a".repeat(64)])).toEqual({action:Action.Evict,jobId:"TEST-own",revision:12,generation:"TEST-generation",installKey:"a".repeat(64)});
  expect(parse("dependency-recover-eviction",["TEST-own"])).toEqual({action:Action.RecoverEviction,jobId:"TEST-own"});
  expect(parse("dependency-remove-committed-trash",["TEST-own","12"]).action).toBe(Action.RemoveCommittedTrash);
  expect(parse("dependency-recover-trash-removal",["TEST-own","12"]).action).toBe(Action.RecoverTrashRemoval);
  for(const action of ["recover","dependency-restore","remove-dependency-trash",Action.Report+"\n"])expect(()=>parse(action,[])).toThrow();
});
it("rejects unknown/extra authority arguments and malformed exact comparison operands",()=>{
  for(const args of [["TEST-own","12","grant"],["TEST-own","12","/caller/path"],["TEST-own","12","unit.service"]])
    expect(()=>parse("dependency-remove-committed-trash",args)).toThrow();
  for(const revision of ["0","-1","01","12\n","9007199254740992"])expect(()=>parse("dependency-recover-trash-removal",["TEST-own",revision])).toThrow();
  for(const args of [[],["TEST-own","12","generation"],["TEST-own","12","generation","a".repeat(64),"grant"],
    ["TEST-own","12","generation\n","a".repeat(64)],["TEST-own","12","generation","a".repeat(64)+"\n"]])expect(()=>parse("dependency-evict",args)).toThrow();
  expect(()=>parse("dependency-recover-eviction",["TEST-own","12"])).toThrow();expect(()=>parse("dependency-report",["TEST-own","extra"])).toThrow();
});
