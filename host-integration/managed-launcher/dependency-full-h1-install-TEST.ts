/** Fixed original H1 publication only. No request or native qualification is issued here. */
import {publishFullH1TestUnqualifiedData} from "./dependency-full-native-TEST.js";
const publication=await publishFullH1TestUnqualifiedData();
process.stdout.write(JSON.stringify(publication)+"\n");
