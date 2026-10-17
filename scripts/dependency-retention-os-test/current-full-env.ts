/** Preserve the existing outer-only refusal marker; never strip it to launch. */
import assert from "node:assert/strict";
import { cleanEnv } from "./common.ts";
export function currentFullEnvironment():Readonly<Record<string,string>> {
  const marker=process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID;
  if(marker===undefined)return cleanEnv;
  assert(/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(marker),"TEST owned managed job identity required");
  return {...cleanEnv,SUBSCRIPTION_RUNTIME_HOST_JOB_ID:marker};
}
