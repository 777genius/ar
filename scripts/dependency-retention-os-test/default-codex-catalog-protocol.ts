/** Finite synthetic JSON-lines data only. No auth IO, account identity,
 * entitlement, current use, home, FDA, owner or credential terminal authority. */
const model = "gpt-6.1-sol" as const;
export type TestCatalogReply = Readonly<{id: number; result:
  {userAgent: string} | {account: {type: "chatgpt"}} |
  {data: readonly {model: typeof model; hidden: false; isDefault: false; supportedReasoningEfforts: readonly []}[]; nextCursor: null}}>
function denied(): never { throw new Error("TEST_catalog_protocol_refused"); }
/** Constructor receives only the canonical preissuance TEST expectation bytes,
 * never a caller account, process, path, origin or permission DTO. */
export function createTestCatalogProtocol(config: Uint8Array) {
  const expected = JSON.stringify({schemaVersion:1,kind:"TEST_synthetic_refresh_protocol",model})+"\n";
  if (!(config instanceof Uint8Array) || config.byteLength > 4096 ||
      !Buffer.from(config).equals(Buffer.from(expected))) denied();
  let step = 0, bytes = 0, refused = false;
  const requests = [
    {id:1,method:"initialize",params:{clientInfo:{name:"subscription-runtime",title:"Subscription runtime",version:"0.0.0"},
      capabilities:{experimentalApi:true,requestAttestation:false}}},
    {method:"initialized",params:{}},
    {id:2,method:"account/read",params:{refreshToken:false}},
    {id:3,method:"model/list",params:{cursor:null,limit:100,includeHidden:true}},
  ] as const;
  return Object.freeze({
    receive(line: string): TestCatalogReply | undefined {
      try {
        if (refused || typeof line !== "string" || step >= requests.length ||
            Buffer.byteLength(line) > 4096 || (bytes += Buffer.byteLength(line)+1) > 16384 ||
            line !== JSON.stringify(requests[step])) denied();
        // Exact bytes reject malformed JSON, duplicate keys, extra methods,
        // wrong IDs/cursors/params and noncanonical input without raw echo.
        step++;
        if (step === 1) return {id:1,result:{userAgent:"TEST-synthetic-catalog"}};
        if (step === 2) return undefined;
        if (step === 3) return {id:2,result:{account:{type:"chatgpt"}}};
        return {id:3,result:{data:[{model,hidden:false,isDefault:false,supportedReasoningEfforts:[]}],nextCursor:null}};
      } catch { refused = true; return denied(); }
    },
    finish(): void { if (refused || step !== 4) { refused = true; denied(); } },
  });
}
