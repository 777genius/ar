/** Actual adversarial application ROOT process, not a mocked provenance DTO. */
import assert from "node:assert/strict";
import {
  retainOriginalAdministrativeProducer, submitPublicAdministrativeMaintenance
}
from "./current-administrative-installation.js";
const node="/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node";
process.argv=[node,"/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/registration-guest.js","qualify"];
process.execArgv=["--experimental-strip-types"];
Object.defineProperty(process,"execPath",{
  value:node
}
);
assert.throws(()=>submitPublicAdministrativeMaintenance(Object.freeze({
}
)));
assert.throws(()=>retainOriginalAdministrativeProducer());
process.stdout.write("DENIED_ACTUAL_NATIVE_ORIGIN\n");
