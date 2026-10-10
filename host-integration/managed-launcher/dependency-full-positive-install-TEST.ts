/** Fixed no-argument installer. Emits non-secret request DATA; never submits. */
import { installFullPositiveTestAndComposeRequest } from "./dependency-full-native-TEST.js";
installFullPositiveTestAndComposeRequest().then(request=>process.stdout.write(JSON.stringify(request)+"\n")).catch(()=>{console.error("TEST full Positive installation Held; partial owned state retained");process.exitCode=70;});
