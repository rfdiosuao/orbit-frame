import fs from "node:fs/promises";
import { config } from "../src/config.js";
const base = `http://127.0.0.1:${config.port}`;
const report = { checkedAt: new Date().toISOString(), base };
const status = await (await fetch(base + "/admin/status")).json();
report.upstreamOk = status.upstreamOk;
report.accountCount = status.accountCount;
report.sessionPresent = status.session.present;
const body = JSON.stringify({model:"doubao", messages:[{role:"user",content:"请只回复：连接测试成功"}]});
for (const [name,key] of [["unauthenticated",""],["authenticated",config.localApiKey]]) {
 const response = await fetch(base + "/v1/chat/completions", {
  method:"POST", headers:{"Content-Type":"application/json", ...(key ? {Authorization:`Bearer ${key}`} : {})}, body,
  signal:AbortSignal.timeout(120000)
 });
 const data=await response.json();
 report[name]={status:response.status,errorType:data.error?.type,reply:data.choices?.[0]?.message?.content};
}
console.log(JSON.stringify(report,null,2));
await fs.writeFile(new URL("../data/verification.json",import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
