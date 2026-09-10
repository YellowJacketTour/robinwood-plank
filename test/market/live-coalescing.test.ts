import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import * as protocol from "../../lib/market/multichain/edge/change-protocol";

test("actual websocket hook retains scopes across bursts and resnapshots on overflow", async () => {
  let socket: { onmessage?: (event: {data:string}) => void };
  const cleanup: Array<() => void> = [];
  const changes: protocol.MarketChange[] = [];
  const context = vm.createContext({ exports: {}, setTimeout, clearTimeout, URLSearchParams,
    location:{ protocol:"https:", host:"fixture.invalid" }, document:{hidden:false, addEventListener(){}, removeEventListener(){}},
    WebSocket: class { constructor(){Object.assign(context, { latestSocket: this });} close(){} },
    require: (name:string) => name==="react" ? {useRef:(current:unknown)=>({current}),useEffect:(fn:()=>undefined|(()=>void))=>{const stop=fn();if(stop)cleanup.push(stop);}} : protocol,
  });
  const source=readFileSync("hooks/useMarketRealtime.ts","utf8");
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInContext(code,context);
  context.exports.useMarketRealtime([], (change:protocol.MarketChange)=>{changes.push(change);}, 1);
  socket = context.latestSocket;
  const send=(start:number,count:number)=>socket!.onmessage!({data:JSON.stringify({type:"invalidate",family:"tokens",changedRows:count,omittedScopes:0,
    scopes:Array.from({length:count},(_,i)=>({chainSlug:"bitcoin-mainnet",collectionKey:`c${start+i}`}))})});
  try {
    send(0,1);send(1,1);await new Promise(r=>setTimeout(r,15));
    assert.equal(changes[0].scopes.length,2);assert.equal(changes[0].changedRows,2);
    send(0,40);send(40,40);await new Promise(r=>setTimeout(r,15));
    assert.equal(changes[1].type,"resync");assert.equal(changes[1].omittedScopes,80);assert.equal(changes[1].scopes.length,0);
  } finally { for(const stop of cleanup)stop(); }
});
