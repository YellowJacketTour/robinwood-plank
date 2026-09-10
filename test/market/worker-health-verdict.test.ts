import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";

test("actual worker health route distinguishes historical imbalance, current stalls, failure, and progress", async () => {
  const now=Date.now(); const stamp=(ago:number)=>new Date(now-ago).toISOString();
  const phase: Record<string,unknown>={chain:"bitcoin",phase:"backfill",attempts:"850",completions:"227",failures:"118",
    last_attempt_at:stamp(5000),last_success_at:stamp(1000),last_failure_at:stamp(300000),last_error:"old timeout",last_detail:{tailMoved:true}};
  const code=ts.transpileModule(readFileSync("app/api/market/multichain/worker-health/route.ts","utf8"),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context=vm.createContext({exports:{},require:(name:string)=>name==="next/server" ? {NextResponse:{json:(data:unknown)=>data}} : name.endsWith("postgres") ?
    {postgresQuery:async(sql:string)=>({rows:sql.includes("akasha_worker_heartbeat")?[{worker:"akasha-hose",seconds_since_tick:5}]:[phase]})} :
    {rateLimit:()=>null,publicError:(error:unknown)=>{throw error;}}});
  vm.runInContext(code,context);
  assert.equal((await context.exports.GET({})).verdict,"backfill-advancing");
  phase.last_detail={tailMoved:false};assert.equal((await context.exports.GET({})).verdict,"backfill-runs-but-cannot-advance");
  phase.last_failure_at=stamp(100);assert.equal((await context.exports.GET({})).verdict,"backfill-throws");
  phase.last_attempt_at=stamp(180000);phase.last_success_at=stamp(300000);phase.last_failure_at=stamp(400000);
  assert.equal((await context.exports.GET({})).verdict,"backfill-hangs");
});
